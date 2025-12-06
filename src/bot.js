import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import logger from './utils/logger.js';
import summariseCommand from './commands/summarise.js';
import catchupCommand from './commands/catchup.js';
import topicCommand from './commands/topic.js';
import explainCommand from './commands/explain.js';
import remindCommand from './commands/remind.js';
import todoCommand from './commands/todo.js';

import eventCommand from './commands/event.js';
import configCommand from './commands/config.js';
import pollCommand from './commands/poll.js';
import timerCommand from './commands/timer.js';
import funCommand from './commands/fun.js';
import freesCommand from './commands/frees.js';
import searchCommand from './commands/search.js';
import imposterCommand from './commands/imposter.js';
import imposterService from './services/imposter.js';
import SchedulerService from './services/scheduler.js';
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

// Services
const scheduler = new SchedulerService(client);

// Commands collection
const commands = [
  summariseCommand,
  catchupCommand,
  topicCommand,
  explainCommand,
  remindCommand,
  todoCommand,

  eventCommand,
  configCommand,
  pollCommand,
  timerCommand,
  funCommand,
  freesCommand,
  searchCommand,
  imposterCommand
];

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

  const content = message.content.trim();
  const isMention = message.mentions.has(client.user);

  // Check for prefix commands
  const prefixCommands = ['!summary', '!catchup', '!topic', '!explain'];
  const matchedPrefix = prefixCommands.find(p => content.toLowerCase().startsWith(p));

  if (!isMention && !matchedPrefix) return;

  // Ignore replies to the bot
  if (message.reference) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.id === client.user.id) return;
    } catch (error) {
      logger.warn(`Could not fetch referenced message for reply check: ${error.message}`);
    }
  }

  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const channel = message.channel;

  // Parse the command and arguments
  let command = 'summary'; // default
  let args = [];

  // Handle mention-based commands
  if (isMention) {
    const mentionRegex = new RegExp(`^<@!?${client.user.id}>\\s*`);
    const contentWithoutMention = message.content.replace(mentionRegex, '').trim();
    const args = contentWithoutMention.split(/\s+/);
    const commandName = args[0]?.toLowerCase(); // e.g. "summary" or "remind"

    // Smart detection for natural language "remind me"
    if (contentWithoutMention.toLowerCase().startsWith('remind me') || contentWithoutMention.toLowerCase().startsWith('remind')) {
      // Strip "remind me" or "remind" and pass rest to remind command
      let remindArgs = args.slice(1);
      if (args[0].toLowerCase() === 'remind' && args[1]?.toLowerCase() === 'me') {
        remindArgs = args.slice(2);
      } else if (args[0].toLowerCase() === 'remind') {
        remindArgs = args.slice(1);
      }

      return remindCommand.executeText(message, remindArgs);
    }

    // Check if first word matches a known command
    if (commandName === 'summary' || commandName === 'summarise') {
      return handleSummaryCommand(message, message.channel, guildId, userId, message.channel.id, args.slice(1), true);
    }
    if (commandName === 'catchup') {
      return handleCatchupCommand(message, message.channel, guildId, userId, message.channel.id, args.slice(1));
    }
    if (commandName === 'todo') {
      return todoCommand.executeText(message, args.slice(1));
    }
    if (commandName === 'event') {
      return eventCommand.executeText(message, args.slice(1));
    }
    if (commandName === 'timer') {
      return timerCommand.executeText(message, args.slice(1));
    }
    if (commandName === 'roll' || commandName === 'flip') {
      return funCommand.executeText(message, args);
    }
    if (commandName === 'search') {
      return searchCommand.executeText(message, args);
    }

    // Check for help command
    if (command === 'help' || (args.length > 0 && args[0].toLowerCase() === 'help')) {
      const helpMessage = `**Discord Summary Bot - Help**

**Summary Commands:**
\`!summary\` or \`/summary\` - Summarise messages since last summary
\`!summary 500\` - Summarise the last 500 messages
\`!summary @user\` - Summarise a user's recent messages

**Catchup Commands:**
\`!catchup\` or \`/catchup\` - See what you missed (auto-detects your absence)
\`!catchup 24h\` - Catchup on the last 24 hours (options: 1h, 6h, 12h, 24h, 48h, 7d)

**Topic Commands:**
\`!topic <keyword>\` or \`/topic\` - Search and summarize discussions about a topic
\`!topic docker\` - Find all discussions about "docker"

**Explain Commands:**
\`!explain <topic>\` or \`/explain\` - Get help understanding a topic
\`!explain the migration\` - Explains what "the migration" is about

**Rate Limits:**
• ${config.maxUsesPerWindow} requests per ${config.cooldownMinutes} minutes per channel`;

      await message.reply(helpMessage);
      return;
    }

    // Check rate limit
    const rateLimitCheck = rateLimitService.checkRateLimit(userId, guildId, channelId);

    if (!rateLimitCheck.allowed) {
      const timeRemaining = rateLimitService.formatRemainingTime(rateLimitCheck.timeUntilNextUse);
      await message.reply(`You've reached your limit. Please wait ${timeRemaining} before requesting again.`);
      return;
    }

    // Handle different commands
    try {
      if (command === 'catchup') {
        await handleCatchupCommand(message, channel, guildId, userId, channelId, args);
      } else if (command === 'topic') {
        await handleTopicCommand(message, channel, guildId, userId, channelId, args);
      } else if (command === 'explain') {
        await handleExplainCommand(message, channel, guildId, userId, channelId, args);
      } else {
        await handleSummaryCommand(message, channel, guildId, userId, channelId, args, isMention);
      }

      // Update cooldown after successful command
      rateLimitService.updateCooldown(userId, guildId, channelId);
    } catch (error) {
      logger.error('Error handling text command:', error);
      await message.reply('An error occurred. Please try again later.');
    }
  }
}

