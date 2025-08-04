const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
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

function parseAd(ad, trackedItemId) {
    // Username and profile
    const userAnchor = ad.find('.ad_creator_name');
    const username = userAnchor.text().trim();
    const profilePath = userAnchor.attr('href');
    const profileUrl = profilePath ? `https://www.rolimons.com${profilePath}` : null;
    
    // User profile image
    const userImg = ad.find('.ad_creator_pfp').attr('src') || null;
    
    // Time
    let time = ad.find('.trade-ad-timestamp').text().trim();
    if (!time) {
        time = ad.find('[class*="timestamp"]').text().trim();
    }
    if (!time) {
        time = ad.find('[class*="time"]').text().trim();
    }
    console.log(`[AdMonitor][DEBUG] Raw time text: "${time}"`);
    
    // Trade details link
    const detailsAnchor = ad.find('.trade_ad_page_link_button');
    const detailsPath = detailsAnchor.attr('href');
    const detailsUrl = detailsPath ? `https://www.rolimons.com${detailsPath}` : null;
    
    // Send trade link
    const sendTradeAnchor = ad.find('.send_trade_button');
    const sendTradePath = sendTradeAnchor.attr('href');
    const sendTradeUrl = sendTradePath ? `https://www.rolimons.com${sendTradePath}` : null;
    
    // Trade ads created
    const adsCreated = ad.find('.trade_ads_created').text().trim() || 'N/A';
    
    // User total value
    const userTotalValueText = ad.find('.user_total_value').text().trim();
    const userTotalValue = userTotalValueText ? parseInt(userTotalValueText.replace(/,/g, '')) : null;
    
    // Value difference
    const valueDiffText = ad.find('.value_difference').text().trim();
    const valueDiff = valueDiffText ? parseInt(valueDiffText.replace(/,/g, '')) : null;
    
    // RAP difference
    const rapDiffText = ad.find('.rap_difference').text().trim();
    const rapDiff = rapDiffText ? parseInt(rapDiffText.replace(/,/g, '')) : null;
    
    // Offered items
    const offeredItems = [];
    ad.find('.offered_items .item_name').each((i, el) => {
        const itemName = ad.find('.offered_items .item_name').eq(i).text().trim();
        if (itemName) {
            offeredItems.push({ name: itemName });
        }
    });
    
    // Requested items
    const requestedItems = [];
    ad.find('.requested_items .item_name').each((i, el) => {
        const itemName = ad.find('.requested_items .item_name').eq(i).text().trim();
        if (itemName) {
            requestedItems.push({ name: itemName });
        }
    });
    
    // Calculate offer and request values
    const offerValue = offeredItems.reduce((sum, item) => sum + (item.value || 0), 0);
    const requestValue = requestedItems.reduce((sum, item) => sum + (item.value || 0), 0);
    
    return {
        username,
        profileUrl,
        userImg,
        time,
        detailsUrl,
        sendTradeUrl,
        adsCreated,
        userTotalValue,
        valueDiff,
        rapDiff,
        offeredItems,
        requestedItems,
        offerValue,
        requestValue
    };
}

function parseAdTime(adTimeStr) {
    if (!adTimeStr) return null;
    adTimeStr = adTimeStr.trim();
    
    // Handle "X seconds ago", "X minutes ago", etc.
    if (adTimeStr.toLowerCase().includes('ago')) {
        const now = new Date();
        const match = adTimeStr.match(/(\d+)\s*(second|minute|hour|day)s?\s*ago/i);
        if (match) {
            const amount = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            
            // Convert to milliseconds
            let milliseconds;
            switch (unit) {
                case 'second':
                    milliseconds = amount * 1000;
                    break;
                case 'minute':
                    milliseconds = amount * 60 * 1000;
                    break;
                case 'hour':
                    milliseconds = amount * 60 * 60 * 1000;
                    break;
                case 'day':
                    milliseconds = amount * 24 * 60 * 60 * 1000;
                    break;
                default:
                    return null;
            }
            
            return new Date(now.getTime() - milliseconds);
        }
    }
    
    // Try to parse as ISO string or other date format
    const parsed = new Date(adTimeStr);
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }
    
    return null;
}

function isAdRecent(adTime, maxAgeMinutes = 30) {
    if (!adTime) return false;
    
    const now = new Date();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    const adAgeMs = now.getTime() - adTime.getTime();
    
    return adAgeMs <= maxAgeMs;
}

function createAdHash(ad) {
    const content = `${ad.username}-${ad.time}-${ad.offeredItems.map(i => i.name).join(',')}-${ad.requestedItems.map(i => i.name).join(',')}`;
    return require('crypto').createHash('md5').update(content).digest('hex');
}

