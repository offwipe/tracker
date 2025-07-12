const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mytracked')
        .setDescription('Show your currently tracked items and their DM forwarding status'),

    async execute(interaction) {
        const channelId = interaction.channel.id;
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

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
            // Get all tracked items for this user in this channel
            const { rows: trackedRows } = await db.query(
                'SELECT item_id, forward_to_dms, tracking_started_at FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 ORDER BY tracking_started_at DESC',
                [guildId, channelId, userId]
            );

            if (trackedRows.length === 0) {
                await interaction.editReply({
                    content: `❌ You are not tracking any items in this channel.`,
                    ephemeral: true
                });
                return;
            }

            // Create embed with tracked items
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📊 Your Tracked Items')
                .setDescription(`You are tracking **${trackedRows.length}** items in this channel.`)
                .setFooter({ text: 'Tracked Items', iconURL: 'https://www.rolimons.com/favicon.ico' })
                .setTimestamp();

            // Group items by DM forwarding status
            const dmEnabled = trackedRows.filter(row => row.forward_to_dms);
            const dmDisabled = trackedRows.filter(row => !row.forward_to_dms);

            if (dmEnabled.length > 0) {
                const enabledIds = dmEnabled.map(row => row.item_id).join(', ');
                embed.addFields({
                    name: `📬 DM Forwarding Enabled (${dmEnabled.length})`,
                    value: enabledIds.length > 100 ? enabledIds.substring(0, 97) + '...' : enabledIds,
                    inline: false
                });
            }

            if (dmDisabled.length > 0) {
                const disabledIds = dmDisabled.map(row => row.item_id).join(', ');
                embed.addFields({
                    name: `📭 DM Forwarding Disabled (${dmDisabled.length})`,
                    value: disabledIds.length > 100 ? disabledIds.substring(0, 97) + '...' : disabledIds,
                    inline: false
                });
            }

            // Add usage tips
            embed.addFields({
                name: '💡 Usage Tips',
                value: '• Use `/forward2dms` to enable DM forwarding for all items\n• Use `/forward2dms itemid:123456789` for specific items\n• Use `/untrack itemid:123456789` to stop tracking an item',
                inline: false
            });

            await interaction.editReply({
                content: `${interaction.user}, here are your tracked items:`,
                embeds: [embed]
            });

        } catch (error) {
            console.error('Error fetching tracked items:', error);
            await interaction.editReply({
                content: `error: please contact admin`,
                ephemeral: true
            });
        }
    },
}; 