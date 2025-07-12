const { SlashCommandBuilder } = require('discord.js');
const db = require('../db');
const axios = require('axios');
const cheerio = require('cheerio');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listtracked')
    .setDescription('List all currently tracked items in this server'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const { rows } = await db.query(
      'SELECT DISTINCT item_id FROM tracked_items WHERE guild_id = $1',
      [guildId]
    );
    if (rows.length === 0) {
      await interaction.reply('No items are currently being tracked in this server.');
      return;
    }
    // Fetch item names for each item_id
    const itemInfos = await Promise.all(rows.map(async ({ item_id }) => {
      try {
        const response = await axios.get(`https://www.rolimons.com/itemtrades/${item_id}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        const $ = cheerio.load(response.data);
        const itemName = $('h1').first().text().trim() || item_id;
        return `- ${itemName} (ID: ${item_id})`;
      } catch {
        return `- Unknown Item (ID: ${item_id})`;
      }
    }));
    await interaction.reply(`Currently tracked items:\n${itemInfos.join('\n')}`);
  },
}; 