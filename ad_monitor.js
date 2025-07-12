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

function parseAd(ad, trackedItemId) {
    // Username and profile
    const userAnchor = ad.find('.ad_creator_name');
    const username = userAnchor.text().trim();
    const profilePath = userAnchor.attr('href');
    const profileUrl = profilePath ? `https://www.rolimons.com${profilePath}` : null;
    // User profile image
    const userImg = ad.find('.ad_creator_pfp').attr('src') || null;
    // Time
    const time = ad.find('.trade-ad-timestamp').text().trim();
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
        // Enhanced blank/placeholder image filtering
        const isPlaceholder = !src || PLACEHOLDER_IMAGES.includes(src) || PLACEHOLDER_IMAGES.includes(img.attr('src')) || PLACEHOLDER_IMAGES.includes(img.attr('data-src'));
        const isBlank = !src || src === '' || src === '#' || src === '/';
        const isValidImg = src && (src.startsWith('http') || src.startsWith('https://tr.rbxcdn.com'));
        if (!isPlaceholder && !isBlank && isValidImg) {
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
        // Enhanced blank/placeholder image filtering
        const isPlaceholder = !src || PLACEHOLDER_IMAGES.includes(src) || PLACEHOLDER_IMAGES.includes(img.attr('src')) || PLACEHOLDER_IMAGES.includes(img.attr('data-src'));
        const isBlank = !src || src === '' || src === '#' || src === '/';
        const isValidImg = src && (src.startsWith('http') || src.startsWith('https://tr.rbxcdn.com'));
        if (onclick && !isPlaceholder && !isBlank && isValidImg) {
            requestItems.push({
                name: title.split('<br>')[0] || alt,
                value: (title.match(/Value ([\d,]+)/) || [])[1] || '',
                rap: (title.match(/RAP ([\d,]+)/) || [])[1] || '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`,
                title,
                onclick,
                id: (onclick.match(/item_select_handler\((\d+),/) || [])[1] || ''
            });
        }
    });
    // Find the tracked item on the request side
    const trackedItem = requestItems.find(i => i.id === trackedItemId) || requestItems.find(i => i.onclick && i.onclick.includes(trackedItemId));
    // Request value/RAP (now only for tracked item)
    const trackedItemValue = trackedItem && trackedItem.value ? parseInt(trackedItem.value.replace(/,/g, '')) : null;
    const trackedItemRAP = trackedItem && trackedItem.rap ? parseInt(trackedItem.rap.replace(/,/g, '')) : null;
    // Value and RAP difference (use only tracked item from request side)
    const valueDiff = (offerValue && trackedItemValue !== null) ? offerValue - trackedItemValue : null;
    const rapDiff = (offerRAP && trackedItemRAP !== null) ? offerRAP - trackedItemRAP : null;

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

async function fetchAllRequestAds(itemId) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    let browser, page, html;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            headless: true
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        // Try to click or remove cookie/privacy popups
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            btns.forEach(btn => {
                if (/accept|close|agree|dismiss|consent/i.test(btn.textContent)) btn.click();
            });
            const banners = document.querySelectorAll('[id*="consent"], [id*="cookie"], [class*="cookie"], [class*="consent"], [class*="privacy"], .qc-cmp2-container, .qc-cmp2-summary, .qc-cmp2-footer, .qc-cmp2-main, .qc-cmp2-ui, .qc-cmp2-persistent-link, .qc-cmp2-dialog, .qc-cmp2-custom-popup, .qc-cmp2-overlay, .qc-cmp2-banner, .qc-cmp2-summary-info, .qc-cmp2-summary-buttons');
            banners.forEach(b => b.remove());
            Array.from(document.querySelectorAll('div, span, p')).forEach(el => {
                if (/privacy|cookie/i.test(el.textContent)) el.remove();
            });
        });
        html = await page.content();
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error loading page for item ${itemId}:`, err);
        if (err.message && err.message.includes('Failed to launch the browser process')) {
            console.error('[AdMonitor][Puppeteer] Try upgrading your Railway plan, or use a platform with more resources for headless browsers.');
        }
        if (browser) await browser.close();
        return [];
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
        const ad = parseAd(adElem, itemId);
        const adId = ad.detailsUrl || Buffer.from(adElem.html()).toString('base64');
        // Log all request-side item IDs for every ad
        const requestItemIds = ad.requestItems.map(img => String(img.id));
        console.log(`[AdMonitor][DEBUG] (ad #${i}) Tracked item ID: ${String(itemId)}, Request side item IDs: ${JSON.stringify(requestItemIds)}`);
        ads.push({ ...ad, adId, url, adElemIndex: i });
    });
    return ads;
}

