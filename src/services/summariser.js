import { SummaryModel } from '../database/models.js';
import llmService from './llm.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

class SummariserService {
  /**
   * Split a long message into Discord-safe chunks (max 2000 chars each)
   * @param {string} text - The text to split
   * @param {number} maxLength - Maximum length per chunk (default 2000)
   * @returns {Array<string>} - Array of message chunks
   */
  splitIntoChunks(text, maxLength = 2000) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      // If adding this line would exceed the limit
      if ((currentChunk + line + '\n').length > maxLength) {
        // If we have content in current chunk, save it
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // If a single line is too long, split it at word boundaries
        if (line.length > maxLength) {
          const words = line.split(' ');
          let linePart = '';
          
          for (const word of words) {
            if ((linePart + word + ' ').length > maxLength) {
              if (linePart.trim()) {
                chunks.push(linePart.trim());
              }
              linePart = word + ' ';
            } else {
              linePart += word + ' ';
            }
          }
          
          if (linePart.trim()) {
            currentChunk = linePart;
          }
        } else {
          currentChunk = line + '\n';
        }
      } else {
        currentChunk += line + '\n';
      }
    }

    // Add remaining content
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

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
        // Fetch specific number of messages with pagination
        const allMessages = [];
        let lastId = null;
        let totalFetched = 0;
        
        logger.info(`Fetching ${targetValue} messages...`);
        
        while (totalFetched < targetValue) {
          const fetchOptions = { limit: Math.min(100, targetValue - totalFetched) };
          if (lastId) fetchOptions.before = lastId;
          
          const batch = await channel.messages.fetch(fetchOptions);
          
          if (batch.size === 0) {
            logger.info(`Reached end of channel history at ${totalFetched} messages`);
            break;
          }
          
          allMessages.push(...batch.values());
          totalFetched += batch.size;
          lastId = batch.last().id;
          
          logger.debug(`Fetched ${totalFetched}/${targetValue} messages`);
          
          // Small delay to avoid rate limits
          if (totalFetched < targetValue) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        fetchedMessages = new Map(allMessages.map(msg => [msg.id, msg]));
        logger.info(`Successfully fetched ${fetchedMessages.size} messages`);
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

      // Split summary if it exceeds Discord's 2000 character limit
      const summaryChunks = this.splitIntoChunks(summaryText, 2000);
      
      let sentMessage;
      
      // If we have an editable message (from prefix/mention command), edit it with first chunk
      if (editableMessage) {
        sentMessage = await editableMessage.edit(summaryChunks[0]);
        
        // Send remaining chunks as new messages
        for (let i = 1; i < summaryChunks.length; i++) {
          await channel.send(summaryChunks[i]);
        }
      } else {
        // For slash commands, send message or reply to previous summary
        const lastSummary = mode === 'default' ? SummaryModel.getLastSummary(guildId, channel.id) : null;
        
        if (lastSummary && mode === 'default') {
          try {
            // Try to fetch and reply to the last summary
            const lastMessage = await channel.messages.fetch(lastSummary.message_id);
            sentMessage = await lastMessage.reply(summaryChunks[0]);
          } catch (error) {
            // If we can't fetch the old message, just send a new one
            logger.warn('Could not reply to last summary, sending new message');
            sentMessage = await channel.send(summaryChunks[0]);
          }
        } else {
          // For count/user mode or first summary, send a new message
          sentMessage = await channel.send(summaryChunks[0]);
        }
        
        // Send remaining chunks as follow-up messages
        for (let i = 1; i < summaryChunks.length; i++) {
          await channel.send(summaryChunks[i]);
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
