import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import logger from './utils/logger.js';
import summariseCommand from './commands/summarise.js';
import rateLimitService from './services/ratelimit.js';
import summariserService from './services/summariser.js';

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

// Handle prefix and mention-based commands
async function handleTextCommand(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  const isMention = message.mentions.has(client.user);
  const isPrefix = message.content.startsWith('!summarise') || message.content.startsWith('!summary');

  if (!isMention && !isPrefix) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const channel = message.channel;

  // Parse target input from message content
  let targetInput = null;
  if (isPrefix) {
    const parts = message.content.split(/\s+/);
    if (parts.length > 1) {
      targetInput = parts[1];
    }
  }

  // Parse the target input to determine if it's a message count or user ID
  let summaryMode = 'default';
  let targetValue = null;
  
  if (targetInput) {
    const numericValue = parseInt(targetInput, 10);
    
    if (!isNaN(numericValue)) {
      if (numericValue > 10000) {
        summaryMode = 'user';
        targetValue = targetInput;
      } else {
        summaryMode = 'count';
        targetValue = Math.min(numericValue, 1000);
      }
    } else {
      const mentionMatch = targetInput.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        summaryMode = 'user';
        targetValue = mentionMatch[1];
      }
    }
  }

  try {
    // Check rate limit
    const rateLimitCheck = rateLimitService.checkRateLimit(userId, guildId, channelId);
    
    if (!rateLimitCheck.allowed) {
      const timeRemaining = rateLimitService.formatRemainingTime(rateLimitCheck.timeUntilNextUse);
      await message.reply(`You've reached your limit of summaries. Please wait ${timeRemaining} before requesting another summary.`);
      return;
    }

    // Send thinking message
    const thinkingMsg = await message.reply('Generating summary...');

    // Generate and post summary - pass the thinking message to edit it
    const result = await summariserService.generateAndPostSummary(
      channel, 
      guildId, 
      client.user.id,
      summaryMode,
      targetValue,
      thinkingMsg
    );

    if (!result.success) {
      await thinkingMsg.edit(result.error);
      return;
    }

    // Update cooldown
    rateLimitService.updateCooldown(userId, guildId, channelId);

    logger.info(`Summary created by ${message.author.tag} in ${message.guild.name}/#${channel.name} (via ${isMention ? 'mention' : 'prefix'}, mode: ${summaryMode})`);

  } catch (error) {
    logger.error('Error handling text command:', error);
    await message.reply('An error occurred while generating the summary. Please try again later.');
  }
}

// Event: Bot is ready
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Bot is active in ${client.guilds.cache.size} server(s)`);
  
  // Register slash commands
  await registerCommands();
  
  logger.info('Bot is ready to summarise!');
  logger.info('Commands: /summarise, !summarise, !summary, @mention');
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

// Event: Message created (for prefix and mention commands)
client.on('messageCreate', handleTextCommand);

// Event: Error handling
client.on('error', (error) => {
  logger.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);
