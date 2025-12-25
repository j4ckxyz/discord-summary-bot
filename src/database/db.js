import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '..', '..', 'data');
const dbPath = join(dataDir, 'bot.db');

// Ensure data directory exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Check if a table column exists
const columnExists = (tableName, columnName) => {
  const result = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return result.some(col => col.name === columnName);
};

// Migrate existing database schema
const migrateDb = () => {
  // Check if cooldowns table exists and has the old schema
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cooldowns'").all();

  if (tables.length > 0) {
    // Table exists, check if it has the new schema
    if (!columnExists('cooldowns', 'channel_id')) {
      console.log('Migrating cooldowns table to new schema...');

      // Drop old index if it exists
      db.exec(`DROP INDEX IF EXISTS idx_cooldowns_user_guild;`);

      // Rename old table
      db.exec(`ALTER TABLE cooldowns RENAME TO cooldowns_old;`);

      // Create new table with correct schema
      db.exec(`
        CREATE TABLE cooldowns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);

      // Try to migrate old data (set channel_id to empty string for old records)
      // Note: Old records will naturally expire after 30 minutes
      try {
        db.exec(`
          INSERT INTO cooldowns (user_id, guild_id, channel_id, timestamp)
          SELECT user_id, guild_id, '', last_used FROM cooldowns_old
        `);
      } catch (error) {
        console.warn('Could not migrate old cooldown data, starting fresh:', error.message);
      }

      // Drop old table
      db.exec(`DROP TABLE cooldowns_old;`);

      console.log('Migration complete!');
    }
  }

  // Migrate beer_profiles table to add new tolerance columns
  const beerTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beer_profiles'").all();
  if (beerTables.length > 0) {
    const newColumns = [
      'tolerance_description',
      'tolerance_beers',
      'tolerance_confidence',
      'tolerance_last_updated',
      'activity_days',
      'last_activity_date'
    ];

    for (const col of newColumns) {
      if (!columnExists('beer_profiles', col)) {
        console.log(`Adding column ${col} to beer_profiles table...`);
        try {
          let colDef = 'TEXT';
          if (col === 'tolerance_beers' || col === 'tolerance_confidence') {
            colDef = 'REAL';
          }
          if (col === 'activity_days' || col === 'tolerance_last_updated') {
            colDef = 'INTEGER';
          }

          const defaultClause = (col === 'tolerance_confidence') ? 'DEFAULT 0.5' :
                             (col === 'activity_days') ? 'DEFAULT 0' : '';

          db.exec(`ALTER TABLE beer_profiles ADD COLUMN ${col} ${colDef} ${defaultClause}`);
          console.log(`Column ${col} added successfully`);
        } catch (error) {
          console.warn(`Could not add column ${col}:`, error.message);
        }
      }
    }
  }
};

// Create tables
const initDb = () => {
  // Table to track summary messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Table to track user cooldowns (now tracks usage count in time window)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cooldowns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  // Table to cache messages for faster repeated summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS cached_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL,
      reference_id TEXT,
      cached_at INTEGER NOT NULL,
      deleted INTEGER DEFAULT 0
    )
  `);

  // Table to track reminders
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message TEXT NOT NULL,
      time INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      completed INTEGER DEFAULT 0
    )
  `);

  // Table to track todos
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      assignee_id TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);

  // Table to track events
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      time INTEGER NOT NULL,
      attendees TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    )
  `);

  // Table to track guild settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      max_reminders INTEGER DEFAULT 5,
      max_todos INTEGER DEFAULT 20,
      max_events INTEGER DEFAULT 5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Table to track beer profiles (private user data)
  db.exec(`
    CREATE TABLE IF NOT EXISTS beer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      age INTEGER NOT NULL,
      height INTEGER,
      weight INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Table to track beer logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS beer_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Table to track drinking sessions per day (for tolerance calculation)
  db.exec(`
    CREATE TABLE IF NOT EXISTS beer_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      date TEXT NOT NULL,
      beer_count INTEGER DEFAULT 1,
      sessions_count INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, guild_id, date)
    )
  `);

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_guild_channel 
    ON summaries(guild_id, channel_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cooldowns_user_guild_channel 
    ON cooldowns(user_id, guild_id, channel_id, timestamp);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_channel_time 
    ON cached_messages(channel_id, created_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_channel_deleted 
    ON cached_messages(channel_id, deleted);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_beer_logs_user_guild 
    ON beer_logs(user_id, guild_id, date);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_beer_logs_guild_date 
    ON beer_logs(guild_id, date);
  `);

  // Add author_display_name column if it doesn't exist
  try {
    db.exec(`ALTER TABLE cached_messages ADD COLUMN author_display_name TEXT`);
  } catch (error) {
    // Column already exists, ignore
  }
};

// Run migration first, then initialize
migrateDb();
initDb();

export default db;
