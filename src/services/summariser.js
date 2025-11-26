import { SummaryModel } from '../database/models.js';
import llmService from './llm.js';
import messageCacheService from './messageCache.js';
import embeddingService from './embedding.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

// Configuration for large message handling
const CHUNK_SIZE = 2500; // Messages per chunk for hierarchical summarization
const RATE_LIMIT_DELAY = 250; // ms between Discord API calls to avoid rate limits

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
   * Update progress message with rate limiting to avoid Discord API spam
   * @param {Object} editableMessage - Message to edit OR interaction to editReply
   * @param {string} text - New message text
   * @param {number} lastUpdate - Timestamp of last update
   * @returns {Promise<number>} - Timestamp of this update (or last if skipped)
   */
  async updateProgress(editableMessage, text, lastUpdate = 0) {
    const now = Date.now();
    // Only update every 2 seconds to avoid rate limits
    if (now - lastUpdate < 2000) {
      return lastUpdate;
    }
    
    try {
      // Check if this is an interaction (has editReply) or a message (has edit)
      if (editableMessage.editReply) {
        await editableMessage.editReply(text);
      } else {
        await editableMessage.edit(text);
      }
      return now;
    } catch (error) {
      logger.debug('Could not update progress message:', error.message);
      return lastUpdate;
    }
  }

  /**
   * Fetch messages from a channel since the last summary
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @param {string} botUserId - Bot's user ID to filter out bot messages
   * @param {string} mode - 'default', 'count', or 'user'
   * @param {any} targetValue - Message count or user ID depending on mode
   * @param {Object} editableMessage - Optional message to update with progress
   * @returns {Promise<Array>} - Array of formatted message objects
   */
  async fetchMessagesSinceLastSummary(channel, guildId, botUserId, mode = 'default', targetValue = null, editableMessage = null) {
    try {
      let fetchedMessages;
      
      if (mode === 'count') {
        // Try to use cache first for 'count' mode
        const cachedCount = messageCacheService.getCachedMessageCount(channel.id, botUserId);
        
        if (cachedCount >= targetValue) {
          // We have enough cached messages - use them directly
          logger.info(`Using ${targetValue} messages from cache (${cachedCount} available)`);
          
          if (editableMessage) {
            await this.updateProgress(editableMessage, `Loading ${targetValue.toLocaleString()} messages from cache...`, 0);
          }
          
          const cachedMessages = messageCacheService.getCachedMessages(channel.id, targetValue, botUserId);
          
          // Convert cached format to our format
          const messages = cachedMessages
            .sort((a, b) => a.created_at - b.created_at)
            .map(msg => ({
              author: msg.author_username,
              authorId: msg.author_id,
              displayName: msg.author_display_name || msg.author_username,
              content: msg.content || '[attachment/embed]',
              timestamp: new Date(msg.created_at * 1000).toLocaleTimeString('en-GB', { 
                hour: '2-digit', 
                minute: '2-digit' 
              }),
              referencedMessageId: msg.reference_id || null,
              referencedAuthor: null
            }));
          
          // Fill in referenced authors from cache
          const messageMap = new Map(cachedMessages.map(m => [m.id, m.author_username]));
          for (let msg of messages) {
            if (msg.referencedMessageId && messageMap.has(msg.referencedMessageId)) {
              msg.referencedAuthor = messageMap.get(msg.referencedMessageId);
            }
          }
          
          return messages;
        }
        
        // Need to fetch from Discord API (cache doesn't have enough)
        logger.info(`Cache has ${cachedCount} messages, need ${targetValue} - fetching from Discord...`);
        
        // Fetch specific number of messages with pagination
        const allMessages = [];
        let lastId = null;
        let totalFetched = 0;
        let lastProgressUpdate = 0;
        
        // If we have some cached messages, start fetching from before the oldest cached one
        const oldestCached = messageCacheService.getOldestCachedMessage(channel.id);
        if (oldestCached && cachedCount > 0) {
          lastId = oldestCached.id;
          // We'll merge cached messages with newly fetched ones later
        }
        
        const messagesToFetch = targetValue;
        logger.info(`Fetching ${messagesToFetch} messages...`);
        
        while (totalFetched < messagesToFetch) {
          const fetchOptions = { limit: Math.min(100, messagesToFetch - totalFetched) };
          if (lastId) fetchOptions.before = lastId;
          
          const batch = await channel.messages.fetch(fetchOptions);
          
          if (batch.size === 0) {
            logger.info(`Reached end of channel history at ${totalFetched} messages`);
            break;
          }
          
          // Cache the fetched messages for future use
          messageCacheService.cacheMessages(Array.from(batch.values()));
          
          allMessages.push(...batch.values());
          totalFetched += batch.size;
          lastId = batch.last().id;
          
          // Log progress every 500 messages for large fetches
          if (totalFetched % 500 === 0 || totalFetched >= messagesToFetch) {
            logger.info(`Fetched ${totalFetched}/${messagesToFetch} messages`);
          } else {
            logger.debug(`Fetched ${totalFetched}/${messagesToFetch} messages`);
          }
          
          // Update progress message for user visibility
          if (editableMessage) {
            const percent = Math.round((totalFetched / messagesToFetch) * 100);
            lastProgressUpdate = await this.updateProgress(
              editableMessage, 
              `Fetching messages... ${totalFetched.toLocaleString()}/${messagesToFetch.toLocaleString()} (${percent}%)`,
              lastProgressUpdate
            );
          }
          
          // Delay to avoid rate limits - longer delay for large fetches
          if (totalFetched < messagesToFetch) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
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
          displayName: msg.author.displayName || msg.author.globalName || msg.author.username,
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
   * @param {string} mode - 'default', 'count', 'user', 'topic', 'catchup', or 'explain'
   * @param {any} targetValue - Message count, user ID, or topic keyword depending on mode
   * @param {Object} editableMessage - Optional message to edit instead of sending new one
   * @param {string} requesterId - User ID of who requested the summary (for @mention notification)
   * @returns {Promise<Object>} - Summary result with message and metadata
   */
  async generateAndPostSummary(channel, guildId, botUserId, mode = 'default', targetValue = null, editableMessage = null, requesterId = null) {
    try {
      // Fetch messages - pass editable message for progress updates
      const messages = await this.fetchMessagesSinceLastSummary(channel, guildId, botUserId, mode, targetValue, editableMessage);

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

      // For large message counts, use hierarchical summarization
      let summaryText;
      if (mode === 'count' && messages.length > CHUNK_SIZE) {
        summaryText = await this.hierarchicalSummarise(messages, editableMessage);
      } else {
        // Update progress if we have an editable message
        if (editableMessage) {
          await this.updateProgress(editableMessage, `Generating summary for ${messages.length.toLocaleString()} messages...`, 0);
        }
        // Generate summary using LLM
        summaryText = await llmService.summariseMessages(messages, mode, targetUsername);
      }

      // Validate summary is not empty
      if (!summaryText || summaryText.trim().length === 0) {
        logger.error('LLM returned empty summary');
        return {
          success: false,
          error: 'Failed to generate summary - LLM returned empty response. Please try again.'
        };
      }

      logger.debug(`Summary length: ${summaryText.length} characters`);

      // Split summary if it exceeds Discord's 2000 character limit
      const summaryChunks = this.splitIntoChunks(summaryText, 2000);
      
      logger.debug(`Split into ${summaryChunks.length} chunk(s)`);
      
      // Validate chunks are not empty
      const validChunks = summaryChunks.filter(chunk => chunk && chunk.trim().length > 0);
      
      if (validChunks.length === 0) {
        logger.error('All chunks are empty after splitting');
        return {
          success: false,
          error: 'Failed to generate summary - splitting resulted in empty chunks. Please try again.'
        };
      }
      
      let sentMessage;
      
      // If we have an editable message (from prefix/mention command), edit it with first chunk
      if (editableMessage) {
        // Check if this is an interaction (has editReply) or a message (has edit)
        if (editableMessage.editReply) {
          // For interactions (slash commands), send summary to channel, not via editReply
          // The interaction reply will be used for confirmation message later
          sentMessage = await channel.send(validChunks[0]);
        } else {
          sentMessage = await editableMessage.edit(validChunks[0]);
        }
        
        // Send remaining chunks as new messages
        for (let i = 1; i < validChunks.length; i++) {
          await channel.send(validChunks[i]);
        }
      } else {
        // For slash commands, send message or reply to previous summary
        const lastSummary = mode === 'default' ? SummaryModel.getLastSummary(guildId, channel.id) : null;
        
        if (lastSummary && mode === 'default') {
          try {
            // Try to fetch and reply to the last summary
            const lastMessage = await channel.messages.fetch(lastSummary.message_id);
            sentMessage = await lastMessage.reply(validChunks[0]);
          } catch (error) {
            // If we can't fetch the old message, just send a new one
            logger.warn('Could not reply to last summary, sending new message');
            sentMessage = await channel.send(validChunks[0]);
          }
        } else {
          // For count/user mode or first summary, send a new message
          sentMessage = await channel.send(validChunks[0]);
        }
        
        // Send remaining chunks as follow-up messages
        for (let i = 1; i < validChunks.length; i++) {
          await channel.send(validChunks[i]);
        }
      }

      // Store the new summary (only in default mode to maintain chain, and not for edited messages)
      if (mode === 'default' && !editableMessage) {
        const timestamp = Math.floor(Date.now() / 1000);
        SummaryModel.createSummary(guildId, channel.id, sentMessage.id, timestamp);
      }

      // Send @mention notification to the requester
      if (requesterId) {
        await channel.send(`<@${requesterId}> Here is your summary!`);
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
   * Perform hierarchical summarization for large message counts
   * Splits messages into chunks, summarizes each chunk, then combines summaries
   * @param {Array} messages - Array of formatted message objects
   * @param {Object} editableMessage - Optional message to update with progress
   * @returns {Promise<string>} - Final combined summary
   */
  async hierarchicalSummarise(messages, editableMessage = null) {
    const totalMessages = messages.length;
    const numChunks = Math.ceil(totalMessages / CHUNK_SIZE);
    
    logger.info(`Using hierarchical summarization: ${totalMessages} messages in ${numChunks} chunks`);
    
    // Build username -> userId map for mentions
    const userMap = llmService.buildUserMap(messages);
    
    let lastProgressUpdate = 0;
    const chunkSummaries = [];
    
    // First pass: summarize each chunk
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalMessages);
      const chunk = messages.slice(start, end);
      
      // Update progress
      if (editableMessage) {
        const progress = `Summarising chunk ${i + 1}/${numChunks} (messages ${start + 1}-${end} of ${totalMessages.toLocaleString()})...`;
        lastProgressUpdate = await this.updateProgress(editableMessage, progress, lastProgressUpdate);
      }
      
      logger.info(`Summarising chunk ${i + 1}/${numChunks} (${chunk.length} messages)`);
      
      // Get chunk time range for context
      const startTime = chunk[0]?.timestamp || 'unknown';
      const endTime = chunk[chunk.length - 1]?.timestamp || 'unknown';
      
      // Summarize this chunk
      const chunkSummary = await llmService.summariseChunk(chunk, i + 1, numChunks, startTime, endTime);
      chunkSummaries.push({
        index: i + 1,
        startTime,
        endTime,
        messageCount: chunk.length,
        summary: chunkSummary
      });
    }
    
    // Second pass: combine all chunk summaries into final summary
    if (editableMessage) {
      lastProgressUpdate = await this.updateProgress(
        editableMessage, 
        `Combining ${numChunks} summaries into final summary...`,
        lastProgressUpdate
      );
    }
    
    logger.info(`Combining ${numChunks} chunk summaries into final summary`);
    
    const finalSummary = await llmService.combineSummaries(chunkSummaries, totalMessages);
    
    // Replace usernames with Discord mentions
    return llmService.replaceUsernamesWithMentions(finalSummary, userMap);
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

  /**
   * Generate a catchup summary for messages since a user was last active
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @param {string} botUserId - Bot's user ID to filter out
   * @param {string} requesterId - User ID who requested the catchup
   * @param {number} sinceTimestamp - Unix timestamp to fetch messages since
   * @param {Object} editableMessage - Optional message to update with progress
   * @returns {Promise<Object>} - Summary result
   */
  async generateCatchupSummary(channel, guildId, botUserId, requesterId, sinceTimestamp, editableMessage = null) {
    try {
      // Get messages from cache since the timestamp
      let messages = messageCacheService.getMessagesSince(channel.id, sinceTimestamp, botUserId, 5000);
      
      // Convert cached format to our format
      messages = messages.map(msg => ({
        author: msg.author_username,
        authorId: msg.author_id,
        displayName: msg.author_display_name || msg.author_username,
        content: msg.content || '[attachment/embed]',
        timestamp: new Date(msg.created_at * 1000).toLocaleTimeString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit' 
        }),
        referencedMessageId: msg.reference_id || null,
        referencedAuthor: null
      }));

      if (messages.length === 0) {
        return {
          success: false,
          error: 'No messages found since you were last active. The channel has been quiet!'
        };
      }

      if (editableMessage) {
        await this.updateProgress(editableMessage, `Found ${messages.length} messages to catch you up on...`, 0);
      }

      // Check for messages that mention the requester
      const mentionPattern = new RegExp(`<@!?${requesterId}>`, 'g');
      const mentionedMessages = messages.filter(msg => mentionPattern.test(msg.content));

      // Generate catchup summary using LLM
      const summaryText = await llmService.summariseCatchup(messages, mentionedMessages, requesterId);

      if (!summaryText || summaryText.trim().length === 0) {
        return {
          success: false,
          error: 'Failed to generate catchup summary. Please try again.'
        };
      }

      // Split and send the summary
      const summaryChunks = this.splitIntoChunks(summaryText, 2000);
      const validChunks = summaryChunks.filter(chunk => chunk && chunk.trim().length > 0);

      for (const chunk of validChunks) {
        await channel.send(chunk);
      }

      // Send notification
      await channel.send(`<@${requesterId}> Here's your catchup!`);

      return {
        success: true,
        messageCount: messages.length
      };
    } catch (error) {
      logger.error('Error generating catchup summary:', error);
      throw error;
    }
  }

  /**
   * Generate a topic-focused summary searching for a specific keyword
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @param {string} botUserId - Bot's user ID to filter out
   * @param {string} keyword - Topic/keyword to search for
   * @param {number} limit - Max messages to search
   * @param {Object} editableMessage - Optional message to update with progress
   * @param {string} requesterId - User ID who requested the summary
   * @returns {Promise<Object>} - Summary result
   */
  async generateTopicSummary(channel, guildId, botUserId, keyword, limit, editableMessage = null, requesterId = null) {
    try {
      if (editableMessage) {
        await this.updateProgress(editableMessage, `Generating related search terms for "${keyword}"...`, 0);
      }

      // Generate 15 related search terms using embeddings
      const searchTerms = await embeddingService.generateRelatedTerms(keyword, 15);
      logger.info(`Searching for topic "${keyword}" with terms: ${searchTerms.join(', ')}`);

      // Search for messages containing any of the search terms
      let allMatches = [];
      const seenIds = new Set();

      for (const term of searchTerms) {
        const matches = messageCacheService.searchMessages(channel.id, term, botUserId, Math.ceil(limit / searchTerms.length));
        for (const msg of matches) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            allMatches.push(msg);
          }
        }
      }

      // Sort by timestamp
      allMatches.sort((a, b) => a.created_at - b.created_at);

      // Limit to requested amount
      allMatches = allMatches.slice(0, limit);
      
      // Convert cached format to our format
      let matchedMessages = allMatches.map(msg => ({
        author: msg.author_username,
        authorId: msg.author_id,
        displayName: msg.author_display_name || msg.author_username,
        content: msg.content || '[attachment/embed]',
        timestamp: new Date(msg.created_at * 1000).toLocaleTimeString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit' 
        }),
        referencedMessageId: msg.reference_id || null,
        referencedAuthor: null
      }));

      if (matchedMessages.length === 0) {
        return {
          success: false,
          error: `No messages found about "${keyword}". Try a different keyword or check the spelling.`
        };
      }

      if (editableMessage) {
        await this.updateProgress(editableMessage, `Found ${matchedMessages.length} messages about "${keyword}"...`, 0);
      }

      // Generate topic summary using LLM with search context
      const summaryText = await llmService.summariseTopic(matchedMessages, keyword, searchTerms);

      if (!summaryText || summaryText.trim().length === 0) {
        return {
          success: false,
          error: 'Failed to generate topic summary. Please try again.'
        };
      }

      // Split and send the summary
      const summaryChunks = this.splitIntoChunks(summaryText, 2000);
      const validChunks = summaryChunks.filter(chunk => chunk && chunk.trim().length > 0);

      for (const chunk of validChunks) {
        await channel.send(chunk);
      }

      // Send notification
      if (requesterId) {
        await channel.send(`<@${requesterId}> Here's your topic summary for "${keyword}"!`);
      }

      return {
        success: true,
        matchCount: matchedMessages.length,
        searchedCount: limit,
        searchTerms: searchTerms
      };
    } catch (error) {
      logger.error('Error generating topic summary:', error);
      throw error;
    }
  }

  /**
   * Generate an explanation to help understand a topic
   * @param {Object} channel - Discord channel object
   * @param {string} guildId - Discord guild ID
   * @param {string} botUserId - Bot's user ID to filter out
   * @param {string} topic - Topic to explain
   * @param {number} depth - How many messages to search
   * @param {Object} editableMessage - Optional message to update with progress
   * @param {string} requesterId - User ID who requested the explanation
   * @returns {Promise<Object>} - Summary result
   */
  async generateExplanation(channel, guildId, botUserId, topic, depth, editableMessage = null, requesterId = null) {
    try {
      if (editableMessage) {
        await this.updateProgress(editableMessage, `Generating related search terms for "${topic}"...`, 0);
      }

      // Generate 15 related search terms using embeddings
      const searchTerms = await embeddingService.generateRelatedTerms(topic, 15);
      logger.info(`Searching for explanation of "${topic}" with terms: ${searchTerms.join(', ')}`);

      // Search for messages containing any of the search terms
      let allMatches = [];
      const seenIds = new Set();

      for (const term of searchTerms) {
        const matches = messageCacheService.searchMessages(channel.id, term, botUserId, Math.ceil(depth / searchTerms.length));
        for (const msg of matches) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            allMatches.push(msg);
          }
        }
      }

      // Sort by timestamp
      allMatches.sort((a, b) => a.created_at - b.created_at);

      // Limit to requested amount
      allMatches = allMatches.slice(0, depth);
      
      // Convert cached format to our format
      let matchedMessages = allMatches.map(msg => ({
        author: msg.author_username,
        authorId: msg.author_id,
        displayName: msg.author_display_name || msg.author_username,
        content: msg.content || '[attachment/embed]',
        timestamp: new Date(msg.created_at * 1000).toLocaleTimeString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit' 
        }),
        referencedMessageId: msg.reference_id || null,
        referencedAuthor: null
      }));

      if (matchedMessages.length === 0) {
        return {
          success: false,
          error: `No discussions found about "${topic}". Try different keywords or broaden your search.`
        };
      }

      if (editableMessage) {
        await this.updateProgress(editableMessage, `Analysing ${matchedMessages.length} messages to explain "${topic}"...`, 0);
      }

      // Generate explanation using LLM with search context
      const explanationText = await llmService.generateExplanation(matchedMessages, topic, searchTerms);

      if (!explanationText || explanationText.trim().length === 0) {
        return {
          success: false,
          error: 'Failed to generate explanation. Please try again.'
        };
      }

      // Split and send the explanation
      const chunks = this.splitIntoChunks(explanationText, 2000);
      const validChunks = chunks.filter(chunk => chunk && chunk.trim().length > 0);

      for (const chunk of validChunks) {
        await channel.send(chunk);
      }

      // Send notification
      if (requesterId) {
        await channel.send(`<@${requesterId}> Here's your explanation of "${topic}"!`);
      }

      return {
        success: true,
        matchCount: matchedMessages.length,
        searchedCount: depth,
        searchTerms: searchTerms
      };
    } catch (error) {
      logger.error('Error generating explanation:', error);
      throw error;
    }
  }
}

export default new SummariserService();
