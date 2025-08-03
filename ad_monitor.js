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

// Screenshot system improvements
let sharedBrowser = null;
const freshAdsForScreenshot = new Map(); // adId -> {ad, timestamp, attempts}
const screenshotMetrics = {
    attempts: 0,
    successes: 0,
    failures: 0,
    avgTime: 0,
    lastSuccess: null,
    lastError: null
};

// Enhanced logging with colors
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const colors = {
        'ERROR': '\x1b[31m', // Red
        'WARN': '\x1b[33m',  // Yellow
        'SUCCESS': '\x1b[32m', // Green
        'INFO': '\x1b[36m',  // Cyan
        'DEBUG': '\x1b[35m'  // Magenta
    };
    const reset = '\x1b[0m';
    const color = colors[level] || colors['INFO'];
    console.log(`${color}[${timestamp}][${level}]${reset} ${message}`);
}

// Get or create shared browser instance
async function getSharedBrowser() {
    if (!sharedBrowser) {
        try {
            sharedBrowser = await puppeteer.launch({
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
                    '--disable-features=VizDisplayCompositor',
                    '--memory-pressure-off',
                    '--max_old_space_size=4096'
                ]
            });
            log('Shared browser instance created successfully', 'SUCCESS');
        } catch (err) {
            log(`Failed to create shared browser: ${err.message}`, 'ERROR');
            throw err;
        }
    }
    return sharedBrowser;
}

// Clean up shared browser
async function cleanupSharedBrowser() {
    if (sharedBrowser) {
        try {
            await sharedBrowser.close();
            sharedBrowser = null;
            log('Shared browser cleaned up', 'INFO');
        } catch (err) {
            log(`Error cleaning up browser: ${err.message}`, 'WARN');
        }
    }
}

// Flexible time matching
function isTimeClose(time1, time2) {
    if (!time1 || !time2) return false;
    
    // Normalize times
    const normalizeTime = (time) => {
        return time.toLowerCase().trim().replace(/\s+/g, ' ');
    };
    
    const t1 = normalizeTime(time1);
    const t2 = normalizeTime(time2);
    
    // Exact match
    if (t1 === t2) return true;
    
    // Extract numbers and units
    const extractTime = (timeStr) => {
        const match = timeStr.match(/(\d+)\s*(second|minute|hour)s?\s*ago/i);
        if (match) {
            return { value: parseInt(match[1]), unit: match[2].toLowerCase() };
        }
        return null;
    };
    
    const time1Data = extractTime(t1);
    const time2Data = extractTime(t2);
    
    if (!time1Data || !time2Data) return false;
    
    // Allow 5-second tolerance for same unit
    if (time1Data.unit === time2Data.unit) {
        return Math.abs(time1Data.value - time2Data.value) <= 5;
    }
    
    // Allow cross-unit matching (e.g., "59 seconds ago" matches "1 minute ago")
    if (time1Data.unit === 'second' && time2Data.unit === 'minute' && time2Data.value === 1) {
        return time1Data.value >= 55 && time1Data.value <= 65;
    }
    if (time2Data.unit === 'second' && time1Data.unit === 'minute' && time1Data.value === 1) {
        return time2Data.value >= 55 && time2Data.value <= 65;
    }
    
    return false;
}

// Enhanced element finding with fallbacks
function findAdElement(page, targetUsername, targetTime) {
    return page.evaluateHandle((username, time) => {
        const ads = document.querySelectorAll('.mix_item');
        
        for (let i = 0; i < ads.length; i++) {
            const ad = ads[i];
            
            // Find username element
            const usernameElement = ad.querySelector('.ad_creator_name');
            if (!usernameElement) continue;
            
            const foundUsername = usernameElement.textContent.trim();
            if (foundUsername.toLowerCase() !== username.toLowerCase()) continue;
            
            // Find time element with multiple fallbacks
            let timeElement = null;
            const timeSelectors = [
                '.trade-ad-timestamp',
                '[class*="timestamp"]',
                '[class*="time"]',
                '[title*="ago"]',
                '[data-time]'
            ];
            
            for (const selector of timeSelectors) {
                timeElement = ad.querySelector(selector);
                if (timeElement && timeElement.textContent && timeElement.textContent.trim()) break;
            }
            
            // Fallback: search all text content for time
            if (!timeElement || !timeElement.textContent) {
                const allText = ad.textContent;
                const timeMatch = allText.match(/(\d+\s*(?:second|minute|hour)s?\s*ago)/i);
                if (timeMatch) {
                    timeElement = { textContent: timeMatch[1] };
                }
            }
            
            if (timeElement && timeElement.textContent) {
                const adTime = timeElement.textContent.trim();
                
                // Flexible time matching
                if (isTimeClose(adTime, time)) {
                    return ad;
                }
            }
        }
        
        return null;
    }, targetUsername, targetTime);
}

