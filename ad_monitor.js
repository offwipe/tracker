const { EmbedBuilder } = require('discord.js');
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
        // Wait for at least one ad to load or timeout after 10s
        await page.waitForSelector('.mix_item', { timeout: 10000 });
        html = await page.content();
    } catch (err) {
        console.error(`[AdMonitor][Puppeteer] Error loading page for item ${itemId}:`, err);
        if (browser) await browser.close();
        return [];
    }
    if (browser) await browser.close();
    // Debug: print the first 1000 characters of the HTML
    console.log(`[AdMonitor][DEBUG][Puppeteer] First 1000 chars of HTML for item ${itemId}:\n${html.slice(0, 1000)}`);
    const $ = cheerio.load(html);
    const ads = [];
    $('.mix_item').each((i, el) => {
        const adElem = $(el);
        const ad = parseAd(adElem);
        const adId = ad.detailsUrl || Buffer.from(adElem.html()).toString('base64');
        ads.push({ ...ad, adId, url, adElem });
    });
    return ads;
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
                console.log(`[AdMonitor] Found ${ads.length} ads for item ${item_id}`);
                let foundMatch = false;
                for (const ad of ads) {
                    // Check if the tracked item is on the request side
                    const match = ad.requestItems.some(img => {
                        // Check in onclick or data-original-title for the item ID
                        return (img.onclick && img.onclick.includes(item_id)) || (img.title && img.title.includes(item_id));
                    });
                    console.log(`[AdMonitor] Checking adId: ${ad.adId} for item ${item_id} | Request side match: ${match}`);
                    if (!match) continue;
                    foundMatch = true;
                    if (ad.adId === last_ad_id) {
                        console.log(`[AdMonitor] Skipping adId: ${ad.adId} (already posted)`);
                        break; // Only post new ads since last seen
                    }
                    const channel = await client.channels.fetch(channel_id).catch(() => null);
                    if (!channel) continue;
                    // Build embed
                    const embed = new EmbedBuilder()
                        .setTitle('New Trade Request Ad')
                        .setDescription(`User: [${ad.username}](${ad.profileUrl})\nPosted: ${ad.time}`)
                        .addFields(
                            { name: 'Offer', value: ad.offerItems.map(i => `${i.name} (${i.value})`).join(', ') || 'None', inline: false },
                            { name: 'Offer Value', value: ad.offerValue || 'N/A', inline: true },
                            { name: 'Offer RAP', value: ad.offerRAP || 'N/A', inline: true },
                            { name: 'Request', value: ad.requestItems.map(i => `${i.name} (${i.value})`).join(', ') || 'None', inline: false },
                            { name: 'Request Value', value: ad.requestValue || 'N/A', inline: true },
                            { name: 'Request RAP', value: ad.requestRAP || 'N/A', inline: true }
                        )
                        .setURL(ad.detailsUrl || ad.url)
                        .setFooter({ text: 'Rolimon\'s Trade Monitor' })
                        .setTimestamp();
                    if (ad.offerItems[0] && ad.offerItems[0].img) {
                        embed.setThumbnail(ad.offerItems[0].img);
                    }
                    await channel.send({
                        content: `<@${user_id}> New trade request ad for item ID ${item_id}. [Send Trade](${ad.sendTradeUrl || ad.profileUrl})`,
                        embeds: [embed]
                    });
                    console.log(`[AdMonitor] Posted adId: ${ad.adId} for item ${item_id}`);
                    await db.query(
                        'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                        [ad.adId, guild_id, channel_id, user_id, item_id]
                    );
                    break; // Only post the newest unseen ad per cycle
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