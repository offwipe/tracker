const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forward2dms')
        .setDescription('Toggle DM forwarding for your tracked items')
        .addStringOption(option =>
            option.setName('itemid')
                .setDescription('The Roblox item ID to toggle DM forwarding for (optional - affects all items if not specified)')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('enabled')
                .setDescription('Enable or disable DM forwarding (default: true)')
                .setRequired(false)),

    async execute(interaction) {
        const channelId = interaction.channel.id;
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const itemId = interaction.options.getString('itemid');
        const enabled = interaction.options.getBoolean('enabled') ?? true;

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
            if (itemId) {
                // Toggle DM forwarding for specific item
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

                // Update the specific item's DM forwarding setting
                await db.query(
                    'UPDATE tracked_items SET forward_to_dms = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
                    [enabled, guildId, channelId, userId, itemId]
                );

                const embed = new EmbedBuilder()
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setTitle(enabled ? '📬 DM Forwarding Enabled' : '📭 DM Forwarding Disabled')
                    .setDescription(`DM forwarding for item ID **${itemId}** has been ${enabled ? 'enabled' : 'disabled'}.`)
                    .setFooter({ text: 'DM forwarding updated', iconURL: 'https://www.rolimons.com/favicon.ico' })
                    .setTimestamp();

                await interaction.editReply({
                    content: `${interaction.user}, DM forwarding for item ID **${itemId}** has been ${enabled ? 'enabled' : 'disabled'}!`,
                    embeds: [embed]
                });

            } else {
                // Toggle DM forwarding for all tracked items by this user
                const { rows: trackedRows } = await db.query(
                    'SELECT * FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3',
                    [guildId, channelId, userId]
                );

                if (trackedRows.length === 0) {
                    await interaction.editReply({
                        content: `❌ You are not tracking any items in this channel.`,
                        ephemeral: true
                    });
                    return;
                }

                // Update all items' DM forwarding setting
                await db.query(
                    'UPDATE tracked_items SET forward_to_dms = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4',
                    [enabled, guildId, channelId, userId]
                );

                // Create a list of tracked item IDs for display
                const itemIds = trackedRows.map(row => row.item_id).join(', ');
                
                const embed = new EmbedBuilder()
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setTitle(enabled ? '📬 DM Forwarding Enabled' : '📭 DM Forwarding Disabled')
                    .setDescription(`DM forwarding has been ${enabled ? 'enabled' : 'disabled'} for all your tracked items.`)
                    .addFields(
                        { name: 'Items Affected', value: `${trackedRows.length} items`, inline: true },
                        { name: 'Item IDs', value: itemIds.length > 100 ? itemIds.substring(0, 97) + '...' : itemIds, inline: false }
                    )
                    .setFooter({ text: 'DM forwarding updated', iconURL: 'https://www.rolimons.com/favicon.ico' })
                    .setTimestamp();

                await interaction.editReply({
                    content: `${interaction.user}, DM forwarding has been ${enabled ? 'enabled' : 'disabled'} for all your tracked items!`,
                    embeds: [embed]
                });
            }

        } catch (error) {
            console.error('Error updating DM forwarding:', error);
            await interaction.editReply({
                content: `error: please contact admin`,
                ephemeral: true
            });
        }
    },
}; 