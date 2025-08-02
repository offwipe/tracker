const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const cheerio = require('cheerio');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const db = require('./db');
const PLACEHOLDER_IMAGES = [
  '/images/transparent-square-110.png',
  '/images/empty_trade_slot.png',
  '/images/tradetagany-420.png',
  '/images/tradetagdemand-420.png',
  '/images/tradetagupgrade-420.png',
  '/images/tradetagdowngrade-420.png'
];

// In-memory cache to prevent rapid duplicate posts (reset on restart)
const postedAdIds = new Set();
// Track bot startup time to filter out old ads
const botStartupTime = new Date();
// Track user duplicate ads (user + item combination within 1 hour)
const userDuplicateCache = new Map(); // key: `${username}-${itemId}`, value: timestamp
// Track ad content hashes to prevent duplicate content
const adContentCache = new Map(); // key: `${username}-${itemId}-${adContentHash}`, value: timestamp

// Clean logging function
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}][${level}] ${message}`);
}

// Create a hash of ad content for duplicate detection
function createAdHash(ad) {
    const content = `${ad.username}-${ad.time}-${ad.offerItems.map(i => i.name).join(',')}-${ad.requestItems.map(i => i.name).join(',')}`;
    return crypto.createHash('md5').update(content).digest('hex');
}

function parseAd(ad) {
    // Username and profile
    const userAnchor = ad.find('.ad_creator_name');
    const username = userAnchor.text().trim();
    const profilePath = userAnchor.attr('href');
    const profileUrl = profilePath ? `https://www.rolimons.com${profilePath}` : null;
    // User profile image
    const userImg = ad.find('.ad_creator_pfp').attr('src') || null;
    // Time - try multiple selectors to find the timestamp
    let time = ad.find('.trade-ad-timestamp').text().trim();
    if (!time) {
        time = ad.find('[class*="timestamp"]').text().trim();
    }
    if (!time) {
        time = ad.find('[class*="time"]').text().trim();
    }
    if (!time) {
        time = ad.find('[title*="ago"]').attr('title');
    }
    if (!time) {
        // Look for any element containing "ago" text
        ad.find('*').each((i, el) => {
            const text = el.textContent || el.text || '';
            if (text && /ago$/.test(text) && !time) {
                time = text;
                return false; // break the loop
            }
        });
    }
    
    // Trade details link
    const detailsAnchor = ad.find('.trade_ad_page_link_button');
    const detailsPath = detailsAnchor.attr('href');
    const detailsUrl = detailsPath ? `https://www.rolimons.com${detailsPath}` : null;
    // Send trade link
    const sendTradeAnchor = ad.find('.send_trade_button').filter(function() {
        return !ad.find('.send_trade_button').eq(0).attr('onclick');
    });
    const sendTradeUrl = sendTradeAnchor.attr('href');

    // Offer items
    const offerItems = [];
    ad.find('.ad_side_left .ad_item_img').each((i, el) => {
        const img = ad.find('.ad_side_left .ad_item_img').eq(i);
        const alt = img.attr('alt');
        const src = img.attr('data-src') || img.attr('src');
        const title = img.attr('data-original-title') || '';
        const onclick = img.attr('onclick') || '';
        
        // Less strict image filtering - if it has onclick, it's likely a real item
        // Check data-src for placeholders since that's where the actual image URL is
        const dataSrc = img.attr('data-src');
        const isPlaceholder = dataSrc && PLACEHOLDER_IMAGES.includes(dataSrc);
        const hasValidOnclick = onclick && onclick.includes('item_select_handler');
        
        if (!isPlaceholder && (hasValidOnclick || (src && src.startsWith('https://tr.rbxcdn.com')))) {
            const match = title.match(/^(.*?)<br>Value ([\d,]+)/);
            offerItems.push({
                name: match ? match[1] : alt,
                value: match ? match[2] : '',
                rap: (title.match(/RAP ([\d,]+)/) || [])[1] || '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`
            });
        }
    });
    // Offer value/RAP
    const offerValue = parseInt(ad.find('.ad_side_left .stat_value').first().text().replace(/,/g, '')) || 0;
    const offerRAP = parseInt(ad.find('.ad_side_left .stat_rap').first().text().replace(/,/g, '')) || 0;

    // Request items
    const requestItems = [];
    ad.find('.ad_side_right .ad_item_img').each((i, el) => {
        const img = ad.find('.ad_side_right .ad_item_img').eq(i);
        const alt = img.attr('alt');
        const src = img.attr('data-src') || img.attr('src');
        const title = img.attr('data-original-title') || '';
        const onclick = img.attr('onclick') || '';
        
        // Less strict image filtering - if it has onclick, it's likely a real item
        // Check data-src for placeholders since that's where the actual image URL is
        const dataSrc = img.attr('data-src');
        const isPlaceholder = dataSrc && PLACEHOLDER_IMAGES.includes(dataSrc);
        const hasValidOnclick = onclick && onclick.includes('item_select_handler');
        
        if (hasValidOnclick && !isPlaceholder) {
            const itemId = (onclick.match(/item_select_handler\((\d+),/) || [])[1] || '';
            const valueMatch = title.match(/Value ([\d,]+)/);
            const rapMatch = title.match(/RAP ([\d,]+)/);
            requestItems.push({
                name: title.split('<br>')[0] || alt,
                value: valueMatch ? valueMatch[1] : '',
                rap: rapMatch ? rapMatch[1] : '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`,
                title,
                onclick,
                id: itemId
            });
        }
    });

    let trackedItem = null;
    let trackedItemValue = null;
    let trackedItemRAP = null;
    let valueDiff = null;
    let rapDiff = null;
    
    // Find any tracked item in the request items
    const trackedItemIds = ['10159600649', '1678356850', '1402433072', '583721561', '9910420'];
    for (const trackedItemId of trackedItemIds) {
        trackedItem = requestItems.find(i => i.id === trackedItemId) || requestItems.find(i => i.onclick && i.onclick.includes(trackedItemId));
        if (trackedItem) {
            // Request value/RAP (now only for tracked item)
            trackedItemValue = trackedItem && trackedItem.value ? parseInt(trackedItem.value.replace(/,/g, '')) : null;
            trackedItemRAP = trackedItem && trackedItem.rap ? parseInt(trackedItem.rap.replace(/,/g, '')) : null;
            // Value and RAP difference (offer - request, so positive means good deal)
            valueDiff = (offerValue !== null && trackedItemValue !== null) ? offerValue - trackedItemValue : null;
            rapDiff = (offerRAP !== null && trackedItemRAP !== null) ? offerRAP - trackedItemRAP : null;
            break;
        }
    }

    // Trade ads created (not always available)
    let adsCreated = null;
    const diffText = ad.text();
    const adsCreatedMatch = diffText.match(/Ads Created\s*(\d+)/i);
    if (adsCreatedMatch) adsCreated = adsCreatedMatch[1];

    // User total value (try to parse from left side value)
    let userTotalValue = offerValue || null;

    // Find the tracked item name on the request side
    const trackedItemName = trackedItem ? trackedItem.name : 'Unknown';

    return {
        username,
        profileUrl,
        userImg,
        time,
        detailsUrl,
        sendTradeUrl,
        offerItems,
        offerValue,
        offerRAP,
        requestItems,
        requestValue: trackedItemValue,
        requestRAP: trackedItemRAP,
        valueDiff,
        rapDiff,
        adsCreated,
        userTotalValue,
        trackedItemName
    };
}

