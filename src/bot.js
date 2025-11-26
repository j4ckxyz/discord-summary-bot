import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import logger from './utils/logger.js';
import summariseCommand from './commands/summarise.js';
import catchupCommand from './commands/catchup.js';
import topicCommand from './commands/topic.js';
import explainCommand from './commands/explain.js';
import rateLimitService from './services/ratelimit.js';
import summariserService from './services/summariser.js';
import messageCacheService from './services/messageCache.js';
import requestQueueService from './services/requestQueue.js';
import { config } from './utils/config.js';

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
const commands = [summariseCommand, catchupCommand, topicCommand, explainCommand];

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

  // Ignore @everyone and @here
  if (message.mentions.everyone) return;

  const isMention = message.mentions.has(client.user);
  const isPrefix = message.content.startsWith('!summary');

  if (!isMention && !isPrefix) return;

  // Ignore replies to the bot
  if (message.reference) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.id === client.user.id) return;
    } catch (error) {
      // If we can't fetch the message, just proceed
      logger.warn(`Could not fetch referenced message for reply check: ${error.message}`);
    }
  }

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
  } else if (isMention) {
    // For mentions, get everything after the mention
    const parts = message.content.split(/\s+/);
    if (parts.length > 1) {
      targetInput = parts[1];
    }
  }

  // Check for help command
  if (targetInput && targetInput.toLowerCase() === 'help') {
    const helpMessage = `**Discord Summary Bot - Help**

**Basic Usage:**
\`!summary\` or \`/summary\` - Summarise messages since last summary (min ${config.minMessagesForSummary} messages)
\`@${client.user.username} help\` - Show this help message

**Advanced Options:**
\`!summary 500\` - Summarise the last 500 messages
\`!summary 50000\` - Summarise the last 50,000 messages (up to 100k supported)
\`!summary @user\` - Summarise a user's 50 most recent messages
\`!summary <userID>\` - Same as above, using Discord user ID

**Rate Limits:**
• ${config.maxUsesPerWindow} summaries per ${config.cooldownMinutes} minutes per channel
• Summaries are capped at ${config.maxSummaryLength} characters (for small requests)

**Tips:**
• User summaries focus only on that user's messages
• All summaries are neutral and objective
• Large message counts use hierarchical summarization for efficiency`;

    await message.reply(helpMessage);
    return;
  }

  // Parse the target input to determine if it's a message count or user ID
  let summaryMode = 'default';
  let targetValue = null;
  
  if (targetInput) {
    const numericValue = parseInt(targetInput, 10);
    
    // Discord user IDs are 17-19 digits (snowflakes)
    // Message counts can be up to 100k
    if (!isNaN(numericValue)) {
      if (targetInput.length >= 17 && numericValue > 100000) {
        // Likely a user ID (Discord snowflake) - 17+ digits
        summaryMode = 'user';
        targetValue = targetInput;
      } else {
        // Message count - cap at 100k
        summaryMode = 'count';
        targetValue = Math.min(Math.max(numericValue, 1), 100000);
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
    const thinkingMsg = await message.reply('Starting summary... fetching messages...');

    logger.info(`Starting summary request: mode=${summaryMode}, targetValue=${targetValue}, user=${message.author.tag}`);

    // Request a slot in the queue
    const slot = await requestQueueService.requestSlot(channelId, userId);
    
    if (slot.queued) {
      // Notify user they're in the queue
      await thinkingMsg.edit(`Your request is queued, position ${slot.position}. Please wait...`);
      
      // Wait for our turn
      await requestQueueService.waitForSlot(slot.requestId);
      
      // Update message now that we're starting
      await thinkingMsg.edit('Starting summary... fetching messages...');
    }

    try {
      // Generate and post summary - pass the thinking message to edit it
      const result = await summariserService.generateAndPostSummary(
        channel, 
        guildId, 
        client.user.id,
        summaryMode,
        targetValue,
        thinkingMsg,
        userId  // Pass requester ID for @mention notification
      );

      // Release the slot
      requestQueueService.releaseSlot(slot.requestId);

      if (!result.success) {
        await thinkingMsg.edit(result.error);
        return;
      }

      // Update cooldown
      rateLimitService.updateCooldown(userId, guildId, channelId);

      logger.info(`Summary created by ${message.author.tag} in ${message.guild.name}/#${channel.name} (via ${isMention ? 'mention' : 'prefix'}, mode: ${summaryMode})`);
    } catch (summaryError) {
      // Release the slot on error
      requestQueueService.releaseSlot(slot.requestId);
      logger.error('Error generating summary:', summaryError);
      try {
        await thinkingMsg.edit('An error occurred while generating the summary. Please try again with a smaller message count.');
      } catch (editError) {
        logger.error('Could not edit thinking message:', editError);
      }
      return;
    }
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
  
  // Start cache maintenance (cleanup old messages daily)
  messageCacheService.startMaintenanceSchedule();
  
  logger.info('Bot is ready to summarise!');
  logger.info('Commands: /summary, !summary, @mention');
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

// Event: Message created (for prefix and mention commands, and caching)
client.on('messageCreate', (message) => {
  // Cache the message if caching is enabled (ignore bots)
  if (!message.author.bot && message.guild) {
    messageCacheService.cacheMessage(message);
  }
  
  // Handle text commands
  handleTextCommand(message);
});

// Event: Message deleted (update cache)
client.on('messageDelete', (message) => {
  if (message.guild) {
    messageCacheService.markMessageDeleted(message.id);
  }
});

// Event: Message updated (update cache)
client.on('messageUpdate', (oldMessage, newMessage) => {
  if (newMessage.guild && !newMessage.author?.bot) {
    messageCacheService.updateMessage(newMessage);
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
