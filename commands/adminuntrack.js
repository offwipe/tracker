const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('adminuntrack')
        .setDescription('Admin command: Stop tracking a Roblox item for any user')
        .addStringOption(option =>
            option.setName('itemid')
                .setDescription('The Roblox item ID to stop tracking')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user whose item tracking to stop (optional - defaults to yourself)')
                .setRequired(false)),

    async execute(interaction) {
        const channelId = interaction.channel.id;
        const guildId = interaction.guild.id;
        const adminUserId = interaction.user.id;
        const itemId = interaction.options.getString('itemid');
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const targetUserId = targetUser.id;

        // Check if the user is the bot owner (your user ID)
        const BOT_OWNER_ID = '1329002833575673856';
        if (adminUserId !== BOT_OWNER_ID) {
            await interaction.reply({ 
                content: '❌ This command is restricted to the bot owner only.', 
                ephemeral: true 
            });
            return;
        }

        // Check if channel is whitelisted
        const { rows: whitelistRows } = await db.query(
            'SELECT 1 FROM whitelisted_channels WHERE guild_id = $1 AND channel_id = $2',
            [guildId, channelId]
        );
        if (whitelistRows.length === 0) {
            await interaction.reply({ 
                content: '❌ This channel is not whitelisted for tracking commands. Please ask an admin to use /whitelistchannel.', 
                ephemeral: true 
            });
            return;
        }

        await interaction.deferReply();

        try {
            // Check if the item is being tracked by the target user
            const { rows: trackedRows } = await db.query(
                'SELECT * FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND item_id = $4',
                [guildId, channelId, targetUserId, itemId]
            );

            if (trackedRows.length === 0) {
                await interaction.editReply({
                    content: `❌ ${targetUser} is not tracking item ID **${itemId}** in this channel.`,
                    ephemeral: true
                });
                return;
            }

            // Remove the tracked item
            await db.query(
                'DELETE FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND item_id = $4',
                [guildId, channelId, targetUserId, itemId]
            );

            // Create embed for confirmation
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('🛑 Admin: Item Tracking Stopped')
                .setDescription(`Item ID **${itemId}** is no longer being tracked for ${targetUser} in this channel.`)
                .addFields(
                    { name: 'Target User', value: `${targetUser} (${targetUserId})`, inline: true },
                    { name: 'Item ID', value: itemId, inline: true },
                    { name: 'Channel', value: `<#${channelId}>`, inline: true }
                )
                .setFooter({ text: 'Admin tracking stopped', iconURL: 'https://www.rolimons.com/favicon.ico' })
                .setTimestamp();

            await interaction.editReply({
                content: `✅ **Admin Action**: Item ID **${itemId}** has been removed from ${targetUser}'s tracking list!`,
                embeds: [embed]
            });

        } catch (error) {
            console.error('Error removing tracked item:', error);
            await interaction.editReply({
                content: `❌ Error: please contact admin`,
                ephemeral: true
            });
        }
    },
}; 