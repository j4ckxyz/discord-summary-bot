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
  // Check if user is on cooldown
  isOnCooldown(userId, guildId, cooldownMinutes) {
    const stmt = db.prepare(`
      SELECT last_used FROM cooldowns 
      WHERE user_id = ? AND guild_id = ?
    `);
    const result = stmt.get(userId, guildId);
    
    if (!result) return false;
    
    const now = Math.floor(Date.now() / 1000);
    const cooldownSeconds = cooldownMinutes * 60;
    return (now - result.last_used) < cooldownSeconds;
  },

  // Get remaining cooldown time in seconds
  getRemainingCooldown(userId, guildId, cooldownMinutes) {
    const stmt = db.prepare(`
      SELECT last_used FROM cooldowns 
      WHERE user_id = ? AND guild_id = ?
    `);
    const result = stmt.get(userId, guildId);
    
    if (!result) return 0;
    
    const now = Math.floor(Date.now() / 1000);
    const cooldownSeconds = cooldownMinutes * 60;
    const elapsed = now - result.last_used;
    return Math.max(0, cooldownSeconds - elapsed);
  },

  // Update user's last used timestamp
  updateCooldown(userId, guildId) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO cooldowns (user_id, guild_id, last_used)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, guild_id) 
      DO UPDATE SET last_used = ?
    `);
    return stmt.run(userId, guildId, now, now);
  }
};
