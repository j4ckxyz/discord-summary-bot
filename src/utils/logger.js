/**
 * Logger utility with categories for clearer systemd/journalctl output
 */
class Logger {
  constructor() {
    this.levels = {
      ERROR: 'ERROR',
      WARN: 'WARN',
      INFO: 'INFO',
      DEBUG: 'DEBUG'
    };
    
    // Category prefixes for easy filtering in logs
    this.categories = {
      BOT: 'BOT',
      LLM: 'LLM',
      EMBED: 'EMBED',
      CACHE: 'CACHE',
      CMD: 'CMD',
      DB: 'DB',
      QUEUE: 'QUEUE',
      BEER: 'BEER'
    };

    // Check if debug mode is enabled
    this.debugEnabled = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  }

  /**
   * Format a log message with timestamp, level, and optional category
   */
  _format(level, category, message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const categoryStr = category ? `[${category}]` : '';
    return `[${timestamp}] [${level}]${categoryStr} ${message}`;
  }

  /**
   * Internal log method
   */
  _log(level, category, ...args) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    console.log(this._format(level, category, message));
  }

  // Standard log methods (without category)
  error(...args) {
    this._log(this.levels.ERROR, null, ...args);
  }

  warn(...args) {
    this._log(this.levels.WARN, null, ...args);
  }

  info(...args) {
    this._log(this.levels.INFO, null, ...args);
  }

  debug(...args) {
    if (this.debugEnabled) {
      this._log(this.levels.DEBUG, null, ...args);
    }
  }

  // Categorised log methods for specific subsystems

  /**
   * Bot-related logs (startup, commands, Discord events)
   */
  bot(message, level = 'INFO') {
    this._log(level, this.categories.BOT, message);
  }

  /**
   * LLM-related logs (Gemini/OpenRouter API calls)
   */
  llm(message, level = 'INFO') {
    this._log(level, this.categories.LLM, message);
  }

  /**
   * Embedding-related logs (semantic search, OpenRouter embeddings)
   */
  embed(message, level = 'INFO') {
    this._log(level, this.categories.EMBED, message);
  }

  /**
   * Cache-related logs (message caching, maintenance)
   */
  cache(message, level = 'INFO') {
    this._log(level, this.categories.CACHE, message);
  }

  /**
   * Command-related logs (user commands, slash/prefix)
   */
  cmd(message, level = 'INFO') {
    this._log(level, this.categories.CMD, message);
  }

  /**
   * Database-related logs
   */
  db(message, level = 'INFO') {
    this._log(level, this.categories.DB, message);
  }

  /**
    * Request queue logs
    */
  queue(message, level = 'INFO') {
    this._log(level, this.categories.QUEUE, message);
  }

  /**
    * Beer tracker logs
    */
  beer(message, level = 'INFO') {
    this._log(level, this.categories.BEER, message);
  }

  /**
    * Log a separator line for visual clarity
    */
  separator() {
    console.log('─'.repeat(60));
  }

  /**
   * Log the start of a major operation
   */
  startOperation(operation, details = '') {
    const detailStr = details ? ` | ${details}` : '';
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${operation}${detailStr}`);
    console.log('─'.repeat(60));
  }
}

export default new Logger();