// Handle !summary command
async function handleSummaryCommand(message, channel, guildId, userId, channelId, args, isMention) {
  let summaryMode = 'default';
  let targetValue = null;
  const targetInput = args[0];

  if (targetInput) {
    const numericValue = parseInt(targetInput, 10);

    if (!isNaN(numericValue)) {
      if (targetInput.length >= 17 && numericValue > 100000) {
        summaryMode = 'user';
        targetValue = targetInput;
      } else {
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

  const thinkingMsg = await message.reply('Starting summary... fetching messages...');
  logger.startOperation('SUMMARY', `mode=${summaryMode} | target=${targetValue} | user=${message.author.tag}`);

  const slot = await requestQueueService.requestSlot(channelId, userId);

  if (slot.queued) {
    logger.queue(`Request queued | position=${slot.position} | user=${message.author.tag}`);
    await thinkingMsg.edit(`Your request is queued, position ${slot.position}. Please wait...`);
    await requestQueueService.waitForSlot(slot.requestId);
    await thinkingMsg.edit('Starting summary... fetching messages...');
  }

  try {
    const result = await summariserService.generateAndPostSummary(
      channel, guildId, client.user.id, summaryMode, targetValue, thinkingMsg, userId
    );

    requestQueueService.releaseSlot(slot.requestId);

    if (!result.success) {
      await thinkingMsg.edit(result.error);
      return;
    }

    logger.cmd(`Summary complete | user=${message.author.tag} | guild=${message.guild.name} | channel=${channel.name} | mode=${summaryMode}`);
  } catch (error) {
    requestQueueService.releaseSlot(slot.requestId);
    logger.error('Error generating summary:', error);
    await thinkingMsg.edit('An error occurred. Please try again with a smaller message count.');
  }
}

// Handle !catchup command
async function handleCatchupCommand(message, channel, guildId, userId, channelId, args) {
  const thinkingMsg = await message.reply('Analyzing your absence...');

  const slot = await requestQueueService.requestSlot(channelId, userId);

  if (slot.queued) {
    await thinkingMsg.edit(`Your request is queued, position ${slot.position}. Please wait...`);
    await requestQueueService.waitForSlot(slot.requestId);
  }

  try {
    let sinceTimestamp;
    let sinceDescription;
    const timeArg = args[0]?.toLowerCase();

    if (timeArg && ['1h', '6h', '12h', '24h', '48h', '7d'].includes(timeArg)) {
      const timeMap = {
        '1h': 3600, '6h': 6 * 3600, '12h': 12 * 3600,
        '24h': 24 * 3600, '48h': 48 * 3600, '7d': 7 * 24 * 3600
      };
      sinceTimestamp = Math.floor(Date.now() / 1000) - timeMap[timeArg];
      sinceDescription = timeArg;
    } else {
      // Auto-detect
      const lastUserMessage = messageCacheService.getLastUserMessage(channelId, userId);
      if (lastUserMessage) {
        sinceTimestamp = lastUserMessage.created_at;
        const hoursAgo = Math.round((Date.now() / 1000 - sinceTimestamp) / 3600);
        sinceDescription = hoursAgo > 24 ? `${Math.round(hoursAgo / 24)} day(s)` : `${hoursAgo} hour(s)`;
      } else {
        sinceTimestamp = Math.floor(Date.now() / 1000) - (24 * 3600);
        sinceDescription = '24 hours (no recent activity found)';
      }
    }

    await thinkingMsg.edit(`Catching you up on messages from ${sinceDescription} ago...`);

    const result = await summariserService.generateCatchupSummary(
      channel, guildId, client.user.id, userId, sinceTimestamp, thinkingMsg
    );

    requestQueueService.releaseSlot(slot.requestId);

    if (!result.success) {
      await thinkingMsg.edit(result.error);
      return;
    }

    await thinkingMsg.edit(`Catchup complete! Summarised ${result.messageCount} messages.`);
    logger.info(`Catchup created by ${message.author.tag} in ${message.guild.name}/#${channel.name}`);
  } catch (error) {
    requestQueueService.releaseSlot(slot.requestId);
    logger.error('Error generating catchup:', error);
    await thinkingMsg.edit('An error occurred generating your catchup. Please try again.');
  }
}

// Handle !topic command
async function handleTopicCommand(message, channel, guildId, userId, channelId, args) {
  if (args.length === 0) {
    await message.reply('Please specify a topic to search for. Example: `!topic docker`');
    return;
  }

  const keyword = args.join(' ');
  const thinkingMsg = await message.reply(`Searching for discussions about "${keyword}"...`);

  const slot = await requestQueueService.requestSlot(channelId, userId);

  if (slot.queued) {
    await thinkingMsg.edit(`Your request is queued, position ${slot.position}. Please wait...`);
    await requestQueueService.waitForSlot(slot.requestId);
  }

  try {
    const result = await summariserService.generateTopicSummary(
      channel, guildId, client.user.id, keyword, 1000, thinkingMsg, userId
    );

    requestQueueService.releaseSlot(slot.requestId);

    if (!result.success) {
      await thinkingMsg.edit(result.error);
      return;
    }

    await thinkingMsg.edit(`Found ${result.matchCount} messages about "${keyword}".`);
    logger.info(`Topic search by ${message.author.tag} in ${message.guild.name}/#${channel.name} (keyword: ${keyword})`);
  } catch (error) {
    requestQueueService.releaseSlot(slot.requestId);
    logger.error('Error generating topic summary:', error);
    await thinkingMsg.edit('An error occurred searching for that topic. Please try again.');
  }
}

// Handle !explain command
async function handleExplainCommand(message, channel, guildId, userId, channelId, args) {
  if (args.length === 0) {
    await message.reply('Please specify what you want explained. Example: `!explain the database migration`');
    return;
  }

  const topic = args.join(' ');
  const thinkingMsg = await message.reply(`Analyzing discussions to explain "${topic}"...`);

  const slot = await requestQueueService.requestSlot(channelId, userId);

  if (slot.queued) {
    await thinkingMsg.edit(`Your request is queued, position ${slot.position}. Please wait...`);
    await requestQueueService.waitForSlot(slot.requestId);
  }

  try {
    const result = await summariserService.generateExplanation(
      channel, guildId, client.user.id, topic, 2000, thinkingMsg, userId
    );

    requestQueueService.releaseSlot(slot.requestId);

    if (!result.success) {
      await thinkingMsg.edit(result.error);
      return;
    }

    await thinkingMsg.edit(`Explanation complete! Analyzed ${result.matchCount} relevant messages.`);
    logger.info(`Explain request by ${message.author.tag} in ${message.guild.name}/#${channel.name} (topic: ${topic})`);
  } catch (error) {
    requestQueueService.releaseSlot(slot.requestId);
    logger.error('Error generating explanation:', error);
    await thinkingMsg.edit('An error occurred generating the explanation. Please try again.');
  }
}

// Event: Bot is ready
client.once('ready', async () => {
  logger.separator();
  logger.bot(`Logged in as ${client.user.tag}`);
  logger.bot(`Active in ${client.guilds.cache.size} server(s)`);
  logger.bot(`LLM Provider: ${process.env.LLM_PROVIDER || 'google'} | Model: ${process.env.LLM_MODEL || 'gemini-2.0-flash-exp'}`);
  logger.bot(`Embedding Model: ${process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small'}`);

  // Register slash commands
  await registerCommands();

  // Start cache maintenance (cleanup old messages daily)
  messageCacheService.startMaintenanceSchedule();

  logger.separator();
  logger.bot('Bot is ready! Commands: /summary, /remind, /todo, /event, /poll, /config, /topic, /catchup');
  logger.separator();
});

// Event: Interaction created (slash commands and buttons)
client.on('interactionCreate', async (interaction) => {
  // Handle Buttons
  if (interaction.isButton()) {
    const customId = interaction.customId;

    if (customId.startsWith('event_join_')) {
      const eventId = customId.replace('event_join_', '');
      // Since we can't easily import EventModel here without circular deps if not careful (though defined above),
      // or we just use the imported Model if it's available.
      // Note: we haven't imported EventModel here yet. Need to add import!
      // But wait, importing models.js is fine.

      try {
        // Dynamic import or ensure import at top. 
        // Models are usually safe to import.
        const { EventModel } = await import('./database/models.js');

        const res = EventModel.addAttendee(eventId, interaction.user.id);
        if (res === false) return interaction.reply({ content: '❌ Event not found or expired.', ephemeral: true });
        if (res.changes === 0) return interaction.reply({ content: '⚠️ You are already attending.', ephemeral: true });

        return interaction.reply({ content: '✅ You joined the event!', ephemeral: true });
      } catch (e) {
        logger.error('Button error', e);
        return interaction.reply({ content: '❌ Error joining event.', ephemeral: true });
      }
    }

    if (customId.startsWith('event_leave_')) {
      const eventId = customId.replace('event_leave_', '');
      try {
        const { EventModel } = await import('./database/models.js');
        const res = EventModel.removeAttendee(eventId, interaction.user.id);
        if (res === false) return interaction.reply({ content: '❌ Event not found.', ephemeral: true });

        return interaction.reply({ content: '👋 You left the event.', ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: '❌ Error leaving.', ephemeral: true });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.find(cmd => cmd.data.name === interaction.commandName);

  if (!command) {
    logger.cmd(`Unknown command: ${interaction.commandName}`, 'WARN');
    return;
  }

  try {
    logger.cmd(`/${interaction.commandName} | user=${interaction.user.tag} | guild=${interaction.guild?.name || 'DM'} | channel=${interaction.channel?.name || 'unknown'}`);
    await command.execute(interaction);
  } catch (error) {
    logger.cmd(`/${interaction.commandName} FAILED | error=${error.message}`, 'ERROR');

    const errorMessage = 'There was an error executing this command.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMessage, ephemeral: true });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// Helper to manage game flow (bot turns)
async function processGameLoop(channel) {
  const channelId = channel.id;

  // Safety break to prevent infinite loops if something breaks
  let safetyCounter = 0;

  while (imposterService.isBotTurn(channelId) && safetyCounter < 10) {
    safetyCounter++;

    // Simulate "thinking" time
    await channel.sendTyping();
    // Wait 1-2 seconds for realism
    await new Promise(r => setTimeout(r, 1500));

    const move = await imposterService.playBotTurn(channelId);
    if (move) {
      await channel.send(`🤖 **${move.name}** says: "${move.clue}"`);
    }
  }

  // Announce next human player
  const game = imposterService.getGame(channelId);
  if (game && game.status === 'PLAYING') {
    const nextPlayer = imposterService.getCurrentPlayer(channelId);
    if (!nextPlayer.isBot) {
      await channel.send(`👉 Your turn <@${nextPlayer.id}>!`);
    }
  }
}

// Event: Message created
client.on('messageCreate', async (message) => {
  // Cache the message if caching is enabled (ignore bots)
  if (!message.author.bot && message.guild) {
    messageCacheService.cacheMessage(message);
  }

  // Imposter Game Logic
  // Check if this message is a Move in the game
  const game = imposterService.getGame(message.channel.id);
  if (game && game.status === 'PLAYING' && !message.author.bot) {
    const result = imposterService.handleMessage(message.channel.id, message);

    if (result === 'OUT_OF_TURN') {
      try {
        await message.delete();
        const warning = await message.channel.send(`🤫 Shh <@${message.author.id}>! Wait for your turn.`);
        setTimeout(() => warning.delete().catch(() => { }), 3000);
      } catch (e) {
        await message.react('🤫').catch(() => { });
      }
      return; // Stop processing
    } else if (result === 'VALID_MOVE') {
      // Human moved. Now check if bots need to play
      await processGameLoop(message.channel);
      return;
    }
  }

  // Handle text commands
  handleTextCommand(message);
});

// Need to export this to allow the command to trigger it start
export { processGameLoop };


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

// Event: Custom Game Events
client.on('gameStart', async (channel) => {
  await processGameLoop(channel);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);
