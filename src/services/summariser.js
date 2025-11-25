import { SummaryModel } from '../database/models.js';
import llmService from './llm.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

class SummariserService {
  /**
   * Fetch messages from a channel since the last summary
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @param {string} botUserId - Bot's user ID to filter out bot messages
   * @param {string} mode - 'default', 'count', or 'user'
   * @param {any} targetValue - Message count or user ID depending on mode
   * @returns {Promise<Array>} - Array of formatted message objects
   */
  async fetchMessagesSinceLastSummary(channel, guildId, botUserId, mode = 'default', targetValue = null) {
    try {
      let fetchedMessages;
      
      if (mode === 'count') {
        // Fetch specific number of messages
        fetchedMessages = await channel.messages.fetch({ limit: Math.min(targetValue, 100) });
        
        // If they requested more than 100, we need to paginate
        if (targetValue > 100) {
          let remaining = targetValue - 100;
          let lastId = fetchedMessages.last().id;
          
          while (remaining > 0 && fetchedMessages.size < targetValue) {
            const batch = await channel.messages.fetch({ 
              limit: Math.min(remaining, 100),
              before: lastId
            });
            
            if (batch.size === 0) break;
            
            fetchedMessages = new Map([...fetchedMessages, ...batch]);
            lastId = batch.last().id;
            remaining -= batch.size;
          }
        }
      } else if (mode === 'user') {
        // Fetch messages from a specific user (up to 50 most recent)
        const USER_MESSAGE_LIMIT = 50;
        let userMessages = [];
        let lastId = null;
        
        // Keep fetching until we have 50 messages from the target user or run out of messages
        while (userMessages.length < USER_MESSAGE_LIMIT) {
          const fetchOptions = { limit: 100 };
          if (lastId) fetchOptions.before = lastId;
          
          const batch = await channel.messages.fetch(fetchOptions);
          if (batch.size === 0) break;
          
          const userMessagesInBatch = batch.filter(msg => msg.author.id === targetValue);
          userMessages.push(...userMessagesInBatch.values());
          
          if (userMessages.length >= USER_MESSAGE_LIMIT) {
            userMessages = userMessages.slice(0, USER_MESSAGE_LIMIT);
            break;
          }
          
          lastId = batch.last().id;
          
          // Safety limit: don't fetch more than 500 total messages
          if (batch.size < 100) break;
        }
        
        // Convert array back to Collection-like structure
        fetchedMessages = new Map(userMessages.map(msg => [msg.id, msg]));
      } else {
        // Default mode: fetch messages since last summary
        const lastSummary = SummaryModel.getLastSummary(guildId, channel.id);
        
        let fetchOptions = { limit: config.maxMessagesToFetch };
        
        if (lastSummary) {
          fetchOptions.after = lastSummary.message_id;
        }
        
        fetchedMessages = await channel.messages.fetch(fetchOptions);
      }
      
      let messages = [];
      
      // Filter out bot messages and format
      messages = Array.from(fetchedMessages.values())
        .filter(msg => msg.author.id !== botUserId) // Filter out bot's own messages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(msg => ({
          author: msg.author.username,
          authorId: msg.author.id,
          content: msg.content || '[attachment/embed]',
          timestamp: new Date(msg.createdTimestamp).toLocaleTimeString('en-GB', { 
            hour: '2-digit', 
            minute: '2-digit' 
          }),
          referencedMessageId: msg.reference?.messageId || null,
          referencedAuthor: null // Will be filled in next step
        }));

      // Build a map of message IDs to authors for reply chain tracking
      const messageMap = new Map();
      fetchedMessages.forEach(msg => {
        messageMap.set(msg.id, msg.author.username);
      });

      // Fill in referenced author information
      for (let msg of messages) {
        if (msg.referencedMessageId) {
          // Try to get from current batch first
          if (messageMap.has(msg.referencedMessageId)) {
            msg.referencedAuthor = messageMap.get(msg.referencedMessageId);
          } else {
            // Try to fetch the referenced message if not in current batch
            try {
              const referencedMsg = await channel.messages.fetch(msg.referencedMessageId);
              msg.referencedAuthor = referencedMsg.author.username;
            } catch (error) {
              // Referenced message is likely old/deleted/outside fetch window - silently skip
              // This is normal behavior and doesn't indicate a problem
            }
          }
        }
      }

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
   * @param {string} botUserId - Bot's user ID to filter out bot messages
   * @param {string} mode - 'default', 'count', or 'user'
   * @param {any} targetValue - Message count or user ID depending on mode
   * @param {Object} editableMessage - Optional message to edit instead of sending new one
   * @returns {Promise<Object>} - Summary result with message and metadata
   */
  async generateAndPostSummary(channel, guildId, botUserId, mode = 'default', targetValue = null, editableMessage = null) {
    try {
      // Fetch messages
      const messages = await this.fetchMessagesSinceLastSummary(channel, guildId, botUserId, mode, targetValue);

      if (messages.length === 0) {
        if (mode === 'user') {
          return {
            success: false,
            error: 'No messages found from the specified user.'
          };
        }
        return {
          success: false,
          error: 'No messages to summarise since the last summary.'
        };
      }

      // Check if minimum message count is met (only for default mode)
      if (mode === 'default' && messages.length < config.minMessagesForSummary) {
        return {
          success: false,
          error: `Not enough messages to summarise. Need at least ${config.minMessagesForSummary} messages, but only ${messages.length} found.`
        };
      }

      logger.info(`Summarising ${messages.length} messages in channel ${channel.id} (mode: ${mode})`);

      // Get target username for user mode
      let targetUsername = null;
      if (mode === 'user' && messages.length > 0) {
        targetUsername = messages[0].author;
      }

      // Generate summary using LLM
      const summaryText = await llmService.summariseMessages(messages, mode, targetUsername);

      let sentMessage;
      
      // If we have an editable message (from prefix/mention command), edit it
      if (editableMessage) {
        sentMessage = await editableMessage.edit(summaryText);
      } else {
        // For slash commands, send new message or reply to previous summary
        const lastSummary = mode === 'default' ? SummaryModel.getLastSummary(guildId, channel.id) : null;
        
        if (lastSummary && mode === 'default') {
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
          // For count/user mode or first summary, send a new message
          sentMessage = await channel.send(summaryText);
        }
      }

      // Store the new summary (only in default mode to maintain chain, and not for edited messages)
      if (mode === 'default' && !editableMessage) {
        const timestamp = Math.floor(Date.now() / 1000);
        SummaryModel.createSummary(guildId, channel.id, sentMessage.id, timestamp);
      }

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
