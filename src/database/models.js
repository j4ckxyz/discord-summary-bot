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

export const ReminderModel = {
  createReminder(userId, guildId, channelId, message, time, isPublic = 0) {
    const now = Math.floor(Date.now() / 1000);

    // Ensure column exists (naive migration for this session)
    try {
      db.prepare('ALTER TABLE reminders ADD COLUMN is_public INTEGER DEFAULT 0').run();
    } catch (e) {
      // Column likely exists
    }

    const stmt = db.prepare(`
      INSERT INTO reminders (user_id, guild_id, channel_id, message, time, created_at, is_public)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(userId, guildId, channelId, message, time, now, isPublic ? 1 : 0);
  },

  getDueReminders() {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      SELECT * FROM reminders 
      WHERE time <= ? AND completed = 0
    `);
    return stmt.all(now);
  },

  markReminderComplete(id) {
    const stmt = db.prepare(`
      UPDATE reminders SET completed = 1 WHERE id = ?
    `);
    return stmt.run(id);
  },

  getUserReminders(userId, guildId) {
    const stmt = db.prepare(`
      SELECT * FROM reminders 
      WHERE user_id = ? AND guild_id = ? AND completed = 0
      ORDER BY time ASC
    `);
    return stmt.all(userId, guildId);
  },

  deleteReminder(id, userId) {
    const stmt = db.prepare(`
      DELETE FROM reminders WHERE id = ? AND user_id = ?
    `);
    return stmt.run(id, userId);
  },

  deleteReminderForce(id) {
    const stmt = db.prepare(`
        DELETE FROM reminders WHERE id = ?
    `);
    return stmt.run(id);
  },

  getReminder(id) {
    const stmt = db.prepare('SELECT * FROM reminders WHERE id = ?');
    return stmt.get(id);
  },

  updateReminder(id, message, time) {
    // Only update fields if provided (though calling code usually provides all)
    const stmt = db.prepare(`
        UPDATE reminders 
        SET message = COALESCE(?, message), 
            time = COALESCE(?, time),
            completed = 0
        WHERE id = ?
      `);
    return stmt.run(message, time, id);
  },

  // Clean up old completed reminders (optional maintenance)
  cleanupCompletedReminders(daysToKeep = 7) {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - (daysToKeep * 24 * 60 * 60);
    const stmt = db.prepare('DELETE FROM reminders WHERE completed = 1 AND time < ?');
    return stmt.run(cutoff);
  }
};

export const TodoModel = {
  createTodo(guildId, channelId, creatorId, content, assigneeId = null) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO todos (guild_id, channel_id, creator_id, assignee_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(guildId, channelId, creatorId, assigneeId, content, now);
  },

  getChannelTodos(guildId, channelId) {
    const stmt = db.prepare(`
      SELECT * FROM todos 
      WHERE guild_id = ? AND channel_id = ? AND status != 'done'
      ORDER BY created_at ASC
    `);
    return stmt.all(guildId, channelId);
  },

  updateTodoStatus(id, status) {
    const stmt = db.prepare(`
      UPDATE todos SET status = ? WHERE id = ?
    `);
    return stmt.run(status, id);
  },

  assignTodo(id, assigneeId) {
    const stmt = db.prepare(`
      UPDATE todos SET assignee_id = ? WHERE id = ?
    `);
    return stmt.run(assigneeId, id);
  },

  deleteTodo(id) {
    const stmt = db.prepare(`
      DELETE FROM todos WHERE id = ?
    `);
    return stmt.run(id);
  }
};

