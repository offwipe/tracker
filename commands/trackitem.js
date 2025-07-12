const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trackitem')
        .setDescription('Track Roblox item trades from Rolimon\'s')
        .addStringOption(option =>
            option.setName('itemid')
                .setDescription('The Roblox item ID to track')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();
        
        const itemId = interaction.options.getString('itemid');
        
        try {
            // Fetch the Rolimon's page
            const response = await axios.get(`https://www.rolimons.com/itemtrades/${itemId}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });

            const $ = cheerio.load(response.data);
            
            // Extract item information
            const itemName = $('h1').first().text().trim() || 'Unknown Item';
            const itemImage = $('img[src*="/items/"]').first().attr('src');
            
            // Find request trades (people wanting to buy)
            const requestTrades = [];
            
            // Look for trade entries that indicate requests
            $('.trade-entry, .trade-item, [class*="trade"]').each((index, element) => {
                const text = $(element).text().toLowerCase();
                const html = $(element).html();
                
                // Check if this is a request (someone wanting to buy)
                if (text.includes('request') || text.includes('want') || text.includes('buying') || 
                    html.includes('request') || html.includes('want') || html.includes('buying')) {
                    
                    const tradeText = $(element).text().trim();
                    if (tradeText && tradeText.length > 10) {
                        requestTrades.push(tradeText);
                    }
                }
            });
            
            // If we didn't find specific request trades, try to extract general trade information
            if (requestTrades.length === 0) {
                $('div, span, p').each((index, element) => {
                    const text = $(element).text().trim();
                    if (text.includes('R$') || text.includes('Robux') || text.includes('trade')) {
                        if (text.length > 20 && text.length < 500) {
                            requestTrades.push(text);
                        }
                    }
                });
            }
            
            // Limit to first 10 trades to avoid embed overflow
            const limitedTrades = requestTrades.slice(0, 10);
            
            // Create embed
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle(`📊 Item Trade Tracker: ${itemName}`)
                .setDescription(`Tracking trades for item ID: **${itemId}**`)
                .setURL(`https://www.rolimons.com/itemtrades/${itemId}`)
                .setTimestamp()
                .setFooter({ text: 'Data from Rolimon\'s', iconURL: 'https://www.rolimons.com/favicon.ico' });
            
            if (itemImage) {
                embed.setThumbnail(itemImage);
            }
            
            if (limitedTrades.length > 0) {
                const tradesText = limitedTrades.map((trade, index) => 
                    `${index + 1}. ${trade.substring(0, 100)}${trade.length > 100 ? '...' : ''}`
                ).join('\n\n');
                
                embed.addFields({
                    name: '🛒 Recent Request Trades',
                    value: tradesText.length > 1024 ? tradesText.substring(0, 1021) + '...' : tradesText,
                    inline: false
                });
            } else {
                embed.addFields({
                    name: '🛒 Request Trades',
                    value: 'No recent request trades found for this item.',
                    inline: false
                });
            }
            
            // Add item info if available
            const itemInfo = $('p, span').filter((i, el) => {
                const text = $(el).text();
                return text.includes('R$') || text.includes('Value') || text.includes('Price');
            }).first().text().trim();
            
            if (itemInfo) {
                embed.addFields({
                    name: '💰 Item Value',
                    value: itemInfo,
                    inline: true
                });
            }
            
            await interaction.editReply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error fetching item data:', error);
            await interaction.editReply({
                content: `❌ Error fetching data for item ID ${itemId}. Please check if the item ID is valid and try again.`,
                ephemeral: true
            });
        }
    },
}; 