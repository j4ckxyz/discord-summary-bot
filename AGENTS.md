# Agent Guidelines for Discord Summary Bot

## Build/Run Commands
- `npm start` - Run the bot in production
- `npm run dev` - Run with auto-reload on file changes
- No test suite currently configured

## Code Style & Conventions

**Imports:** ES6 modules (`import`/`export`), alphabetical order preferred  
**Formatting:** 2-space indentation, single quotes for strings  
**File Structure:** Classes exported as singleton instances (e.g., `export default new ClassName()`)  
**Naming:** camelCase for variables/functions, PascalCase for classes, UPPER_CASE for constants  
**Error Handling:** Try-catch blocks with logger.error(), throw descriptive Error objects  
**JSDoc:** Use JSDoc comments for all public methods with @param and @returns  
**Database:** better-sqlite3 with prepared statements, models in `src/database/models.js`  
**Config:** All settings in `config/config.json` (falls back to `config.example.json`), imported via `src/utils/config.js`  
**Logging:** Use `logger` from `src/utils/logger.js` (methods: info, warn, error, debug)  
**Discord.js:** v14+ syntax, async/await for all Discord API calls  
**Environment:** Node.js 18+, .env for secrets (DISCORD_BOT_TOKEN, LLM_API_KEY, LLM_PROVIDER, LLM_MODEL)

## Key Patterns
- Rate limiting uses sliding window (tracks individual uses, not just cooldown expiry)
- Config values must be used dynamically (e.g., help messages pull from config, not hardcoded)
- Bot filters out its own messages from summaries using `botUserId`
- Database migrations handled in `src/database/db.js` on startup