// Enhanced screenshot function with retries and fallbacks
async function getTradeAdScreenshotWithRetry(adData, itemId, maxRetries = 3) {
    const { username, time, adElemIndex } = adData;
    const startTime = Date.now();
    
    screenshotMetrics.attempts++;
    
    try {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();
        
        // Enhanced page setup
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Set longer timeout for better reliability
        await page.setDefaultTimeout(45000);
        await page.setDefaultNavigationTimeout(45000);
        
        const url = `https://www.rolimons.com/trades`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        
        // Handle cookie consent with longer timeout
        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 10000 });
            await page.click('#onetrust-accept-btn-handler');
            log('Clicked cookie consent button', 'INFO');
        } catch (cookieErr) {
            // Cookie popup might not appear, that's fine
        }
        
        // Wait for ads to load with longer timeout
        await page.waitForSelector('.mix_item', { timeout: 15000 });
        
        // Find the ad element with enhanced logic
        const adElement = await findAdElement(page, username, time);
        
        // Check if we found a valid element
        if (!adElement) {
            log(`No ad element found for ${username} at ${time}`, 'WARN');
            return null;
        }
        
        const elementHandle = await adElement.asElement();
        if (!elementHandle) {
            log(`Could not get element handle for ${username} at ${time}`, 'WARN');
            return null;
        }
        
        try {
            // Scroll element into view and wait for animations
            await elementHandle.scrollIntoView();
            await page.waitForTimeout(1000);
            
            // Enhanced screenshot with better quality
            const screenshot = await elementHandle.screenshot({
                type: 'png',
                encoding: 'binary',
                quality: 90
            });
            
            const duration = Date.now() - startTime;
            screenshotMetrics.successes++;
            screenshotMetrics.avgTime = (screenshotMetrics.avgTime + duration) / 2;
            screenshotMetrics.lastSuccess = new Date();
            
            log(`Successfully took screenshot for ${username} at ${time} (${duration}ms)`, 'SUCCESS');
            return new AttachmentBuilder(screenshot, { name: 'trade_ad.png' });
        } catch (screenshotErr) {
            log(`Screenshot failed for ${username}: ${screenshotErr.message}`, 'ERROR');
            return null;
        }
        
        log(`Could not find ad element for screenshot - username: ${username}, time: ${time}`, 'WARN');
        return null;
        
    } catch (err) {
        const duration = Date.now() - startTime;
        screenshotMetrics.failures++;
        screenshotMetrics.lastError = err.message;
        
        log(`Screenshot attempt failed for ${username}: ${err.message} (${duration}ms)`, 'ERROR');
        
        // Retry logic
        if (maxRetries > 1) {
            log(`Retrying screenshot for ${username} (${maxRetries - 1} attempts left)`, 'WARN');
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
            return await getTradeAdScreenshotWithRetry(adData, itemId, maxRetries - 1);
        }
        
        return null;
    }
}

