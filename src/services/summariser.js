import { SummaryModel } from '../database/models.js';
import llmService from './llm.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

class SummariserService {
  /**
   * Fetch messages from a channel since the last summary
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @returns {Promise<Array>} - Array of formatted message objects
   */
  async fetchMessagesSinceLastSummary(channel, guildId) {
    try {
      const lastSummary = SummaryModel.getLastSummary(guildId, channel.id);
      
      let messages = [];
      let fetchOptions = { limit: config.maxMessagesToFetch };
      
      if (lastSummary) {
        // Fetch messages after the last summary
        fetchOptions.after = lastSummary.message_id;
      }

      const fetchedMessages = await channel.messages.fetch(fetchOptions);
      
      // Filter out bot messages and format
      messages = fetchedMessages
        .filter(msg => !msg.author.bot)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(msg => ({
          author: msg.author.username,
          content: msg.content || '[attachment/embed]',
          timestamp: new Date(msg.createdTimestamp).toLocaleTimeString('en-GB', { 
            hour: '2-digit', 
            minute: '2-digit' 
          })
        }));

      return messages;
    } catch (error) {
      logger.error('Error fetching messages:', error);
      throw new Error('Failed to fetch messages from channel');
    }
  }

  /**
   * Generate and post a summary
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @returns {Promise<Object>} - Summary result with message and metadata
   */
  async generateAndPostSummary(channel, guildId) {
    try {
      // Fetch messages
      const messages = await this.fetchMessagesSinceLastSummary(channel, guildId);

      if (messages.length === 0) {
        return {
          success: false,
          error: 'No messages to summarise since the last summary.'
        };
      }

      logger.info(`Summarising ${messages.length} messages in channel ${channel.id}`);

      // Generate summary using LLM
      const summaryText = await llmService.summariseMessages(messages);

      // Get last summary to reply to
      const lastSummary = SummaryModel.getLastSummary(guildId, channel.id);
      
      let sentMessage;
      if (lastSummary) {
        try {
          // Try to fetch and reply to the last summary
          const lastMessage = await channel.messages.fetch(lastSummary.message_id);
          sentMessage = await lastMessage.reply(summaryText);
        } catch (error) {
          // If we can't fetch the old message, just send a new one
          logger.warn('Could not reply to last summary, sending new message');
          sentMessage = await channel.send(summaryText);
        }
      } else {
        // First summary in this channel
        sentMessage = await channel.send(summaryText);
      }

      // Store the new summary
      const timestamp = Math.floor(Date.now() / 1000);
      SummaryModel.createSummary(guildId, channel.id, sentMessage.id, timestamp);

      return {
        success: true,
        message: sentMessage,
        messageCount: messages.length,
        summaryText
      };
    } catch (error) {
      logger.error('Error generating summary:', error);
      throw error;
    }
  }

  /**
   * Get time since last summary in human-readable format
   * @param {string} guildId - Discord guild ID
   * @param {string} channelId - Discord channel ID
   * @returns {string|null} - Time string or null if no previous summary
   */
  getTimeSinceLastSummary(guildId, channelId) {
    const lastSummary = SummaryModel.getLastSummary(guildId, channelId);
    
    if (!lastSummary) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastSummary.timestamp;
    
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);

    if (hours > 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    } else {
      return 'less than a minute ago';
    }
  }
}

export default new SummariserService();
