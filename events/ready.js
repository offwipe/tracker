const { Events } = require('discord.js');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`✅ ${client.user.tag} is online and ready!`);
        
        // Register slash commands
        const { REST, Routes } = require('discord.js');
        const fs = require('fs');
        const path = require('path');
        
        const commands = [];
        const commandsPath = path.join(__dirname, '..', 'commands');
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            commands.push(command.data.toJSON());
        }
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        (async () => {
            try {
                console.log('🔄 Started refreshing application (/) commands.');
                
                await rest.put(
                    Routes.applicationCommands(client.user.id),
                    { body: commands },
                );
                
                console.log('✅ Successfully reloaded application (/) commands.');
            } catch (error) {
                console.error('❌ Error refreshing commands:', error);
            }
        })();
    },
}; 