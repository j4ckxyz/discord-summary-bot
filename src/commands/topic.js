import { SlashCommandBuilder } from 'discord.js';
import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import requestQueueService from '../services/requestQueue.js';
import logger from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('topic')
    .setDescription('Search and summarize discussions about a specific topic')
    .addStringOption(option =>
      option.setName('keyword')
        .setDescription('The topic/keyword to search for (e.g., "docker", "meeting", "bug")')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Max messages to search through (default: 1000)')
        .setRequired(false)
        .setMinValue(50)
        .setMaxValue(10000)
    ),

  async execute(interaction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const channel = interaction.channel;
      const keyword = interaction.options.getString('keyword');
      const limit = interaction.options.getInteger('limit') || 1000;

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
      }

      await interaction.editReply(`Searching for discussions about "${keyword}"...`);

      try {
        // Generate topic summary
        const result = await summariserService.generateTopicSummary(
          channel,
          guildId,
          interaction.client.user.id,
          keyword,
          limit,
          interaction,
          userId
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
          content: `Topic search complete! Found ${result.matchCount} messages about "${keyword}" (searched ${result.searchedCount} messages). You have ${rateLimitCheck.remainingUses - 1} requests remaining.`
        });

        logger.info(`Topic search by ${interaction.user.tag} in ${interaction.guild.name}/#${channel.name} (keyword: ${keyword}, found: ${result.matchCount})`);
      } catch (summaryError) {
        requestQueueService.releaseSlot(slot.requestId);
        throw summaryError;
      }

    } catch (error) {
      logger.error('Error executing topic command:', error);
      
      const errorMessage = 'An error occurred while searching for the topic. Please try again later.';
      
      if (interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }
};