async function getTradeAdScreenshot(itemId, adElemIndex) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    let browser, page, buffer = null;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            headless: true
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        // Try to click or remove cookie/privacy popups
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            btns.forEach(btn => {
                if (/accept|close|agree|dismiss|consent/i.test(btn.textContent)) btn.click();
            });
            const banners = document.querySelectorAll('[id*="consent"], [id*="cookie"], [class*="cookie"], [class*="consent"], [class*="privacy"], .qc-cmp2-container, .qc-cmp2-summary, .qc-cmp2-footer, .qc-cmp2-main, .qc-cmp2-ui, .qc-cmp2-persistent-link, .qc-cmp2-dialog, .qc-cmp2-custom-popup, .qc-cmp2-overlay, .qc-cmp2-banner, .qc-cmp2-summary-info, .qc-cmp2-summary-buttons');
            banners.forEach(b => b.remove());
            Array.from(document.querySelectorAll('div, span, p')).forEach(el => {
                if (/privacy|cookie/i.test(el.textContent)) el.remove();
            });
        });
        const adHandles = await page.$$('.mix_item');
        if (adHandles[adElemIndex]) {
            buffer = await adHandles[adElemIndex].screenshot({ encoding: 'binary', type: 'png' });
        }
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error taking screenshot for item ${itemId}:`, err);
        if (err.message && err.message.includes('Failed to launch the browser process')) {
            console.error('[AdMonitor][Puppeteer] Try upgrading your Railway plan, or use a platform with more resources for headless browsers.');
        }
    }
    if (browser) await browser.close();
    return buffer;
}

function parseAdTime(adTimeStr) {
    // Try to parse "x minutes ago", "x seconds ago", or ISO string
    if (!adTimeStr) return null;
    adTimeStr = adTimeStr.trim();
    if (/ago$/.test(adTimeStr)) {
        const now = new Date();
        const min = adTimeStr.match(/(\d+)\s*minute/);
        const sec = adTimeStr.match(/(\d+)\s*second/);
        if (min) return new Date(now.getTime() - parseInt(min[1]) * 60000);
        if (sec) return new Date(now.getTime() - parseInt(sec[1]) * 1000);
        return now;
    }
    // Try to parse as ISO or date string
    const parsed = new Date(adTimeStr);
    return isNaN(parsed) ? null : parsed;
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            for (const row of tracked) {
                const { guild_id, channel_id, user_id, item_id, last_ad_id, tracking_started_at } = row;
                let ads;
                try {
                    ads = await fetchAllRequestAds(item_id);
                } catch (err) {
                    console.error(`Failed to fetch ads for item ${item_id}:`, err);
                    continue;
                }
                if (!ads || ads.length === 0) {
                    console.log(`[AdMonitor] No ads found for item ${item_id}`);
                    continue;
                }
                let foundMatch = false;
                for (const ad of ads) {
                    // Check if the tracked item is on the request side (string-to-string)
                    const match = ad.requestItems.some(img => String(img.id) === String(item_id));
                    if (!match) continue;
                    // Only post ads newer than tracking_started_at
                    let adTime = parseAdTime(ad.time);
                    if (tracking_started_at && adTime) {
                        const startTime = new Date(tracking_started_at);
                        if (adTime < startTime) {
                            continue;
                        }
                    }
                    foundMatch = true;
                    // Prevent duplicate posts (in-memory and DB)
                    if (ad.adId === last_ad_id || postedAdIds.has(ad.adId)) {
                        continue;
                    }
                    postedAdIds.add(ad.adId);
                    const channel = await client.channels.fetch(channel_id).catch(() => null);
                    if (!channel) continue;

                    // Fetch trade ad screenshot
                    let attachment = null;
                    try {
                        const buffer = await getTradeAdScreenshot(item_id, ad.adElemIndex);
                        if (buffer) {
                            attachment = new AttachmentBuilder(buffer, { name: 'trade_ad.png' });
                        }
                    } catch (err) {
                        console.error(`[AdMonitor] Screenshot error:`, err);
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
                            { name: 'Value Difference', value: ad.valueDiff !== null ? (ad.valueDiff > 0 ? '+' : '') + ad.valueDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'RAP Difference', value: ad.rapDiff !== null ? (ad.rapDiff > 0 ? '+' : '') + ad.rapDiff.toLocaleString() : 'N/A', inline: true },
                            { name: 'Offered', value: ad.offerItems.map(i => i.name).join(', ') || 'None', inline: false },
                            { name: 'Requested', value: ad.requestItems.map(i => i.name).join(', ') || 'None', inline: false }
                        )
                        .setFooter({ text: 'Rolimon\'s Trade Monitor' })
                        .setTimestamp();
                    if (ad.userImg && ad.userImg.startsWith('http')) {
                        embed.setThumbnail(ad.userImg);
                    }
                    if (attachment) {
                        await channel.send({
                            content: `<@${user_id}> New trade request ad for item ID ${item_id}.`,
                            embeds: [embed.setImage('attachment://trade_ad.png')],
                            files: [attachment]
                        });
                    } else {
                        await channel.send({
                            content: `<@${user_id}> New trade request ad for item ID ${item_id}.`,
                            embeds: [embed]
                        });
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
    }, 60000); // 60 seconds
}

module.exports = monitorAds; 