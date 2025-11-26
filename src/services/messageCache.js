import { MessageCacheModel } from '../database/models.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

class MessageCacheService {
  constructor() {
    this.maintenanceInterval = null;
  }

  /**
   * Check if caching is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return config.cacheEnabled !== false; // Default to enabled
  }

  /**
   * Cache a single message
   * @param {Object} message - Discord message object
   */
  cacheMessage(message) {
    if (!this.isEnabled()) return;
    
    try {
      MessageCacheModel.cacheMessage(message);
    } catch (error) {
      logger.debug(`Failed to cache message ${message.id}: ${error.message}`);
    }
  }

  /**
   * Cache multiple messages (from bulk fetch)
   * @param {Array} messages - Array of Discord message objects
   */
  cacheMessages(messages) {
    if (!this.isEnabled() || messages.length === 0) return;
    
    try {
      MessageCacheModel.cacheMessages(messages);
      logger.debug(`Cached ${messages.length} messages`);
    } catch (error) {
      logger.warn(`Failed to cache messages: ${error.message}`);
    }
  }

  /**
   * Mark a message as deleted
   * @param {string} messageId - Discord message ID
   */
  markMessageDeleted(messageId) {
    if (!this.isEnabled()) return;
    
    try {
      MessageCacheModel.markDeleted(messageId);
    } catch (error) {
      logger.debug(`Failed to mark message ${messageId} as deleted: ${error.message}`);
    }
  }

  /**
   * Update a message in cache
   * @param {Object} message - Discord message object
   */
  updateMessage(message) {
    if (!this.isEnabled()) return;
    
    try {
      MessageCacheModel.updateMessage(message);
    } catch (error) {
      logger.debug(`Failed to update message ${message.id}: ${error.message}`);
    }
  }

  /**
   * Get cached messages for a channel
   * @param {string} channelId - Discord channel ID
   * @param {number} limit - Max messages to return
   * @param {string} botUserId - Bot's user ID to exclude
   * @returns {Array} - Array of cached message objects
   */
  getCachedMessages(channelId, limit, botUserId) {
    if (!this.isEnabled()) return [];
    
    try {
      return MessageCacheModel.getMessages(channelId, limit, botUserId);
    } catch (error) {
      logger.warn(`Failed to get cached messages: ${error.message}`);
      return [];
    }
  }

  /**
   * Get count of cached messages for a channel
   * @param {string} channelId - Discord channel ID
   * @param {string} botUserId - Bot's user ID to exclude
   * @returns {number}
   */
  getCachedMessageCount(channelId, botUserId) {
    if (!this.isEnabled()) return 0;
    
    try {
      return MessageCacheModel.getMessageCount(channelId, botUserId);
    } catch (error) {
      logger.warn(`Failed to get cached message count: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get oldest cached message for a channel
   * @param {string} channelId - Discord channel ID
   * @returns {Object|null}
   */
  getOldestCachedMessage(channelId) {
    if (!this.isEnabled()) return null;
    
    try {
      return MessageCacheModel.getOldestMessage(channelId);
    } catch (error) {
      logger.warn(`Failed to get oldest cached message: ${error.message}`);
      return null;
    }
  }

  /**
   * Run cache maintenance (cleanup old messages, prune if too large)
   */
  runMaintenance() {
    if (!this.isEnabled()) return;
    
    try {
      const maxAgeDays = config.cacheMaxAgeDays || 7;
      const maxMessages = config.cacheMaxMessages || 500000;
      
      // Clean up old messages
      const ageResult = MessageCacheModel.cleanupOldMessages(maxAgeDays);
      if (ageResult.changes > 0) {
        logger.info(`Cache maintenance: removed ${ageResult.changes} messages older than ${maxAgeDays} days`);
      }
      
      // Prune if exceeding max size
      const pruneResult = MessageCacheModel.pruneCache(maxMessages);
      if (pruneResult.changes > 0) {
        logger.info(`Cache maintenance: pruned ${pruneResult.changes} messages to stay under ${maxMessages} limit`);
      }
      
      const totalSize = MessageCacheModel.getTotalCacheSize();
      logger.debug(`Cache size: ${totalSize} messages`);
    } catch (error) {
      logger.error(`Cache maintenance failed: ${error.message}`);
    }
  }

  /**
   * Start the maintenance schedule (runs daily)
   */
  startMaintenanceSchedule() {
    if (!this.isEnabled()) return;
    
    // Run maintenance once on startup
    this.runMaintenance();
    
    // Then run every 24 hours
    this.maintenanceInterval = setInterval(() => {
      this.runMaintenance();
    }, 24 * 60 * 60 * 1000);
    
    logger.info('Message cache maintenance scheduled (daily)');
  }

  /**
   * Stop the maintenance schedule
   */
  stopMaintenanceSchedule() {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
  }

  /**
   * Get the last message from a specific user in a channel
   * @param {string} channelId - Discord channel ID
   * @param {string} userId - User ID to find
   * @returns {Object|null} - Last message object or null
   */
  getLastUserMessage(channelId, userId) {
    if (!this.isEnabled()) return null;
    
    try {
      return MessageCacheModel.getLastUserMessage(channelId, userId);
    } catch (error) {
      logger.warn(`Failed to get last user message: ${error.message}`);
      return null;
    }
  }

  /**
   * Get messages since a timestamp
   * @param {string} channelId - Discord channel ID
   * @param {number} sinceTimestamp - Unix timestamp
   * @param {string} botUserId - Bot's user ID to exclude
   * @param {number} limit - Max messages to return
   * @returns {Array} - Array of cached message objects
   */
  getMessagesSince(channelId, sinceTimestamp, botUserId, limit = 5000) {
    if (!this.isEnabled()) return [];
    
    try {
      return MessageCacheModel.getMessagesSince(channelId, sinceTimestamp, botUserId, limit);
    } catch (error) {
      logger.warn(`Failed to get messages since timestamp: ${error.message}`);
      return [];
    }
  }

  /**
   * Search messages containing a keyword
   * @param {string} channelId - Discord channel ID
   * @param {string} keyword - Keyword to search for
   * @param {string} botUserId - Bot's user ID to exclude
   * @param {number} limit - Max messages to return
   * @returns {Array} - Array of cached message objects
   */
  searchMessages(channelId, keyword, botUserId, limit = 1000) {
    if (!this.isEnabled()) return [];
    
    try {
      return MessageCacheModel.searchMessages(channelId, keyword, botUserId, limit);
    } catch (error) {
      logger.warn(`Failed to search messages: ${error.message}`);
      return [];
    }
  }
}

export default new MessageCacheService();
