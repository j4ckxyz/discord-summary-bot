import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import logger from '../utils/logger.js';

export default {
  data: {
    name: 'summarise',
    description: 'Generate an AI summary of recent messages in this channel'
  },

  async execute(interaction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const channel = interaction.channel;

      // Check rate limit
      const rateLimitCheck = rateLimitService.checkRateLimit(userId, guildId);
      
      if (!rateLimitCheck.allowed) {
        const timeRemaining = rateLimitService.formatRemainingTime(rateLimitCheck.remainingSeconds);
        await interaction.reply({
          content: `You're on cooldown. Please wait ${timeRemaining} before requesting another summary.`,
          ephemeral: true
        });
        return;
      }

      // Defer reply as this might take a while
      await interaction.deferReply();

      // Generate and post summary
      const result = await summariserService.generateAndPostSummary(channel, guildId);

      if (!result.success) {
        await interaction.editReply(result.error);
        return;
      }

      // Update cooldown
      rateLimitService.updateCooldown(userId, guildId);

      // Confirm to user (ephemeral)
      await interaction.editReply({
        content: `Summary generated! Summarised ${result.messageCount} message${result.messageCount !== 1 ? 's' : ''}.`
      });

      logger.info(`Summary created by ${interaction.user.tag} in ${interaction.guild.name}/#${channel.name}`);

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

