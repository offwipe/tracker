const { EmbedBuilder } = require('discord.js');
const axios = require('axios');
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
        if (src && !src.includes('empty_trade_slot')) {
            const match = title.match(/^(.*?)<br>Value ([\d,]+)/);
            requestItems.push({
                name: match ? match[1] : alt,
                value: match ? match[2] : '',
                img: src.startsWith('http') ? src : `https://www.rolimons.com${src}`
            });
        }
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

async function fetchLatestRequestAd(itemId) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
    const $ = cheerio.load(response.data);
    // Find the first .mix_item (ad)
    const adElem = $('.mix_item').first();
    if (!adElem || adElem.length === 0) return null;
    const ad = parseAd(adElem);
    // Use detailsUrl or ad HTML as unique ID
    const adId = ad.detailsUrl || Buffer.from(adElem.html()).toString('base64');
    return { ...ad, adId, url };
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            for (const row of tracked) {
                const { guild_id, channel_id, user_id, item_id, last_ad_id } = row;
                let ad;
                try {
                    ad = await fetchLatestRequestAd(item_id);
                } catch (err) {
                    console.error(`Failed to fetch ads for item ${item_id}:`, err);
                    continue;
                }
                if (!ad) continue;
                if (ad.adId === last_ad_id) continue;
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
                // Add first offer/request item image as thumbnail if available
                if (ad.offerItems[0] && ad.offerItems[0].img) {
                    embed.setThumbnail(ad.offerItems[0].img);
                }
                await channel.send({
                    content: `<@${user_id}> New trade request ad for item ID ${item_id}. [Send Trade](${ad.sendTradeUrl || ad.profileUrl})`,
                    embeds: [embed]
                });
                await db.query(
                    'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                    [ad.adId, guild_id, channel_id, user_id, item_id]
                );
            }
        } catch (err) {
            console.error('Error in ad monitor:', err);
        }
    }, 10000);
}

module.exports = monitorAds; 