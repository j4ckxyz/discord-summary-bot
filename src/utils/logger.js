class Logger {
  constructor() {
    this.levels = {
      ERROR: 'ERROR',
      WARN: 'WARN',
      INFO: 'INFO',
      DEBUG: 'DEBUG'
    };
  }

  _log(level, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}]`, ...args);
  }

  error(...args) {
    this._log(this.levels.ERROR, ...args);
  }

  warn(...args) {
    this._log(this.levels.WARN, ...args);
  }

  info(...args) {
    this._log(this.levels.INFO, ...args);
  }

  debug(...args) {
    this._log(this.levels.DEBUG, ...args);
  }
}

export default new Logger();
