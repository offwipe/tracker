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
    // Time - try multiple selectors to find the timestamp
    let time = ad.find('.trade-ad-timestamp').text().trim();
    if (!time) {
        time = ad.find('[class*="timestamp"]').text().trim();
    }
    if (!time) {
        time = ad.find('[class*="time"]').text().trim();
    }
    if (!time) {
        time = ad.find('[class*="ago"]').text().trim();
    }
    if (!time) {
        time = ad.find('[title*="ago"]').attr('title');
    }
    if (!time) {
        // Look for any element containing "ago" text
        ad.find('*').each((i, el) => {
            const text = $(el).text().trim();
            if (text && /ago$/.test(text) && !time) {
                time = text;
                return false; // break the loop
            }
        });
    }
    console.log(`[AdMonitor][DEBUG] Raw time text: "${time}"`);
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
        
        // Debug logging for first few items
        if (i < 3) {
            console.log(`[AdMonitor][DEBUG] Request item ${i}: onclick="${onclick}", dataSrc="${dataSrc}", isPlaceholder=${isPlaceholder}, hasValidOnclick=${hasValidOnclick}`);
        }
        
        if (hasValidOnclick && !isPlaceholder) {
            const itemId = (onclick.match(/item_select_handler\((\d+),/) || [])[1] || '';
            requestItems.push({
                name: title.split('<br>')[0] || alt,
                value: (title.match(/Value ([\d,]+)/) || [])[1] || '',
                rap: (title.match(/RAP ([\d,]+)/) || [])[1] || '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`,
                title,
                onclick,
                id: itemId
            });
            
            // Debug logging for added items
            if (i < 3) {
                console.log(`[AdMonitor][DEBUG] Added request item: id=${itemId}, name="${title.split('<br>')[0] || alt}"`);
            }
        }
    });
    // Find the tracked item on the request side (if specific itemId provided)
    let trackedItem = null;
    let trackedItemValue = null;
    let trackedItemRAP = null;
    let valueDiff = null;
    let rapDiff = null;
    
    if (trackedItemId) {
        trackedItem = requestItems.find(i => i.id === trackedItemId) || requestItems.find(i => i.onclick && i.onclick.includes(trackedItemId));
        
        // Debug logging for tracked item
        if (trackedItem) {
            console.log(`[AdMonitor][DEBUG] Found tracked item: id=${trackedItem.id}, name="${trackedItem.name}"`);
        } else {
            console.log(`[AdMonitor][DEBUG] Tracked item ${trackedItemId} not found in request items. Available items: ${requestItems.map(i => i.id).join(', ')}`);
        }
        
        // Request value/RAP (now only for tracked item)
        trackedItemValue = trackedItem && trackedItem.value ? parseInt(trackedItem.value.replace(/,/g, '')) : null;
        trackedItemRAP = trackedItem && trackedItem.rap ? parseInt(trackedItem.rap.replace(/,/g, '')) : null;
        // Value and RAP difference (use only tracked item from request side)
        valueDiff = (offerValue && trackedItemValue !== null) ? offerValue - trackedItemValue : null;
        rapDiff = (offerRAP && trackedItemRAP !== null) ? offerRAP - trackedItemRAP : null;
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

async function fetchAllTradeAds() {
    const url = 'https://www.rolimons.com/trades';
    let browser, page, html;
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            browser = await puppeteer.launch({
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process',
                    '--no-zygote',
                    '--js-flags=--max-old-space-size=256'
                ],
                headless: true,
                executablePath: '/usr/bin/chromium-browser',
                ignoreDefaultArgs: ['--disable-extensions', '--disable-plugins', '--disable-images', '--disable-javascript', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
                timeout: 90000 // Increased browser launch timeout
            });
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Increased navigation timeout
            await page.waitForSelector('.mix_item', { timeout: 30000 }); // Increased selector timeout
        
        // Wait for images to load and handle lazy loading
        await page.evaluate(async () => {
            // Remove cookie/privacy popups first
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            btns.forEach(btn => {
                if (/accept|close|agree|dismiss|consent/i.test(btn.textContent)) btn.click();
            });
            const banners = document.querySelectorAll('[id*="consent"], [id*="cookie"], [class*="cookie"], [class*="consent"], [class*="privacy"], .qc-cmp2-container, .qc-cmp2-summary, .qc-cmp2-footer, .qc-cmp2-main, .qc-cmp2-ui, .qc-cmp2-persistent-link, .qc-cmp2-dialog, .qc-cmp2-custom-popup, .qc-cmp2-overlay, .qc-cmp2-banner, .qc-cmp2-summary-info, .qc-cmp2-summary-buttons');
            banners.forEach(b => b.remove());
            Array.from(document.querySelectorAll('div, span, p')).forEach(el => {
                if (/privacy|cookie/i.test(el.textContent)) el.remove();
            });
            
            // Force load all lazy-loaded images
            const lazyImages = document.querySelectorAll('img[data-src]');
            for (const img of lazyImages) {
                if (img.dataset.src && !img.dataset.src.includes('transparent-square') && !img.dataset.src.includes('empty_trade_slot')) {
                    img.src = img.dataset.src;
                    img.classList.remove('lazyload');
                    img.classList.add('lazyloaded');
                }
            }
            
            // Wait for images to load
            const imagePromises = Array.from(lazyImages).map(img => {
                return new Promise((resolve) => {
                    if (img.complete) {
                        resolve();
                    } else {
                        img.onload = () => resolve();
                        img.onerror = () => resolve(); // Don't fail if image fails to load
                    }
                });
            });
            
            await Promise.all(imagePromises);
            
            // Additional wait for any remaining lazy loading
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
        
        html = await page.content();
        break; // Success, exit retry loop
    } catch (err) {
        lastError = err;
        console.error(`[AdMonitor][Puppeteer][Attempt ${attempt}/${maxRetries}] Error loading main trades page: ${err.name}: ${err.message}`);
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        if (attempt === maxRetries) {
            throw new Error(`[AdMonitor][Puppeteer] Failed to load main trades page after ${maxRetries} attempts: ${err.message}`);
        }
        // Wait a bit before retrying
        await new Promise(res => setTimeout(res, 2000 * attempt));
    }
    }
    if (browser) await browser.close();
    const $ = cheerio.load(html);
    const ads = [];
    $('.mix_item').each((i, el) => {
        const adElem = $(el);
        if (i === 0) {
            // Log the raw HTML of the request side for the first ad
            const requestSideHtml = adElem.find('.ad_side_right').html();
            console.log(`[AdMonitor][DEBUG] Raw HTML of .ad_side_right for first ad:\n${requestSideHtml}`);
        }
        const ad = parseAd(adElem, null); // No specific itemId since we're scanning all ads
        const adId = ad.detailsUrl || Buffer.from(adElem.html()).toString('base64');
        // Log all request-side item IDs for every ad
        const requestItemIds = ad.requestItems.map(img => String(img.id));
        console.log(`[AdMonitor][DEBUG] (ad #${i}) Request side item IDs: ${JSON.stringify(requestItemIds)}`);
        ads.push({ ...ad, adId, url, adElemIndex: i });
    });
    return ads;
}

async function getTradeAdScreenshot(adElemIndex) {
    const url = 'https://www.rolimons.com/trades';
    let browser, page, buffer = null;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--js-flags=--max-old-space-size=256'
            ],
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            ignoreDefaultArgs: ['--disable-extensions', '--disable-plugins', '--disable-images', '--disable-javascript', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
            timeout: 90000 // Increased browser launch timeout
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Increased navigation timeout
        await page.waitForSelector('.mix_item', { timeout: 30000 }); // Increased selector timeout
        
        // Wait for images to load and handle lazy loading
        await page.evaluate(async () => {
            // Remove cookie/privacy popups first
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            btns.forEach(btn => {
                if (/accept|close|agree|dismiss|consent/i.test(btn.textContent)) btn.click();
            });
            const banners = document.querySelectorAll('[id*="consent"], [id*="cookie"], [class*="cookie"], [class*="consent"], [class*="privacy"], .qc-cmp2-container, .qc-cmp2-summary, .qc-cmp2-footer, .qc-cmp2-main, .qc-cmp2-ui, .qc-cmp2-persistent-link, .qc-cmp2-dialog, .qc-cmp2-custom-popup, .qc-cmp2-overlay, .qc-cmp2-banner, .qc-cmp2-summary-info, .qc-cmp2-summary-buttons');
            banners.forEach(b => b.remove());
            Array.from(document.querySelectorAll('div, span, p')).forEach(el => {
                if (/privacy|cookie/i.test(el.textContent)) el.remove();
            });
            
            // Force load all lazy-loaded images
            const lazyImages = document.querySelectorAll('img[data-src]');
            for (const img of lazyImages) {
                if (img.dataset.src && !img.dataset.src.includes('transparent-square') && !img.dataset.src.includes('empty_trade_slot')) {
                    img.src = img.dataset.src;
                    img.classList.remove('lazyload');
                    img.classList.add('lazyloaded');
                }
            }
            
            // Wait for images to load
            const imagePromises = Array.from(lazyImages).map(img => {
                return new Promise((resolve) => {
                    if (img.complete) {
                        resolve();
                    } else {
                        img.onload = () => resolve();
                        img.onerror = () => resolve(); // Don't fail if image fails to load
                    }
                });
            });
            
            await Promise.all(imagePromises);
            
            // Additional wait for any remaining lazy loading
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
        
        const adHandles = await page.$$('.mix_item');
        if (adHandles[adElemIndex]) {
            // Scroll to the specific ad to ensure it's visible
            await adHandles[adElemIndex].scrollIntoView();
            await page.waitForTimeout(1000); // Wait for any animations
            buffer = await adHandles[adElemIndex].screenshot({ 
                encoding: 'binary', 
                type: 'png',
                clip: {
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600
                }
            });
        }
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error taking screenshot for ad ${adElemIndex}:`, err);
        if (err.message && err.message.includes('Failed to launch the browser process')) {
            console.error('[AdMonitor][Puppeteer] Try upgrading your Railway plan, or use a platform with more resources for headless browsers.');
        }
    }
    if (browser) await browser.close();
    return buffer;
}

function parseAdTime(adTimeStr) {
    // Try to parse "x minutes ago", "x seconds ago", "x hours ago", or ISO string
    if (!adTimeStr) return null;
    adTimeStr = adTimeStr.trim();
    
    console.log(`[AdMonitor][DEBUG] Parsing time string: "${adTimeStr}"`);
    
    // Handle "ago" format timestamps from HTML
    if (/ago$/.test(adTimeStr)) {
        const now = new Date();
        const hourMatch = adTimeStr.match(/(\d+)\s*hour/);
        const minMatch = adTimeStr.match(/(\d+)\s*minute/);
        const secMatch = adTimeStr.match(/(\d+)\s*second/);
        
        // Reject hours - too old
        if (hourMatch) {
            const hours = parseInt(hourMatch[1]);
            console.log(`[AdMonitor][DEBUG] Rejecting hour-old timestamp: ${adTimeStr} (${hours} hours)`);
            return null;
        }
        
        // Reject minutes over 2
        if (minMatch) {
            const minutes = parseInt(minMatch[1]);
            if (minutes > 2) {
                console.log(`[AdMonitor][DEBUG] Rejecting old minute timestamp: ${adTimeStr} (${minutes} minutes > 2)`);
                return null;
            }
            const adTime = new Date(now.getTime() - minutes * 60000);
            console.log(`[AdMonitor][DEBUG] Accepted minute timestamp: ${adTimeStr} -> ${adTime}`);
            return adTime;
        }
        
        // Accept any seconds timestamp (auto-accept for freshness)
        if (secMatch) {
            const seconds = parseInt(secMatch[1]);
            const adTime = new Date(now.getTime() - seconds * 1000);
            console.log(`[AdMonitor][DEBUG] Auto-accepted seconds timestamp: ${adTimeStr} -> ${adTime} (${seconds} seconds ago)`);
            return adTime;
        }
        
        // If it ends with "ago" but doesn't match our patterns, reject it
        console.log(`[AdMonitor][DEBUG] Rejecting unknown "ago" format: ${adTimeStr}`);
        return null;
    }
    
    // Try to parse as ISO or date string, but be very strict
    const parsed = new Date(adTimeStr);
    if (isNaN(parsed)) {
        console.log(`[AdMonitor][DEBUG] Could not parse as date: ${adTimeStr}`);
        return null;
    }
    
    // Reject dates that are too old (more than 2 minutes)
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    if (parsed < twoMinutesAgo) {
        console.log(`[AdMonitor][DEBUG] Rejecting old parsed date: ${adTimeStr} -> ${parsed} (older than 2 minutes)`);
        return null;
    }
    
    console.log(`[AdMonitor][DEBUG] Accepted parsed date: ${adTimeStr} -> ${parsed}`);
    return parsed;
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            if (tracked.length === 0) {
                console.log(`[AdMonitor] No tracked items found, skipping scan`);
                return;
            }
            
            // Get all tracked item IDs for filtering
            const trackedItemIds = tracked.map(row => String(row.item_id));
            console.log(`[AdMonitor] Scanning for ${trackedItemIds.length} tracked items: ${trackedItemIds.join(', ')}`);
            
            let allAds;
            try {
                allAds = await fetchAllTradeAds();
            } catch (err) {
                console.error(`Failed to fetch ads from main trades page:`, err);
                return;
            }
            
            if (!allAds || allAds.length === 0) {
                console.log(`[AdMonitor] No ads found on main trades page`);
                return;
            }
            
            console.log(`[AdMonitor] Found ${allAds.length} ads on main trades page`);
            
            // Process each tracked item
            for (const row of tracked) {
                const { guild_id, channel_id, user_id, item_id, last_ad_id, tracking_started_at } = row;
                let foundMatch = false;
                
                for (const ad of allAds) {
                    // Check if the tracked item is on the request side (string-to-string)
                    const hasTrackedItem = ad.requestItems.some(img => String(img.id) === String(item_id));
                    if (!hasTrackedItem) {
                        continue; // Skip ads that don't contain this tracked item
                    }
                    
                    // Only post ads newer than tracking_started_at
                    let adTime = parseAdTime(ad.time);
                    console.log(`[AdMonitor][DEBUG] Ad time: "${ad.time}" -> parsed: ${adTime}`);
                    console.log(`[AdMonitor][DEBUG] Tracking started at: ${tracking_started_at}`);
                    
                    // Skip ads without valid time since we can't filter them
                    if (!adTime) {
                        console.log(`[AdMonitor] Skipping ad without valid time: "${ad.time}"`);
                        continue;
                    }
                    
                    // Hard limit: Skip ads older than 2 minutes
                    const currentTime = new Date();
                    const twoMinutesAgo = new Date(currentTime.getTime() - 2 * 60 * 1000);
                    if (adTime < twoMinutesAgo) {
                        console.log(`[AdMonitor] Skipping ad older than 2 minutes: ${ad.time} (${adTime})`);
                        continue;
                    }
                    
                    // Additional filtering based on raw time text
                    if (ad.time) {
                        const timeText = ad.time.toLowerCase();
                        
                        // Auto-accept any ad with "seconds" in the timestamp (very fresh)
                        if (timeText.includes('second')) {
                            console.log(`[AdMonitor] Auto-accepting ad with seconds timestamp: ${ad.time} (very fresh)`);
                            // Continue to next checks (don't skip)
                        }
                        // Skip any ads with "hour" or "hours" in the timestamp
                        else if (timeText.includes('hour') || timeText.includes('hours')) {
                            console.log(`[AdMonitor] Skipping ad with hour-old timestamp: ${ad.time}`);
                            continue;
                        }
                        // Skip ads with minutes > 2
                        else if (timeText.includes('minute')) {
                            const minuteMatch = timeText.match(/(\d+)\s*minute/);
                            if (minuteMatch && parseInt(minuteMatch[1]) > 2) {
                                console.log(`[AdMonitor] Skipping ad with old minute timestamp: ${ad.time} (${minuteMatch[1]} minutes > 2)`);
                                continue;
                            }
                        }
                        // Skip ads with "day" or "days" in timestamp
                        else if (timeText.includes('day') || timeText.includes('days')) {
                            console.log(`[AdMonitor] Skipping ad with day-old timestamp: ${ad.time}`);
                            continue;
                        }
                    }
                    
                    if (tracking_started_at && adTime) {
                        const startTime = new Date(tracking_started_at);
                        console.log(`[AdMonitor][DEBUG] Comparing: adTime ${adTime} vs startTime ${startTime}`);
                        if (adTime < startTime) {
                            console.log(`[AdMonitor] Skipping ad older than tracking start: ${ad.time} < ${startTime}`);
                            continue;
                        }
                    }
                    
                    // Check for user duplicate ads (same user + item within 30 minutes)
                    const userDuplicateKey = `${ad.username}-${item_id}`;
                    const now = new Date();
                    const lastUserAdTime = userDuplicateCache.get(userDuplicateKey);
                    if (lastUserAdTime && (now.getTime() - lastUserAdTime.getTime()) < 1800000) { // 30 minutes
                        console.log(`[AdMonitor] Skipping duplicate ad from user ${ad.username} for item ${item_id} within 30 minutes`);
                        continue;
                    }
                    
                    // Check for content-based duplicates (same user + item + content within 1 hour)
                    const adContentHash = `${ad.username}-${item_id}-${ad.offerItems.length}-${ad.requestItems.length}-${ad.offerValue}-${ad.requestValue}`;
                    const lastContentTime = adContentCache.get(adContentHash);
                    if (lastContentTime && (now.getTime() - lastContentTime.getTime()) < 3600000) { // 1 hour
                        console.log(`[AdMonitor] Skipping duplicate content ad from user ${ad.username} for item ${item_id}`);
                        continue;
                    }
                    
                    // Check for exact ad duplicates (same ad ID)
                    if (ad.adId === last_ad_id || postedAdIds.has(ad.adId)) {
                        console.log(`[AdMonitor] Skipping duplicate ad ID: ${ad.adId}`);
                        continue;
                    }
                    
                    foundMatch = true;
                    // Prevent duplicate posts (in-memory and DB)
                    // The above checks are now sufficient for preventing duplicates
                    
                    console.log(`[AdMonitor] Posting new ad for item ${item_id} from user ${ad.username} (ad #${ad.adElemIndex})`);
                    console.log(`[AdMonitor] Ad details - Offered: ${ad.offerItems.map(i => i.name).join(', ')}, Requested: ${ad.requestItems.map(i => i.name).join(', ')}`);
                    
                    // Update user duplicate cache
                    userDuplicateCache.set(userDuplicateKey, now);
                    postedAdIds.add(ad.adId);
                    
                    // Update content duplicate cache
                    adContentCache.set(adContentHash, now);
                    
                    const channel = await client.channels.fetch(channel_id).catch(() => null);
                    if (!channel) continue;

                    // Fetch trade ad screenshot
                    let attachment = null;
                    try {
                        console.log(`[AdMonitor] Taking screenshot for ad #${ad.adElemIndex} with tracked item ${item_id}`);
                        const buffer = await getTradeAdScreenshot(ad.adElemIndex);
                        if (buffer) {
                            attachment = new AttachmentBuilder(buffer, { name: 'trade_ad.png' });
                            console.log(`[AdMonitor] Screenshot captured successfully for ad #${ad.adElemIndex}`);
                        }
                    } catch (err) {
                        console.error(`[AdMonitor] Screenshot error:`, err);
                    }

                    // Determine embed color based on value difference
                    let embedColor = 0x2ecc40; // green by default
                    if (ad.valueDiff !== null) {
                        embedColor = ad.valueDiff >= 0 ? 0x2ecc40 : 0xe74c3c;
                    }

                    // Build embed with consistent formatting
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
                            { name: 'Value Difference', value: ad.valueDiff !== null ? (ad.valueDiff > 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'RAP Difference', value: ad.rapDiff !== null ? (ad.rapDiff > 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'Offered', value: ad.offerItems.map(i => i.name).join(', ') || 'None', inline: false },
                            { name: 'Requested', value: ad.requestItems.map(i => i.name).join(', ') || 'None', inline: false }
                        )
                        .setFooter({ text: '@https://discord.gg/M4wjRvywHH' })
                        .setTimestamp();
                    if (ad.userImg && ad.userImg.startsWith('http')) {
                        embed.setThumbnail(ad.userImg);
                    }

                    // Send to channel
                    const channelMessage = {
                        content: `<@${user_id}> New trade request ad for item ID ${item_id}.`,
                        embeds: [embed]
                    };
                    if (attachment) {
                        channelMessage.files = [attachment];
                        channelMessage.embeds = [embed.setImage('attachment://trade_ad.png')];
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
                                        { name: 'Value Difference', value: ad.valueDiff !== null ? (ad.valueDiff > 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                                        { name: 'RAP Difference', value: ad.rapDiff !== null ? (ad.rapDiff > 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
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
                                    dmMessage.embeds = [dmEmbed.setImage('attachment://trade_ad.png')];
                                }
                                
                                await user.send(dmMessage);
                                console.log(`[AdMonitor] DM sent to user ${user_id} for item ${item_id}`);
                            }
                        } catch (dmError) {
                            console.log(`[AdMonitor] Could not send DM to user ${user_id}: ${dmError.message}`);
                            // Don't fail the whole process if DM fails
                        }
                    }
                    
                    await db.query(
                        'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                        [ad.adId, guild_id, channel_id, user_id, item_id]
                    );
                    break;
                }
                if (!foundMatch) {
                    console.log(`[AdMonitor] No ads with item ${item_id} on request side found in this cycle.`);
                }
            }
        } catch (err) {
            console.error('Error in ad monitor:', err);
        }
    }, 15000); // 15 seconds - much faster scanning
}

module.exports = monitorAds; 