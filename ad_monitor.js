const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const db = require('./db');

function parseAd(ad) {
    // Username and profile
    const userAnchor = ad.find('.ad_creator_name');
    const username = userAnchor.text().trim();
    const profilePath = userAnchor.attr('href');
    const profileUrl = profilePath ? `https://www.rolimons.com${profilePath}` : null;
    // Time
    const time = ad.find('.trade-ad-timestamp').text().trim();
    // Trade details link
    const detailsAnchor = ad.find('.trade_ad_page_link_button');
    const detailsPath = detailsAnchor.attr('href');
    const detailsUrl = detailsPath ? `https://www.rolimons.com${detailsPath}` : null;
    // Send trade link
    const sendTradeAnchor = ad.find('.send_trade_button');
    const sendTradeUrl = sendTradeAnchor.attr('href');

    // Offer items
    const offerItems = [];
    ad.find('.ad_side_left .ad_item_img').each((i, el) => {
        const img = ad.find('.ad_side_left .ad_item_img').eq(i);
        const alt = img.attr('alt');
        const src = img.attr('src');
        const title = img.attr('data-original-title') || '';
        if (src && !src.includes('empty_trade_slot')) {
            // Try to extract name and value from title
            const match = title.match(/^(.*?)<br>Value ([\d,]+)/);
            offerItems.push({
                name: match ? match[1] : alt,
                value: match ? match[2] : '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`
            });
        }
    });
    // Offer value/RAP
    const offerValue = ad.find('.ad_side_left .stat_value').first().text().trim();
    const offerRAP = ad.find('.ad_side_left .stat_rap').first().text().trim();

    // Request items
    const requestItems = [];
    ad.find('.ad_side_right .ad_item_img').each((i, el) => {
        const img = ad.find('.ad_side_right .ad_item_img').eq(i);
        const alt = img.attr('alt');
        const src = img.attr('src');
        const title = img.attr('data-original-title') || '';
        const onclick = img.attr('onclick') || '';
        requestItems.push({
            name: title.split('<br>')[0] || alt,
            value: (title.match(/Value ([\d,]+)/) || [])[1] || '',
            img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`,
            title,
            onclick
        });
    });
    // Request value/RAP
    const requestValue = ad.find('.ad_side_right .stat_value').first().text().trim();
    const requestRAP = ad.find('.ad_side_right .stat_rap').first().text().trim();

    return {
        username,
        profileUrl,
        time,
        detailsUrl,
        sendTradeUrl,
        offerItems,
        offerValue,
        offerRAP,
        requestItems,
        requestValue,
        requestRAP
    };
}

async function fetchAllRequestAds(itemId) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    let browser, page, html;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        html = await page.content();
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error loading page for item ${itemId}:`, err);
        if (browser) await browser.close();
        return [];
    }
    if (browser) await browser.close();
    const $ = cheerio.load(html);
    const ads = [];
    $('.mix_item').each((i, el) => {
        const adElem = $(el);
        const ad = parseAd(adElem);
        const adId = ad.detailsUrl || Buffer.from(adElem.html()).toString('base64');
        ads.push({ ...ad, adId, url, adElemIndex: i });
    });
    return ads;
}

async function getTradeAdScreenshot(itemId, adElemIndex) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    let browser, page, buffer = null;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        const adHandles = await page.$$('.mix_item');
        if (adHandles[adElemIndex]) {
            buffer = await adHandles[adElemIndex].screenshot({ encoding: 'binary', type: 'png' });
        }
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error taking screenshot for item ${itemId}:`, err);
    }
    if (browser) await browser.close();
    return buffer;
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            for (const row of tracked) {
                const { guild_id, channel_id, user_id, item_id, last_ad_id } = row;
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
                    // Check if the tracked item is on the request side
                    const match = ad.requestItems.some(img => {
                        return (img.onclick && img.onclick.includes(item_id)) || (img.title && img.title.includes(item_id));
                    });
                    if (!match) continue;
                    foundMatch = true;
                    if (ad.adId === last_ad_id) {
                        break;
                    }
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

                    // Build embed with improved formatting
                    const embed = new EmbedBuilder()
                        .setTitle(`Send ${ad.username} a Trade`)
                        .setURL(ad.sendTradeUrl || ad.profileUrl)
                        .addFields(
                            { name: 'Item', value: ad.requestItems.map(i => i.name).join(', ') || 'Unknown', inline: true },
                            { name: 'Rolimon\'s Profile', value: `[View Profile](${ad.profileUrl})`, inline: true },
                            { name: 'Roblox Trade Link', value: ad.sendTradeUrl ? `[Send Trade](${ad.sendTradeUrl})` : 'N/A', inline: true },
                            { name: 'Trade Ads Created', value: 'N/A', inline: true },
                            { name: 'User Total Value', value: ad.offerValue || 'N/A', inline: true },
                            { name: 'Value Difference', value: 'N/A', inline: true },
                            { name: 'RAP Difference', value: 'N/A', inline: true },
                            { name: 'Offered', value: ad.offerItems.map(i => i.name).join(', ') || 'None', inline: false },
                            { name: 'Requested', value: ad.requestItems.map(i => i.name).join(', ') || 'None', inline: false }
                        )
                        .setFooter({ text: 'Rolimon\'s Trade Monitor' })
                        .setTimestamp();
                    if (ad.offerItems[0] && ad.offerItems[0].img) {
                        embed.setThumbnail(ad.offerItems[0].img);
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
    }, 10000);
}

module.exports = monitorAds; 