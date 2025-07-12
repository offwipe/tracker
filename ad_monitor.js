const { Client, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

async function fetchLatestRequestAd(itemId) {
    const url = `https://www.rolimons.com/itemtrades/${itemId}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
    const $ = cheerio.load(response.data);

    // Find the first request ad (this logic may need to be updated if Rolimon's changes their layout)
    let ad = null;
    $('.trade-ad, .trade-entry, .trade-item, [class*="trade"]').each((i, el) => {
        const text = $(el).text().toLowerCase();
        if (text.includes('request') || text.includes('want') || text.includes('buying')) {
            ad = $(el);
            return false; // break
        }
    });
    if (!ad) return null;

    // Try to extract a unique ad id (fallback to ad text hash)
    const adText = ad.text().trim();
    const adId = ad.attr('data-id') || Buffer.from(adText).toString('base64');

    // Extract ad details for the embed
    return {
        adId,
        adText,
        adHtml: ad.html(),
        url,
    };
}

async function monitorAds(client) {
    setInterval(async () => {
        try {
            // Get all tracked items
            const { rows: tracked } = await db.query('SELECT * FROM tracked_items');
            for (const row of tracked) {
                const { guild_id, channel_id, user_id, item_id, last_ad_id } = row;
                // Fetch latest request ad
                let ad;
                try {
                    ad = await fetchLatestRequestAd(item_id);
                } catch (err) {
                    console.error(`Failed to fetch ads for item ${item_id}:`, err);
                    continue;
                }
                if (!ad) continue;
                if (ad.adId === last_ad_id) continue; // No new ad

                // Post the ad in the channel
                const channel = await client.channels.fetch(channel_id).catch(() => null);
                if (!channel) continue;

                // Build a clean embed (no emojis)
                const embed = new EmbedBuilder()
                    .setTitle('New Trade Request Ad Found')
                    .setDescription(`Item ID: ${item_id}\n[View on Rolimon's](${ad.url})`)
                    .addFields({ name: 'Ad Details', value: ad.adText.substring(0, 1024) })
                    .setFooter({ text: 'Rolimon\'s Trade Monitor' })
                    .setTimestamp();

                await channel.send({
                    content: `<@${user_id}> A new trade request ad was found for item ID ${item_id}.`,
                    embeds: [embed]
                });

                // Update last_ad_id in DB
                await db.query(
                    'UPDATE tracked_items SET last_ad_id = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                    [ad.adId, guild_id, channel_id, user_id, item_id]
                );
            }
        } catch (err) {
            console.error('Error in ad monitor:', err);
        }
    }, 10000); // 10 seconds
}

module.exports = monitorAds; 