async function fetchAllRequestAds() {
    const url = `https://www.rolimons.com/trades`;
    let browser;
    
    try {
        browser = await puppeteer.launch({
            headless: true,
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
        
        adElements.each((i, el) => {
            const ad = parseAd($(el));
            if (ad.username && ad.time) {
                const adId = createAdHash(ad);
                ads.push({ ...ad, adId });
            }
        });
        
        return ads;
        
    } catch (err) {
        console.error(`[AdMonitor][ERROR] Error fetching ads: ${err.message}`);
        return [];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function monitorAds(client) {
    console.log('[AdMonitor][INFO] Starting ad monitor...');
    
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            
            if (!tracked || tracked.length === 0) {
                console.log('[AdMonitor][WARN] No tracked items found');
                return;
            }
            
            const ads = await fetchAllRequestAds();
            
            if (!ads || ads.length === 0) {
                console.log('[AdMonitor][WARN] No ads found');
                return;
            }
            
            console.log(`[AdMonitor][INFO] Processing ${ads.length} ads`);
            
            for (const ad of ads) {
                const adTime = parseAdTime(ad.time);
                
                if (!adTime || !isAdRecent(adTime, 30)) {
                    continue;
                }
                
                for (const row of tracked) {
                    const { guild_id, channel_id, user_id, item_id, last_ad_id } = row;
                    
                    // Check if this ad contains the tracked item
                    const allItems = [...ad.offeredItems, ...ad.requestedItems];
                    const hasTrackedItem = allItems.some(item => 
                        item.name.toLowerCase().includes(row.item_name.toLowerCase())
                    );
                    
                    if (!hasTrackedItem) continue;
                    
                    // Check for duplicates
                    const userDuplicateKey = `${ad.username}-${item_id}`;
                    const lastUserAdTime = userDuplicateCache.get(userDuplicateKey);
                    const now = new Date();
                    
                    if (lastUserAdTime && (now.getTime() - lastUserAdTime.getTime()) < 3600000) {
                        console.log(`[AdMonitor][WARN] Skipping duplicate from user ${ad.username} for item ${item_id}`);
                        continue;
                    }
                    
                    if (ad.adId === last_ad_id || postedAdIds.has(ad.adId)) {
                        console.log(`[AdMonitor][WARN] Skipping duplicate ad ID: ${ad.adId}`);
                        continue;
                    }
                    
                    // Update caches
                    userDuplicateCache.set(userDuplicateKey, now);
                    postedAdIds.add(ad.adId);
                    
                    // Create embed
                    const embed = new EmbedBuilder()
                        .setTitle(`Send ${ad.username} a Trade`)
                        .setURL(ad.sendTradeUrl || ad.profileUrl)
                        .setColor(0x2ecc40)
                        .addFields(
                            { name: 'Item', value: row.item_name, inline: true },
                            { name: 'Rolimon\'s Profile', value: `[View Profile](${ad.profileUrl})`, inline: true },
                            { name: 'Roblox Trade Link', value: ad.sendTradeUrl ? `[Send Trade](${ad.sendTradeUrl})` : 'N/A', inline: true },
                            { name: 'Trade Ads Created', value: ad.adsCreated, inline: true },
                            { name: 'User Total Value', value: ad.userTotalValue ? ad.userTotalValue.toLocaleString() : 'N/A', inline: true },
                            { name: 'Value Difference', value: ad.valueDiff ? (ad.valueDiff >= 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'RAP Difference', value: ad.rapDiff ? (ad.rapDiff >= 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'Offered', value: ad.offeredItems.map(i => i.name).join(', ') || 'None', inline: false },
                            { name: 'Requested', value: ad.requestedItems.map(i => i.name).join(', ') || 'None', inline: false }
                        )
                        .setFooter({ text: '@https://discord.gg/M4wjRvywHH' })
                        .setTimestamp();
                    
                    if (ad.userImg && ad.userImg.startsWith('http')) {
                        embed.setThumbnail(ad.userImg);
                    }
                    
                    // Send to channel
                    const channel = await client.channels.fetch(channel_id).catch(() => null);
                    if (channel) {
                        await channel.send({
                            content: `<@${user_id}> New trade request ad for item ID ${item_id}.`,
                            embeds: [embed]
                        });
                        
                        // Update database
                        await db.query(
                            'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                            [ad.adId, guild_id, channel_id, user_id, item_id]
                        );
                        
                        console.log(`[AdMonitor][SUCCESS] Posted ad for item ${item_id} from user ${ad.username}`);
                    }
                }
            }
            
        } catch (err) {
            console.error(`[AdMonitor][ERROR] Error in monitor loop: ${err.message}`);
        }
    }, 15000); // Check every 15 seconds
}

module.exports = monitorAds;
