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

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_guild_channel 
    ON summaries(guild_id, channel_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cooldowns_user_guild_channel 
    ON cooldowns(user_id, guild_id, channel_id, timestamp);
  `);
};

// Run migration first, then initialize
migrateDb();
initDb();

export default db;
