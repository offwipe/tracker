const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('untrack')
        .setDescription('Stop tracking a Roblox item')
        .addStringOption(option =>
            option.setName('itemid')
                .setDescription('The Roblox item ID to stop tracking')
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
            // Check if the item is being tracked by this user
            const { rows: trackedRows } = await db.query(
                'SELECT * FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND item_id = $4',
                [guildId, channelId, userId, itemId]
            );

            if (trackedRows.length === 0) {
                await interaction.editReply({
                    content: `❌ You are not tracking item ID **${itemId}** in this channel.`,
                    ephemeral: true
                });
                return;
            }

            // Remove the tracked item
            await db.query(
                'DELETE FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND item_id = $4',
                [guildId, channelId, userId, itemId]
            );

            // Create embed for confirmation
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('🛑 Item Tracking Stopped')
                .setDescription(`Item ID **${itemId}** is no longer being tracked in this channel.`)
                .setFooter({ text: 'Tracking stopped', iconURL: 'https://www.rolimons.com/favicon.ico' })
                .setTimestamp();

            await interaction.editReply({
                content: `${interaction.user}, item ID **${itemId}** has been removed from your tracking list!`,
                embeds: [embed]
            });

        } catch (error) {
            console.error('Error removing tracked item:', error);
            await interaction.editReply({
                content: `error: please contact admin`,
                ephemeral: true
            });
        }
    },
}; 