// Create a hash of ad content for duplicate detection
function createAdHash(ad) {
    // Include more specific data to prevent false duplicates
    const content = `${ad.username}-${ad.time}-${ad.offerItems.map(i => i.name).join(',')}-${ad.requestItems.map(i => i.name).join(',')}-${ad.offerValue}-${ad.requestValue}`;
    return crypto.createHash('md5').update(content).digest('hex');
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
        const minMatch = adTimeStr.match(/(\d+)\s*minute/);
        
        // Accept seconds under 60 (1 minute)
        if (secMatch) {
            const seconds = parseInt(secMatch[1]);
            if (seconds > 60) {
                return null;
            }
            return new Date(now.getTime() - seconds * 1000);
        }
        
        // Accept exactly 1 minute (60-119 seconds show as "1 minute ago")
        if (minMatch) {
            const minutes = parseInt(minMatch[1]);
            if (minutes === 1) {
                // 1 minute ago = between 60-119 seconds, so use 90 seconds as average
                return new Date(now.getTime() - 90 * 1000);
            }
            // Reject 2+ minutes
            return null;
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

// Enhanced ad processing with caching and parallel screenshots
async function processAdsWithScreenshots(ads, trackedItems) {
    const freshAds = [];
    const screenshotPromises = [];
    
    // First pass: identify fresh ads and add to cache
    for (const ad of ads) {
        const adTime = parseAdTime(ad.time);
        if (!adTime) {
            log(`Skipping ad without valid time: "${ad.time}"`, 'WARN');
            continue;
        }
        
        const currentTime = new Date();
        const ninetySecondsAgo = new Date(currentTime.getTime() - 90 * 1000); // Extended window
        
        if (adTime > ninetySecondsAgo) {
            freshAdsForScreenshot.set(ad.adId, { 
                ad, 
                timestamp: Date.now(),
                attempts: 0 
            });
            freshAds.push(ad);
        }
    }
    
    log(`Found ${freshAds.length} fresh ads for processing`, 'INFO');
    
    // Second pass: process ads and prepare screenshot promises
    for (const ad of freshAds) {
        // Check if any tracked item is on the request side
        const trackedItemIds = ['10159600649', '1678356850', '1402433072', '583721561', '9910420'];
        const matchedItemId = trackedItemIds.find(itemId => 
            ad.requestItems.some(img => String(img.id) === String(itemId))
        );
        
        if (!matchedItemId) {
            log(`Ad skipped - no tracked items found in request items: ${ad.requestItems.map(i => i.id).join(', ')}`, 'WARN');
            continue;
        }
        
        // Find the corresponding tracked item row
        const row = trackedItems.find(r => String(r.item_id) === String(matchedItemId));
        if (!row) {
            log(`No tracking row found for item ${matchedItemId}`, 'WARN');
            continue;
        }
        
        // Prepare screenshot promise for this ad
        const screenshotPromise = getTradeAdScreenshotWithRetry(ad, matchedItemId)
            .then(attachment => ({ ad, row, attachment, success: true }))
            .catch(err => ({ ad, row, attachment: null, success: false, error: err.message }));
        
        screenshotPromises.push(screenshotPromise);
    }
    
    // Wait for all screenshots with timeout
    log(`Starting ${screenshotPromises.length} screenshot operations in parallel`, 'INFO');
    const results = await Promise.allSettled(screenshotPromises);
    
    // Process results
    const processedResults = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            processedResults.push(result.value);
        } else {
            log(`Screenshot promise rejected: ${result.reason}`, 'ERROR');
        }
    }
    
    return processedResults;
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

async function monitorAds(client) {
    // Log startup with metrics
    log('Enhanced ad monitor started with improved screenshot system', 'SUCCESS');
    log(`Screenshot metrics: ${screenshotMetrics.attempts} attempts, ${screenshotMetrics.successes} successes, ${screenshotMetrics.failures} failures`, 'INFO');
    
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            if (!tracked || tracked.length === 0) {
                log('No tracked items found in database', 'WARN');
                return;
            }
            
            let ads;
            try {
                ads = await fetchAllRequestAds();
            } catch (err) {
                log(`Failed to fetch ads from trades page: ${err.message}`, 'ERROR');
                return;
            }
            
            if (!ads || ads.length === 0) {
                log('No ads found on trades page', 'WARN');
                return;
            }
            
            log(`Processing ${ads.length} ads with enhanced screenshot system`, 'INFO');
            
            // Use enhanced processing with parallel screenshots
            const processedResults = await processAdsWithScreenshots(ads, tracked);
            
            // Process results and send messages
            for (const result of processedResults) {
                const { ad, row, attachment, success, error } = result;
                
                if (!row) continue;
                
                const { guild_id, channel_id, user_id, item_id, last_ad_id, tracking_started_at } = row;
                
                // Enhanced duplicate prevention with extended time window
                const currentTime = new Date();
                const ninetySecondsAgo = new Date(currentTime.getTime() - 90 * 1000);
                const adTime = parseAdTime(ad.time);
                
                if (!adTime || adTime < ninetySecondsAgo) {
                    log(`Skipping ad older than 90 seconds: ${ad.time}`, 'WARN');
                    continue;
                }
                
                // Enhanced duplicate checks
                const userDuplicateKey = `${ad.username}-${item_id}`;
                const lastUserAdTime = userDuplicateCache.get(userDuplicateKey);
                if (lastUserAdTime && (currentTime.getTime() - lastUserAdTime.getTime()) < 3600000) {
                    log(`Skipping duplicate ad from user ${ad.username} for item ${item_id} within 1 hour`, 'WARN');
                    continue;
                }
                
                const contentHashKey = `${ad.username}-${item_id}-${ad.adId}`;
                const lastContentHashTime = adContentCache.get(contentHashKey);
                if (lastContentHashTime && (currentTime.getTime() - lastContentHashTime.getTime()) < 3600000) {
                    log(`Skipping duplicate content hash from user ${ad.username} for item ${item_id} within 1 hour`, 'WARN');
                    continue;
                }
                
                const exactDuplicateKey = `${ad.username}-${ad.time}-${item_id}`;
                const lastExactDuplicate = adContentCache.get(exactDuplicateKey);
                if (lastExactDuplicate) {
                    log(`Skipping exact duplicate: ${ad.username} at ${ad.time} for item ${item_id}`, 'WARN');
                    continue;
                }
                
                // Prevent duplicate posts (in-memory and DB)
                if (ad.adId === last_ad_id || postedAdIds.has(ad.adId)) {
                    log(`Skipping duplicate ad ID: ${ad.adId}`, 'WARN');
                    continue;
                }
                
                // Only post ads newer than tracking_started_at
                if (tracking_started_at && adTime) {
                    const startTime = new Date(tracking_started_at);
                    if (adTime < startTime) {
                        log(`Skipping ad older than tracking start: ${ad.time}`, 'WARN');
                        continue;
                    }
                }
                
                log(`Posting new ad for item ${item_id} from user ${ad.username} (screenshot: ${success ? 'SUCCESS' : 'FAILED'})`, 'SUCCESS');
                
                // Update all caches
                userDuplicateCache.set(userDuplicateKey, currentTime);
                adContentCache.set(contentHashKey, currentTime);
                adContentCache.set(exactDuplicateKey, currentTime);
                postedAdIds.add(ad.adId);
                
                // Get channel
                const channel = await client.channels.fetch(channel_id).catch(() => null);
                if (!channel) {
                    log(`Could not fetch channel ${channel_id}`, 'ERROR');
                    continue;
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
                            log(`DM sent to user ${user_id} for item ${item_id}`, 'SUCCESS');
                        }
                    } catch (dmError) {
                        log(`Could not send DM to user ${user_id}: ${dmError.message}`, 'ERROR');
                    }
                }
                
                // Update database
                await db.query(
                    'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                    [ad.adId, guild_id, channel_id, user_id, item_id]
                );
            }
            
            // Log metrics periodically
            if (screenshotMetrics.attempts > 0 && screenshotMetrics.attempts % 10 === 0) {
                const successRate = ((screenshotMetrics.successes / screenshotMetrics.attempts) * 100).toFixed(1);
                log(`Screenshot metrics: ${screenshotMetrics.attempts} attempts, ${screenshotMetrics.successes} successes (${successRate}%), avg time: ${screenshotMetrics.avgTime.toFixed(0)}ms`, 'INFO');
            }
            
        } catch (err) {
            log(`Error in enhanced ad monitor: ${err.message}`, 'ERROR');
        }
    }, 30000); // 30 seconds - quality over speed
    
    // Cleanup on process exit
    process.on('SIGINT', async () => {
        log('Shutting down enhanced ad monitor...', 'INFO');
        await cleanupSharedBrowser();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        log('Shutting down enhanced ad monitor...', 'INFO');
        await cleanupSharedBrowser();
        process.exit(0);
    });
}

module.exports = monitorAds; 