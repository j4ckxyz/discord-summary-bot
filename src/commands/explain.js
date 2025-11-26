import { SlashCommandBuilder } from 'discord.js';
import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import requestQueueService from '../services/requestQueue.js';
import logger from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('explain')
    .setDescription('Get help understanding a topic - explains context, different viewpoints, and key points')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('What do you want explained? (e.g., "the database migration", "why we chose React")')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('depth')
        .setDescription('How many messages to search (default: 2000)')
        .setRequired(false)
        .setMinValue(100)
        .setMaxValue(20000)
    ),

  async execute(interaction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const channel = interaction.channel;
      const topic = interaction.options.getString('topic');
      const depth = interaction.options.getInteger('depth') || 2000;

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

      await interaction.editReply(`Analyzing discussions to explain "${topic}"...`);

      try {
        // Generate explanation
        const result = await summariserService.generateExplanation(
          channel,
          guildId,
          interaction.client.user.id,
          topic,
          depth,
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
          content: `Explanation complete! Analyzed ${result.matchCount} relevant messages from ${result.searchedCount} total. You have ${rateLimitCheck.remainingUses - 1} requests remaining.`
        });

        logger.info(`Explain request by ${interaction.user.tag} in ${interaction.guild.name}/#${channel.name} (topic: ${topic}, found: ${result.matchCount})`);
      } catch (summaryError) {
        requestQueueService.releaseSlot(slot.requestId);
        throw summaryError;
      }

    } catch (error) {
      logger.error('Error executing explain command:', error);
      
      const errorMessage = 'An error occurred while generating the explanation. Please try again later.';
      
      if (interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }
};