async function fetchAllRequestAds() {
    const url = `https://www.rolimons.com/trades`;
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        const ads = [];
        const adElements = $('.mix_item');
        log(`Found ${adElements.length} total ad elements on trades page`);
        
        adElements.each((i, el) => {
            const adElem = $(el);
            const ad = parseAd(adElem);
            if (ad.username && ad.time) {
                const adId = createAdHash(ad);
                ads.push({ ...ad, adId, url, adElemIndex: i });
                log(`Parsed ad ${i}: username=${ad.username}, time=${ad.time}`);
            } else {
                log(`Skipping ad ${i}: missing username or time`);
            }
        });
        
        log(`Returning ${ads.length} valid ads from trades page`);
        return ads;
    } catch (err) {
        log(`Error loading trades page: ${err.message}`, 'ERROR');
        return [];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function getTradeAdScreenshot(adData, itemId) {
    const { username, time, adElemIndex } = adData;
    const url = `https://www.rolimons.com/trades`;
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for ads to load
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        
        // Find the specific ad by index (most reliable method)
        const adSelector = `.mix_item:nth-child(${adElemIndex + 1})`;
        const adElement = await page.$(adSelector);
        
        if (adElement) {
            // Take a direct screenshot of the ad element
            const screenshot = await adElement.screenshot({
                type: 'png',
                encoding: 'binary'
            });
            
            log(`Successfully took screenshot of ad element ${adElemIndex}`);
            return new AttachmentBuilder(screenshot, { name: 'trade_ad.png' });
        }
        
        // Fallback: try to find by username if index method fails
        const usernameSelector = `.mix_item:has(.ad_creator_name:contains("${username}"))`;
        const usernameElement = await page.$(usernameSelector);
        
        if (usernameElement) {
            const screenshot = await usernameElement.screenshot({
                type: 'png',
                encoding: 'binary'
            });
            
            log(`Successfully took screenshot using username fallback for ${username}`);
            return new AttachmentBuilder(screenshot, { name: 'trade_ad.png' });
        }
        
        log(`Could not find ad element for screenshot - username: ${username}, index: ${adElemIndex}`);
        return null;
    } catch (err) {
        log(`Error taking screenshot for item ${itemId}: ${err.message}`, 'ERROR');
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

function parseAdTime(adTimeStr) {
    // Try to parse "x minutes ago", "x seconds ago", or ISO string
    if (!adTimeStr) return null;
    adTimeStr = adTimeStr.trim();
    
    // First, do ultra-strict text-based filtering
    const timeText = adTimeStr.toLowerCase();
    
    // Reject any ads with "hour", "hours", "day", "days" in the timestamp (allow minutes now)
    if (timeText.includes('hour') || timeText.includes('hours') || 
        timeText.includes('day') || timeText.includes('days')) {
        return null;
    }
    
    if (/ago$/.test(adTimeStr)) {
        const now = new Date();
        const secMatch = adTimeStr.match(/(\d+)\s*second/);
        
        // Accept seconds under 60 (1 minute)
        if (secMatch) {
            const seconds = parseInt(secMatch[1]);
            if (seconds > 60) {
                return null;
            }
            return new Date(now.getTime() - seconds * 1000);
        }
        
        // If it ends with "ago" but doesn't match our patterns, reject it
        return null;
    }
    
    // Try to parse as ISO or date string, but be ultra-strict
    const parsed = new Date(adTimeStr);
    if (isNaN(parsed)) {
        return null;
    }
    
    // Reject dates that are too old (more than 60 seconds)
    const now = new Date();
    const sixtySecondsAgo = new Date(now.getTime() - 60 * 1000);
    if (parsed < sixtySecondsAgo) {
        return null;
    }
    
    return parsed;
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            let ads;
            try {
                ads = await fetchAllRequestAds();
            } catch (err) {
                log(`Failed to fetch ads from trades page: ${err.message}`, 'ERROR');
                return;
            }
            if (!ads || ads.length === 0) {
                log(`No ads found on trades page`);
                return;
            }
            
            // Process all ads and find matches for tracked items
            for (const ad of ads) {
                // First check if the ad is fresh enough before processing
                let adTime = parseAdTime(ad.time);
                if (!adTime) {
                    log(`Skipping ad without valid time: "${ad.time}"`);
                    continue;
                }
                
                log(`Processing ad: username=${ad.username}, time="${ad.time}", parsedTime=${adTime}`);
                
                // Check if any tracked item is on the request side
                const trackedItemIds = ['10159600649', '1678356850', '1402433072', '583721561', '9910420'];
                const matchedItemId = trackedItemIds.find(itemId => 
                    ad.requestItems.some(img => String(img.id) === String(itemId))
                );
                
                if (!matchedItemId) {
                    log(`Ad skipped - no tracked items found in request items: ${ad.requestItems.map(i => i.id).join(', ')}`);
                    continue;
                }
                
                // Find the corresponding tracked item row
                const row = tracked.find(r => String(r.item_id) === String(matchedItemId));
                if (!row) {
                    log(`No tracking row found for item ${matchedItemId}`);
                    continue;
                }
                
                const { guild_id, channel_id, user_id, item_id, last_ad_id, tracking_started_at } = row;
                
                // TIME FILTERING - Only accept ads under 60 seconds old (1 minute)
                const currentTime = new Date();
                const sixtySecondsAgo = new Date(currentTime.getTime() - 60 * 1000);
                if (adTime < sixtySecondsAgo) {
                    log(`Skipping ad older than 60 seconds: ${ad.time}`);
                    continue;
                }
                
                // Additional ultra-strict filtering based on raw time text
                if (ad.time) {
                    const timeText = ad.time.toLowerCase();
                    
                    // Skip any ads with "hour", "hours", "day", "days" in the timestamp (allow minutes now)
                    if (timeText.includes('hour') || timeText.includes('hours') || 
                        timeText.includes('day') || timeText.includes('days')) {
                        log(`Skipping ad with old timestamp: ${ad.time}`);
                        continue;
                    }
                    // Only accept ads with seconds <= 60
                    if (timeText.includes('second')) {
                        const secondMatch = timeText.match(/(\d+)\s*second/);
                        if (secondMatch && parseInt(secondMatch[1]) > 60) {
                            log(`Skipping ad with old second timestamp: ${ad.time} (${secondMatch[1]} seconds > 60)`);
                            continue;
                        }
                    }
                }
                
                // Only post ads newer than tracking_started_at
                if (tracking_started_at && adTime) {
                    const startTime = new Date(tracking_started_at);
                    if (adTime < startTime) {
                        log(`Skipping ad older than tracking start: ${ad.time}`);
                        continue;
                    }
                }
                
                // Check for user duplicate ads (same user + item within 1 hour)
                const userDuplicateKey = `${ad.username}-${item_id}`;
                const now = new Date();
                const lastUserAdTime = userDuplicateCache.get(userDuplicateKey);
                if (lastUserAdTime && (now.getTime() - lastUserAdTime.getTime()) < 3600000) { // 1 hour
                    log(`Skipping duplicate ad from user ${ad.username} for item ${item_id} within 1 hour`);
                    continue;
                }
                
                // Check for content hash duplicates (same content within 1 hour)
                const contentHashKey = `${ad.username}-${item_id}-${ad.adId}`;
                const lastContentHashTime = adContentCache.get(contentHashKey);
                if (lastContentHashTime && (now.getTime() - lastContentHashTime.getTime()) < 3600000) { // 1 hour
                    log(`Skipping duplicate content hash from user ${ad.username} for item ${item_id} within 1 hour`);
                    continue;
                }
                
                // Prevent duplicate posts (in-memory and DB)
                if (ad.adId === last_ad_id || postedAdIds.has(ad.adId)) {
                    log(`Skipping duplicate ad ID: ${ad.adId}`);
                    continue;
                }
                
                log(`Posting new ad for item ${item_id} from user ${ad.username}`);
                
                // Update all caches
                userDuplicateCache.set(userDuplicateKey, now);
                adContentCache.set(contentHashKey, now);
                postedAdIds.add(ad.adId);
                
                const channel = await client.channels.fetch(channel_id).catch(() => null);
                if (!channel) continue;

                // Take screenshot of the ad (increased time window to catch more ads)
                let attachment = null;
                try {
                    // Take screenshots for ads under 50 seconds old (increased to match 1-minute limit)
                    const adTime = parseAdTime(ad.time);
                    const currentTime = new Date();
                    const fiftySecondsAgo = new Date(currentTime.getTime() - 50 * 1000);
                    
                    if (adTime && adTime > fiftySecondsAgo) {
                        log(`Taking screenshot for fresh ad (${ad.time})`);
                        attachment = await getTradeAdScreenshot({ 
                            username: ad.username, 
                            time: ad.time, 
                            adElemIndex: ad.adElemIndex 
                        }, item_id);
                        
                        if (attachment) {
                            log(`Successfully captured screenshot for ${ad.username}`);
                        } else {
                            log(`Screenshot failed for ${ad.username} - will try username fallback`);
                        }
                    } else {
                        log(`Skipping screenshot for older ad (${ad.time}) to maintain cycle speed`);
                    }
                } catch (screenshotErr) {
                    log(`Failed to take screenshot: ${screenshotErr.message}`, 'WARN');
                }

                // Determine embed color based on value difference
                let embedColor = 0x2ecc40; // green by default
                if (ad.valueDiff !== null) {
                    embedColor = ad.valueDiff >= 0 ? 0x2ecc40 : 0xe74c3c;
                }

                // Build embed with improved formatting
                const embed = new EmbedBuilder()
                    .setTitle(`Send ${ad.username} a Trade`)
                    .setURL(ad.sendTradeUrl || ad.profileUrl)
                    .setColor(embedColor)
                    .addFields(
                        { name: 'Item', value: ad.trackedItemName || 'Unknown', inline: true },
                        { name: 'Rolimon\'s Profile', value: `[View Profile](${ad.profileUrl})`, inline: true },
                        { name: 'Roblox Trade Link', value: ad.sendTradeUrl ? `[Send Trade](${ad.sendTradeUrl})` : 'N/A', inline: true },
                        { name: 'Trade Ads Created', value: ad.adsCreated || 'N/A', inline: true },
                        { name: 'User Total Value', value: ad.userTotalValue !== null ? ad.userTotalValue.toLocaleString() : 'N/A', inline: true },
                        { name: 'Value Difference', value: ad.valueDiff !== null ? (ad.valueDiff >= 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                        { name: 'RAP Difference', value: ad.rapDiff !== null ? (ad.rapDiff >= 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
                        { name: 'Offered', value: ad.offerItems.map(i => i.name).join(', ') || 'None', inline: false },
                        { name: 'Requested', value: ad.requestItems.map(i => i.name).join(', ') || 'None', inline: false }
                    )
                    .setFooter({ text: '@https://discord.gg/M4wjRvywHH' })
                    .setTimestamp();
                
                // Set user image as thumbnail if available
                if (ad.userImg && ad.userImg.startsWith('http')) {
                    embed.setThumbnail(ad.userImg);
                }
                
                // Set screenshot as embed image if available
                if (attachment) {
                    embed.setImage('attachment://trade_ad.png');
                }

                // Send to channel
                const channelMessage = {
                    content: `<@${user_id}> New trade request ad for item ID ${item_id}.`,
                    embeds: [embed]
                };
                
                if (attachment) {
                    channelMessage.files = [attachment];
                }
                
                await channel.send(channelMessage);

                // Check if user has DM forwarding enabled and send DM
                if (row.forward_to_dms) {
                    try {
                        const user = await client.users.fetch(user_id);
                        if (user) {
                            const dmEmbed = new EmbedBuilder()
                                .setTitle(`DM: New Trade Ad for ${ad.trackedItemName}`)
                                .setDescription(`A new trade ad was found for your tracked item in <#${channel_id}>`)
                                .setColor(embedColor)
                                .addFields(
                                    { name: 'Item', value: ad.trackedItemName || 'Unknown', inline: true },
                                    { name: 'User', value: ad.username, inline: true },
                                    { name: 'Value Difference', value: ad.valueDiff !== null ? (ad.valueDiff >= 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                                    { name: 'RAP Difference', value: ad.rapDiff !== null ? (ad.rapDiff >= 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
                                    { name: 'Channel', value: `<#${channel_id}>`, inline: false }
                                )
                                .setFooter({ text: 'DM Forwarding - @https://discord.gg/M4wjRvywHH' })
                                .setTimestamp();

                            const dmMessage = {
                                content: `DM Forwarding: New trade ad for your tracked item ID **${item_id}**`,
                                embeds: [dmEmbed]
                            };
                            
                            if (attachment) {
                                dmMessage.files = [attachment];
                            }
                            
                            await user.send(dmMessage);
                            log(`DM sent to user ${user_id} for item ${item_id}`);
                        }
                    } catch (dmError) {
                        log(`Could not send DM to user ${user_id}: ${dmError.message}`, 'ERROR');
                        // Don't fail the whole process if DM fails
                    }
                }
                
                await db.query(
                    'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                    [ad.adId, guild_id, channel_id, user_id, item_id]
                );
            }
        } catch (err) {
            log(`Error in ad monitor: ${err.message}`, 'ERROR');
        }
    }, 15000); // 15 seconds - much faster scanning
}

module.exports = monitorAds; 