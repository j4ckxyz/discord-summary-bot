import { SlashCommandBuilder } from 'discord.js';
import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import requestQueueService from '../services/requestQueue.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

export default {
  data: new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Generate an AI summary of recent messages in this channel')
    .addStringOption(option =>
      option.setName('target')
        .setDescription('Number of messages (e.g. 500) or user mention/ID to summarise')
        .setRequired(false)
    ),

  async execute(interaction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const channel = interaction.channel;
      const targetInput = interaction.options.getString('target');

      // Check for help command
      if (targetInput && targetInput.toLowerCase() === 'help') {
        const helpMessage = `**Discord Summary Bot - Help**

**Basic Usage:**
\`/summary\` - Summarise messages since last summary (min ${config.minMessagesForSummary} messages)
\`!summary\` or \`@${interaction.client.user.username}\` - Same as above

**Advanced Options:**
\`/summary target:500\` - Summarise the last 500 messages
\`/summary target:50000\` - Summarise the last 50,000 messages (up to 100k supported)
\`/summary target:@user\` - Summarise a user's 50 most recent messages
\`/summary target:<userID>\` - Same as above, using Discord user ID

**Prefix Commands:**
\`!summary 500\` - Summarise the last 500 messages
\`!summary @user\` - Summarise a user's 50 most recent messages

**Rate Limits:**
• ${config.maxUsesPerWindow} summaries per ${config.cooldownMinutes} minutes per channel
• Summaries are capped at ${config.maxSummaryLength} characters (for small requests)

**Tips:**
• User summaries focus only on that user's messages
• All summaries are neutral and objective
• Large message counts use hierarchical summarization for efficiency`;

        await interaction.reply({ content: helpMessage, ephemeral: true });
        return;
      }

      // Parse the target input to determine if it's a message count or user ID
      let summaryMode = 'default'; // default, count, or user
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
          // Try to extract user ID from mention format <@123456789>
          const mentionMatch = targetInput.match(/^<@!?(\d+)>$/);
          if (mentionMatch) {
            summaryMode = 'user';
            targetValue = mentionMatch[1];
          } else {
            await interaction.reply({
              content: 'Invalid input. Please provide either a number of messages (e.g. 500), a user mention/ID, or "help" for usage information.',
              ephemeral: true
            });
            return;
          }
        }
      }

      // Check rate limit
      const rateLimitCheck = rateLimitService.checkRateLimit(userId, guildId, channelId);
      
      if (!rateLimitCheck.allowed) {
        const timeRemaining = rateLimitService.formatRemainingTime(rateLimitCheck.timeUntilNextUse);
        await interaction.reply({
          content: `You've reached your limit of summaries. Please wait ${timeRemaining} before requesting another summary.`,
          ephemeral: true
        });
        return;
      }

      // Defer reply as this might take a while
      await interaction.deferReply();

      // Request a slot in the queue
      const slot = await requestQueueService.requestSlot(channelId, userId);
      
      if (slot.queued) {
        // Notify user they're in the queue
        await interaction.editReply(`Your request is queued, position ${slot.position}. Please wait...`);
        
        // Wait for our turn
        await requestQueueService.waitForSlot(slot.requestId);
        
        // Update message now that we're starting
        await interaction.editReply('Starting summary... fetching messages...');
      }

      try {
        // Generate and post summary - pass interaction for progress updates
        const result = await summariserService.generateAndPostSummary(
          channel, 
          guildId, 
          interaction.client.user.id,
          summaryMode,
          targetValue,
          interaction,  // Pass interaction so we can update the deferred reply with progress
          userId  // Pass requester ID for @mention notification
        );

        // Release the slot
        requestQueueService.releaseSlot(slot.requestId);

        if (!result.success) {
          await interaction.editReply(result.error);
          return;
        }

        // Update cooldown
        rateLimitService.updateCooldown(userId, guildId, channelId);

        // Confirm to user (ephemeral)
        let confirmMessage = `Summary generated! Summarised ${result.messageCount} message${result.messageCount !== 1 ? 's' : ''}.`;
        
        if (summaryMode === 'user') {
          confirmMessage = `Summary generated! Summarised ${result.messageCount} message${result.messageCount !== 1 ? 's' : ''} from the specified user.`;
        } else if (summaryMode === 'count') {
          confirmMessage = `Summary generated! Summarised ${result.messageCount} message${result.messageCount !== 1 ? 's' : ''} from the last ${targetValue} messages.`;
        }
        
        confirmMessage += ` You have ${rateLimitCheck.remainingUses - 1} summaries remaining in the next 30 minutes.`;

        await interaction.editReply({
          content: confirmMessage
        });

        logger.info(`Summary created by ${interaction.user.tag} in ${interaction.guild.name}/#${channel.name} (mode: ${summaryMode})`);
      } catch (summaryError) {
        // Release the slot on error
        requestQueueService.releaseSlot(slot.requestId);
        throw summaryError;
      }

    } catch (error) {
      logger.error('Error executing summarise command:', error);
      
      const errorMessage = 'An error occurred while generating the summary. Please try again later.';
      
      if (interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }
};