export const EventModel = {
  createEvent(guildId, channelId, creatorId, name, description, time) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO events (guild_id, channel_id, creator_id, name, description, time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(guildId, channelId, creatorId, name, description, time, now);
  },

  getChannelEvents(guildId, channelId) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      SELECT * FROM events 
      WHERE guild_id = ? AND channel_id = ? AND time > ?
      ORDER BY time ASC
    `);
    return stmt.all(guildId, channelId, now);
  },

  addAttendee(eventId, userId) {
    const event = db.prepare('SELECT attendees FROM events WHERE id = ?').get(eventId);
    if (!event) return false;

    let attendees = [];
    try {
      attendees = JSON.parse(event.attendees);
    } catch (e) {
      attendees = [];
    }

    if (!attendees.includes(userId)) {
      attendees.push(userId);
      const stmt = db.prepare('UPDATE events SET attendees = ? WHERE id = ?');
      return stmt.run(JSON.stringify(attendees), eventId);
    }
    return { changes: 0 };
  },

  removeAttendee(eventId, userId) {
    const event = db.prepare('SELECT attendees FROM events WHERE id = ?').get(eventId);
    if (!event) return false;

    let attendees = [];
    try {
      attendees = JSON.parse(event.attendees);
    } catch (e) {
      attendees = [];
    }

    const newAttendees = attendees.filter(id => id !== userId);
    const stmt = db.prepare('UPDATE events SET attendees = ? WHERE id = ?');
    return stmt.run(JSON.stringify(newAttendees), eventId);
  },

  deleteEvent(id) {
    const stmt = db.prepare('DELETE FROM events WHERE id = ?');
    return stmt.run(id);
  },

  getEvent(id) {
    const stmt = db.prepare('SELECT * FROM events WHERE id = ?');
    return stmt.get(id);
  },

  updateEvent(id, name, description, time) {
    const stmt = db.prepare(`
        UPDATE events 
        SET name = COALESCE(?, name), 
            description = COALESCE(?, description),
            time = COALESCE(?, time)
        WHERE id = ?
      `);
    return stmt.run(name, description, time, id);
  },

  getDueEvents(timeWindowMinutes = 15) {
    const now = Math.floor(Date.now() / 1000);
    const window = now + (timeWindowMinutes * 60);
    const stmt = db.prepare(`
       SELECT * FROM events
       WHERE time > ? AND time <= ?
     `);
    return stmt.all(now, window);
  }
};

export const BeerModel = {
  getProfile(userId) {
    const stmt = db.prepare('SELECT * FROM beer_profiles WHERE user_id = ?');
    return stmt.get(userId);
  },

  upsertProfile(userId, age, height, weight, toleranceDescription) {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.getProfile(userId);

    if (existing) {
      const stmt = db.prepare(`
        UPDATE beer_profiles 
        SET age = COALESCE(?, age),
            height = COALESCE(?, height),
            weight = COALESCE(?, weight),
            tolerance_description = COALESCE(?, tolerance_description),
            updated_at = ?
        WHERE user_id = ?
      `);
      return stmt.run(age, height, weight, toleranceDescription, now, userId);
    } else {
      const stmt = db.prepare(`
        INSERT INTO beer_profiles (user_id, age, height, weight, tolerance_description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      return stmt.run(userId, age, height, weight, toleranceDescription, now, now);
    }
  },

  updateTolerance(userId, toleranceBeers, toleranceConfidence) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      UPDATE beer_profiles 
      SET tolerance_beers = ?,
          tolerance_confidence = ?,
          tolerance_last_updated = ?,
          updated_at = ?
      WHERE user_id = ?
    `);
    return stmt.run(toleranceBeers, toleranceConfidence, now, now, userId);
  },

  incrementActivityStreak(userId) {
    const stmt = db.prepare(`
      UPDATE beer_profiles 
      SET activity_days = COALESCE(activity_days, 0) + 1,
          last_activity_date = ?
      WHERE user_id = ?
    `);
    const today = new Date().toISOString().split('T')[0];
    return stmt.run(today, userId);
  },

  resetActivityStreak(userId) {
    const stmt = db.prepare(`
      UPDATE beer_profiles 
      SET activity_streak = 0
      WHERE user_id = ?
    `);
    return stmt.run(userId);
  },

  getProfilesForToleranceUpdate() {
    const stmt = db.prepare(`
      SELECT * FROM beer_profiles
      WHERE tolerance_last_updated IS NULL 
         OR tolerance_last_updated < ?
    `);
    const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    return stmt.all(oneDayAgo);
  },

  logBeer(userId, guildId, date) {
    const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
    const stmt = db.prepare(`
      INSERT INTO beer_logs (user_id, guild_id, date, created_at)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(userId, guildId, dateStr, Math.floor(Date.now() / 1000));
  },

  getBeerCount(userId, guildId, startDate = null, endDate = null) {
    let sql = 'SELECT COUNT(*) as count FROM beer_logs WHERE user_id = ?';
    const params = [userId];

    if (guildId) {
      sql += ' AND guild_id = ?';
      params.push(guildId);
    }

    if (startDate) {
      sql += ' AND date >= ?';
      params.push(typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0]);
    }

    if (endDate) {
      sql += ' AND date <= ?';
      params.push(typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0]);
    }

    const stmt = db.prepare(sql);
    const result = stmt.get(...params);
    return result.count;
  },

  getRecentBeers(userId, guildId, limit = 10) {
    const stmt = db.prepare(`
      SELECT * FROM beer_logs
      WHERE user_id = ? AND guild_id = ?
      ORDER BY date DESC, created_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, guildId, limit);
  },

  getLeaderboard(guildId, startDate, endDate) {
    const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
    const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

    const stmt = db.prepare(`
      SELECT 
        bl.user_id,
        bp.weight,
        COUNT(*) as beer_count,
        COUNT(DISTINCT bl.date) as drinking_days,
        MIN(bl.date) as first_date
      FROM beer_logs bl
      LEFT JOIN beer_profiles bp ON bl.user_id = bp.user_id
      WHERE bl.guild_id = ? AND bl.date >= ? AND bl.date <= ?
      GROUP BY bl.user_id
      ORDER BY beer_count DESC
    `);

    const entries = stmt.all(guildId, startDateStr, endDateStr);

    return entries.map(entry => {
      let bacEstimate = null;
      
      if (entry.weight) {
        const totalAlcohol = entry.beer_count * 14;
        const bodyWater = entry.weight * 0.6;
        bacEstimate = (totalAlcohol / bodyWater) * 100;
      }
      
      return {
        ...entry,
        bac_estimate: bacEstimate
      };
    });
  },

  getUserWeeklyStats(userId, guildId, startDate, endDate) {
    const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
    const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as beer_count,
        COUNT(DISTINCT date) as drinking_days,
        GROUP_CONCAT(date, ',') as drinking_dates
      FROM beer_logs
      WHERE user_id = ? AND guild_id = ? AND date >= ? AND date <= ?
    `);

    return stmt.get(userId, guildId, startDateStr, endDateStr);
  },

  recordDrinkingSession(userId, guildId, date, beerCount) {
    const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
    const stmt = db.prepare(`
      INSERT INTO beer_sessions (user_id, guild_id, date, beer_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id, date) DO UPDATE SET
        beer_count = beer_count + excluded.beer_count,
        sessions_count = sessions_count + 1,
        updated_at = ?
    `);
    const now = Math.floor(Date.now() / 1000);
    return stmt.run(userId, guildId, dateStr, beerCount, now, now);
  },

  getUserDrinkingPatterns(userId, guildId, days = 30) {
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total_sessions,
        AVG(beer_count) as avg_beers_per_session,
        MAX(beer_count) as max_beers,
        MIN(beer_count) as min_beers,
        COUNT(DISTINCT date) as drinking_days
      FROM beer_sessions
      WHERE user_id = ? AND guild_id = ? 
        AND date >= date('now', '-${days} days')
    `);
    return stmt.get(userId, guildId);
  },

  getSoberStreak(userId, guildId) {
    const stmt = db.prepare(`
      WITH RECURSIVE date_series(d) AS (
        SELECT date('now', '-14 days')
        UNION ALL
        SELECT date(d, '+1 day') FROM date_series WHERE d < date('now')
      ),
      sober_days AS (
        SELECT ds.d
        FROM date_series ds
        LEFT JOIN beer_sessions bs 
          ON bs.user_id = ? AND bs.guild_id = ? AND bs.date = ds.d
        WHERE bs.date IS NULL
        ORDER BY ds.d DESC
      )
      SELECT COUNT(*) as streak FROM sober_days
    `);
    const result = stmt.get(userId, guildId);
    return result ? result.streak : 0;
  },

  getAllUsersForLeaderboard(guildId) {
    const stmt = db.prepare(`
      SELECT DISTINCT user_id FROM beer_logs WHERE guild_id = ?
    `);
    return stmt.all(guildId).map(r => r.user_id);
  },

  getWeeklyLeaderboardAll(guildId, startDate, endDate) {
    const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
    const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

    const stmt = db.prepare(`
      SELECT 
        bl.user_id,
        bp.weight,
        COALESCE(COUNT(bl.id), 0) as beer_count,
        COALESCE(COUNT(DISTINCT bl.date), 0) as drinking_days,
        (SELECT COUNT(*) FROM beer_sessions 
         WHERE user_id = bl.user_id AND guild_id = bl.guild_id 
         AND date >= ? AND date < bl.date) as sober_days_count
      FROM (SELECT DISTINCT user_id FROM beer_logs WHERE guild_id = ?) all_users
      LEFT JOIN beer_logs bl ON all_users.user_id = bl.user_id 
        AND bl.guild_id = ? AND bl.date >= ? AND bl.date <= ?
      LEFT JOIN beer_profiles bp ON bl.user_id = bp.user_id
      GROUP BY bl.user_id
      ORDER BY beer_count DESC
    `);

    const entries = stmt.all(startDateStr, guildId, guildId, startDateStr, endDateStr);

    return entries.map(entry => {
      let bacEstimate = null;

      if (entry.weight && entry.beer_count > 0) {
        const totalAlcohol = entry.beer_count * 14;
        const bodyWater = entry.weight * 0.6;
        bacEstimate = (totalAlcohol / bodyWater) * 100;
      }

      return {
        ...entry,
        bac_estimate: bacEstimate
      };
    });
  }
};

export const SettingsModel = {
  getSettings(guildId) {
    const stmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
    const settings = stmt.get(guildId);

    if (!settings) {
      // Return defaults if no custom settings exist
      return {
        guild_id: guildId,
        max_reminders: 5,
        max_todos: 20,
        max_events: 5
      };
    }
    return settings;
  },

  updateSetting(guildId, key, value) {
    const now = Math.floor(Date.now() / 1000);

    // Ensure record exists
    const exists = db.prepare('SELECT 1 FROM guild_settings WHERE guild_id = ?').get(guildId);

    if (!exists) {
      const stmt = db.prepare(`
        INSERT INTO guild_settings (guild_id, max_reminders, max_todos, max_events, created_at, updated_at)
        VALUES (?, 5, 20, 5, ?, ?)
      `);
      stmt.run(guildId, now, now);
    }

    // Prepare update statement based on key (safeguard against injection/invalid keys)
    const allowedKeys = ['max_reminders', 'max_todos', 'max_events'];
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid setting key: ${key}`);
    }

    const stmt = db.prepare(`
      UPDATE guild_settings 
      SET ${key} = ?, updated_at = ? 
      WHERE guild_id = ?
    `);
    return stmt.run(value, now, guildId);
  }
};
