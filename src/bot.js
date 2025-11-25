import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import logger from './utils/logger.js';
import summariseCommand from './commands/summarise.js';

// Validate environment variables
if (!process.env.DISCORD_BOT_TOKEN) {
  logger.error('DISCORD_BOT_TOKEN is required in .env file');
  process.exit(1);
}

if (!process.env.LLM_API_KEY) {
  logger.error('LLM_API_KEY is required in .env file');
  process.exit(1);
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Commands collection
const commands = [summariseCommand];

// Register slash commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  
  try {
    logger.info('Started refreshing application (/) commands.');

    const commandsData = commands.map(cmd => cmd.data.toJSON());
    
    logger.info(`Registering ${commandsData.length} command(s): ${commandsData.map(c => c.name).join(', ')}`);

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandsData }
    );

    logger.info('Successfully reloaded application (/) commands.');
  } catch (error) {
    logger.error('Error registering commands:', error);
  }
}

// Event: Bot is ready
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Bot is active in ${client.guilds.cache.size} server(s)`);
  
  // Register slash commands
  await registerCommands();
  
  logger.info('Bot is ready to summarise!');
});

// Event: Interaction created (slash commands)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.find(cmd => cmd.data.name === interaction.commandName);

  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Error executing ${interaction.commandName}:`, error);
    
    const errorMessage = 'There was an error executing this command.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMessage, ephemeral: true });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// Event: Error handling
client.on('error', (error) => {
  logger.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);
