const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trackitem')
        .setDescription('Track Roblox item trades from Rolimon\'s')
        .addStringOption(option =>
            option.setName('itemid')
                .setDescription('The Roblox item ID to track')
                .setRequired(true)),

    async execute(interaction) {
        const channelId = interaction.channel.id;
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const itemId = interaction.options.getString('itemid');

        // Check if channel is whitelisted
        const { rows: whitelistRows } = await db.query(
            'SELECT 1 FROM whitelisted_channels WHERE guild_id = $1 AND channel_id = $2',
            [guildId, channelId]
        );
        if (whitelistRows.length === 0) {
            await interaction.reply({ content: '❌ This channel is not whitelisted for tracking commands. Please ask an admin to use /whitelistchannel.', ephemeral: true });
            return;
        }

        await interaction.deferReply();
        try {
            // Fetch the Rolimon's page
            const response = await axios.get(`https://www.rolimons.com/itemtrades/${itemId}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            const $ = cheerio.load(response.data);
            const itemName = $('h1').first().text().trim() || 'Unknown Item';
            const itemImage = $('img[src*="/items/"]').first().attr('src');

            // Store tracked item in DB
            await db.query(
                'INSERT INTO tracked_items (guild_id, channel_id, user_id, item_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [guildId, channelId, userId, itemId]
            );

            // Acknowledge tracking
            await interaction.editReply({
                content: `${interaction.user}, **${itemName}** is now being tracked in this channel!`,
                embeds: [
                    new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle(`📊 Item Trade Tracker: ${itemName}`)
                        .setDescription(`Tracking trades for item ID: **${itemId}**`)
                        .setURL(`https://www.rolimons.com/itemtrades/${itemId}`)
                        .setThumbnail(itemImage || null)
                        .setFooter({ text: 'Tracking started', iconURL: 'https://www.rolimons.com/favicon.ico' })
                ]
            });
        } catch (error) {
            console.error('Error fetching item data:', error);
            await interaction.editReply({
                content: `❌ Error fetching data for item ID ${itemId}. Please check if the item ID is valid and try again.`,
                ephemeral: true
            });
        }
    },
}; 