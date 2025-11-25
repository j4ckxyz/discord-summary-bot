import { SlashCommandBuilder } from 'discord.js';
import rateLimitService from '../services/ratelimit.js';
import summariserService from '../services/summariser.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

export default {
  data: new SlashCommandBuilder()
    .setName('summarise')
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
\`/summarise\` - Summarise messages since last summary (min ${config.minMessagesForSummary} messages)
\`!summary\` or \`@${interaction.client.user.username}\` - Same as above

**Advanced Options:**
\`/summarise target:500\` - Summarise the last 500 messages
\`/summarise target:@user\` - Summarise a user's 50 most recent messages
\`/summarise target:<userID>\` - Same as above, using Discord user ID

**Prefix Commands:**
\`!summary 500\` - Summarise the last 500 messages
\`!summary @user\` - Summarise a user's 50 most recent messages

**Rate Limits:**
• ${config.maxUsesPerWindow} summaries per ${config.cooldownMinutes} minutes per channel
• Summaries are capped at ${config.maxSummaryLength} characters

**Tips:**
• User summaries focus only on that user's messages
• All summaries are neutral and objective`;

        await interaction.reply({ content: helpMessage, ephemeral: true });
        return;
      }

      // Parse the target input to determine if it's a message count or user ID
      let summaryMode = 'default'; // default, count, or user
      let targetValue = null;
      
      if (targetInput) {
        const numericValue = parseInt(targetInput, 10);
        
        // Discord user IDs are typically 17-19 digits long
        // Message counts are typically smaller (1-1000)
        if (!isNaN(numericValue)) {
          if (numericValue > 10000) {
            // Likely a user ID (Discord snowflake)
            summaryMode = 'user';
            targetValue = targetInput;
          } else {
            // Likely a message count
            summaryMode = 'count';
            targetValue = Math.min(numericValue, 1000); // Cap at 1000 messages
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

      // Generate and post summary
      const result = await summariserService.generateAndPostSummary(
        channel, 
        guildId, 
        interaction.client.user.id,
        summaryMode,
        targetValue
      );

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

