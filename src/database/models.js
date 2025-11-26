import db from './db.js';

export const SummaryModel = {
  // Get the last summary for a specific channel
  getLastSummary(guildId, channelId) {
    const stmt = db.prepare(`
      SELECT * FROM summaries 
      WHERE guild_id = ? AND channel_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    return stmt.get(guildId, channelId);
  },

  // Create a new summary record
  createSummary(guildId, channelId, messageId, timestamp) {
    const stmt = db.prepare(`
      INSERT INTO summaries (guild_id, channel_id, message_id, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(guildId, channelId, messageId, timestamp);
  },

  // Get all summaries for a guild
  getGuildSummaries(guildId) {
    const stmt = db.prepare(`
      SELECT * FROM summaries 
      WHERE guild_id = ? 
      ORDER BY timestamp DESC
    `);
    return stmt.all(guildId);
  }
};

export const CooldownModel = {
  // Check if user has exceeded the rate limit (5 uses per 30 minutes)
  canUseCommand(userId, guildId, channelId, cooldownMinutes, maxUses) {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (cooldownMinutes * 60);
    
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM cooldowns 
      WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND timestamp > ?
    `);
    const result = stmt.get(userId, guildId, channelId, cutoffTime);
    
    return result.count < maxUses;
  },

  // Get remaining uses in current time window
  getRemainingUses(userId, guildId, channelId, cooldownMinutes, maxUses) {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (cooldownMinutes * 60);
    
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM cooldowns 
      WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND timestamp > ?
    `);
    const result = stmt.get(userId, guildId, channelId, cutoffTime);
    
    return Math.max(0, maxUses - result.count);
  },

  // Get time until next use is available
  getTimeUntilNextUse(userId, guildId, channelId, cooldownMinutes, maxUses) {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (cooldownMinutes * 60);
    
    const stmt = db.prepare(`
      SELECT timestamp FROM cooldowns 
      WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND timestamp > ?
      ORDER BY timestamp ASC
      LIMIT 1
    `);
    const result = stmt.get(userId, guildId, channelId, cutoffTime);
    
    if (!result) return 0;
    
    const oldestUse = result.timestamp;
    const expiryTime = oldestUse + (cooldownMinutes * 60);
    return Math.max(0, expiryTime - now);
  },

  // Record a new use
  recordUse(userId, guildId, channelId) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO cooldowns (user_id, guild_id, channel_id, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(userId, guildId, channelId, now);
  },

  // Clean up old records (optional, for database maintenance)
  cleanupOldRecords(cooldownMinutes) {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (cooldownMinutes * 60);
    
    const stmt = db.prepare(`
      DELETE FROM cooldowns WHERE timestamp < ?
    `);
    return stmt.run(cutoffTime);
  }
};

export const MessageCacheModel = {
  /**
   * Cache a single message
   * @param {Object} message - Discord message object
   */
  cacheMessage(message) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cached_messages 
      (id, channel_id, guild_id, author_id, author_username, author_display_name, content, created_at, reference_id, cached_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    
    return stmt.run(
      message.id,
      message.channel.id,
      message.guild?.id || '',
      message.author.id,
      message.author.username,
      message.author.displayName || message.author.globalName || message.author.username,
      message.content || '',
      Math.floor(message.createdTimestamp / 1000),
      message.reference?.messageId || null,
      now
    );
  },

  /**
   * Cache multiple messages in a transaction (for bulk fetches)
   * @param {Array} messages - Array of Discord message objects
   */
  cacheMessages(messages) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cached_messages 
      (id, channel_id, guild_id, author_id, author_username, author_display_name, content, created_at, reference_id, cached_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const insertMany = db.transaction((msgs) => {
      for (const msg of msgs) {
        stmt.run(
          msg.id,
          msg.channel.id,
          msg.guild?.id || '',
          msg.author.id,
          msg.author.username,
          msg.author.displayName || msg.author.globalName || msg.author.username,
          msg.content || '',
          Math.floor(msg.createdTimestamp / 1000),
          msg.reference?.messageId || null,
          now
        );
      }
    });

    return insertMany(messages);
  },

  /**
   * Mark a message as deleted (soft delete)
   * @param {string} messageId - Discord message ID
   */
  markDeleted(messageId) {
    const stmt = db.prepare(`
      UPDATE cached_messages SET deleted = 1 WHERE id = ?
    `);
    return stmt.run(messageId);
  },

  /**
   * Update a message's content
   * @param {Object} message - Discord message object
   */
  updateMessage(message) {
    const stmt = db.prepare(`
      UPDATE cached_messages 
      SET content = ?, author_username = ?
      WHERE id = ?
    `);
    return stmt.run(message.content || '', message.author.username, message.id);
  },

  /**
   * Get cached messages for a channel, excluding deleted ones
   * @param {string} channelId - Discord channel ID
   * @param {number} limit - Max messages to return
   * @param {string} botUserId - Bot's user ID to exclude
   * @returns {Array} - Array of cached message objects
   */
  getMessages(channelId, limit, botUserId) {
    const stmt = db.prepare(`
      SELECT * FROM cached_messages 
      WHERE channel_id = ? AND deleted = 0 AND author_id != ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, botUserId, limit);
  },

  /**
   * Get the oldest cached message ID for a channel (to know where to fetch from)
   * @param {string} channelId - Discord channel ID
   * @returns {Object|null} - Oldest message or null
   */
  getOldestMessage(channelId) {
    const stmt = db.prepare(`
      SELECT id, created_at FROM cached_messages 
      WHERE channel_id = ? AND deleted = 0
      ORDER BY created_at ASC
      LIMIT 1
    `);
    return stmt.get(channelId);
  },

  /**
   * Get count of cached messages for a channel
   * @param {string} channelId - Discord channel ID
   * @param {string} botUserId - Bot's user ID to exclude
   * @returns {number} - Count of cached messages
   */
  getMessageCount(channelId, botUserId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM cached_messages 
      WHERE channel_id = ? AND deleted = 0 AND author_id != ?
    `);
    const result = stmt.get(channelId, botUserId);
    return result.count;
  },

  /**
   * Check if a message exists in cache
   * @param {string} messageId - Discord message ID
   * @returns {boolean}
   */
  hasMessage(messageId) {
    const stmt = db.prepare(`
      SELECT 1 FROM cached_messages WHERE id = ? LIMIT 1
    `);
    return !!stmt.get(messageId);
  },

  /**
   * Clean up old cached messages
   * @param {number} maxAgeDays - Maximum age in days
   * @returns {Object} - Result with changes count
   */
  cleanupOldMessages(maxAgeDays) {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (maxAgeDays * 24 * 60 * 60);
    
    const stmt = db.prepare(`
      DELETE FROM cached_messages WHERE created_at < ?
    `);
    return stmt.run(cutoffTime);
  },

  /**
   * Get total cache size
   * @returns {number} - Total cached messages
   */
  getTotalCacheSize() {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM cached_messages`);
    return stmt.get().count;
  },

  /**
   * Prune cache if it exceeds max size (delete oldest first)
   * @param {number} maxMessages - Maximum messages to keep
   * @returns {Object} - Result with changes count
   */
  pruneCache(maxMessages) {
    const currentSize = this.getTotalCacheSize();
    if (currentSize <= maxMessages) {
      return { changes: 0 };
    }

    const toDelete = currentSize - maxMessages;
    const stmt = db.prepare(`
      DELETE FROM cached_messages 
      WHERE id IN (
        SELECT id FROM cached_messages 
        ORDER BY created_at ASC 
        LIMIT ?
      )
    `);
    return stmt.run(toDelete);
  },

  /**
   * Get the last message from a specific user in a channel
   * @param {string} channelId - Discord channel ID
   * @param {string} userId - User ID
   * @returns {Object|null} - Last message or null
   */
  getLastUserMessage(channelId, userId) {
    const stmt = db.prepare(`
      SELECT * FROM cached_messages 
      WHERE channel_id = ? AND author_id = ? AND deleted = 0
        AND content NOT LIKE '!%' AND content NOT LIKE '/%'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(channelId, userId);
  },

  /**
   * Get messages since a specific timestamp
   * @param {string} channelId - Discord channel ID
   * @param {number} sinceTimestamp - Unix timestamp
   * @param {string} botUserId - Bot's user ID to exclude
   * @param {number} limit - Max messages to return
   * @returns {Array} - Array of cached message objects
   */
  getMessagesSince(channelId, sinceTimestamp, botUserId, limit) {
    const stmt = db.prepare(`
      SELECT * FROM cached_messages 
      WHERE channel_id = ? AND created_at > ? AND deleted = 0 AND author_id != ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(channelId, sinceTimestamp, botUserId, limit);
  },

  /**
   * Search messages containing a keyword (case-insensitive)
   * @param {string} channelId - Discord channel ID
   * @param {string} keyword - Keyword to search for
   * @param {string} botUserId - Bot's user ID to exclude
   * @param {number} limit - Max messages to return
   * @returns {Array} - Array of cached message objects
   */
  searchMessages(channelId, keyword, botUserId, limit) {
    const stmt = db.prepare(`
      SELECT * FROM cached_messages 
      WHERE channel_id = ? AND content LIKE ? AND deleted = 0 AND author_id != ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, `%${keyword}%`, botUserId, limit);
  }
};
