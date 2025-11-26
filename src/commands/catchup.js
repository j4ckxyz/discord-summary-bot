import { SlashCommandBuilder } from 'discord.js';
import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import requestQueueService from '../services/requestQueue.js';
import messageCacheService from '../services/messageCache.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

export default {
  data: new SlashCommandBuilder()
    .setName('catchup')
    .setDescription('Get a summary of what you missed while you were away')
    .addStringOption(option =>
      option.setName('since')
        .setDescription('Time period: "auto" (detect), "1h", "6h", "12h", "24h", "48h", "7d"')
        .setRequired(false)
        .addChoices(
          { name: 'Auto-detect (since your last message)', value: 'auto' },
          { name: 'Last 1 hour', value: '1h' },
          { name: 'Last 6 hours', value: '6h' },
          { name: 'Last 12 hours', value: '12h' },
          { name: 'Last 24 hours', value: '24h' },
          { name: 'Last 48 hours', value: '48h' },
          { name: 'Last 7 days', value: '7d' }
        )
    ),

  async execute(interaction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const channel = interaction.channel;
      const since = interaction.options.getString('since') || 'auto';

      // Check rate limit
      const rateLimitCheck = rateLimitService.checkRateLimit(userId, guildId, channelId);
      
      if (!rateLimitCheck.allowed) {
        const timeRemaining = rateLimitService.formatRemainingTime(rateLimitCheck.timeUntilNextUse);
        await interaction.reply({
          content: `You've reached your limit. Please wait ${timeRemaining} before requesting another summary.`,
          ephemeral: true
        });
        return;
      }

      // Defer reply as this might take a while
      await interaction.deferReply();

      // Request a slot in the queue
      const slot = await requestQueueService.requestSlot(channelId, userId);
      
      if (slot.queued) {
        await interaction.editReply(`Your request is queued, position ${slot.position}. Please wait...`);
        await requestQueueService.waitForSlot(slot.requestId);
        await interaction.editReply('Starting catchup... analyzing your absence...');
      }

      try {
        // Determine the time range
        let sinceTimestamp;
        let sinceDescription;

        if (since === 'auto') {
          // Find the user's last message in this channel
          const lastUserMessage = messageCacheService.getLastUserMessage(channelId, userId);
          
          if (lastUserMessage) {
            sinceTimestamp = lastUserMessage.created_at;
            const hoursAgo = Math.round((Date.now() / 1000 - sinceTimestamp) / 3600);
            sinceDescription = hoursAgo > 24 
              ? `${Math.round(hoursAgo / 24)} day(s) ago` 
              : `${hoursAgo} hour(s) ago`;
          } else {
            // Default to 24 hours if no message found
            sinceTimestamp = Math.floor(Date.now() / 1000) - (24 * 3600);
            sinceDescription = '24 hours (no recent activity found)';
          }
        } else {
          // Parse the time period
          const timeMap = {
            '1h': 3600,
            '6h': 6 * 3600,
            '12h': 12 * 3600,
            '24h': 24 * 3600,
            '48h': 48 * 3600,
            '7d': 7 * 24 * 3600
          };
          sinceTimestamp = Math.floor(Date.now() / 1000) - timeMap[since];
          sinceDescription = since;
        }

        await interaction.editReply(`Catching you up on messages since ${sinceDescription}...`);

        // Generate catchup summary
        const result = await summariserService.generateCatchupSummary(
          channel,
          guildId,
          interaction.client.user.id,
          userId,
          sinceTimestamp,
          interaction
        );

        // Release the slot
        requestQueueService.releaseSlot(slot.requestId);

        if (!result.success) {
          await interaction.editReply(result.error);
          return;
        }

        // Update cooldown
        rateLimitService.updateCooldown(userId, guildId, channelId);

        await interaction.editReply({
          content: `Catchup complete! Summarised ${result.messageCount} messages from ${sinceDescription}. You have ${rateLimitCheck.remainingUses - 1} requests remaining.`
        });

        logger.info(`Catchup created by ${interaction.user.tag} in ${interaction.guild.name}/#${channel.name} (since: ${sinceDescription})`);
      } catch (summaryError) {
        requestQueueService.releaseSlot(slot.requestId);
        throw summaryError;
      }

    } catch (error) {
      logger.error('Error executing catchup command:', error);
      
      const errorMessage = 'An error occurred while generating the catchup. Please try again later.';
      
      if (interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }
};
