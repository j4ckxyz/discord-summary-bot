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
