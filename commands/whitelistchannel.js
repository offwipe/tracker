const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('whitelistchannel')
    .setDescription('Whitelist this channel for item tracking commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const channelId = interaction.channel.id;
    const guildId = interaction.guild.id;

    try {
      await db.query(
        'INSERT INTO whitelisted_channels (guild_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [guildId, channelId]
      );
      await interaction.reply({ content: `✅ This channel is now whitelisted for tracking commands.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to whitelist this channel.', ephemeral: true });
    }
  },
}; 