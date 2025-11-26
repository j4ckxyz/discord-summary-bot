# Agent Guidelines for Discord Summary Bot

## Build/Run Commands
- `npm start` - Run the bot in production
- `npm run dev` - Run with auto-reload (Node.js --watch)
- `node --check src/file.js` - Syntax check without running
- No test suite configured

## Code Style & Conventions
**Imports:** ES6 modules, group by: external deps, then local (services, utils, config)  
**Formatting:** 2-space indent, single quotes, no semicolons optional but be consistent  
**Exports:** Classes as singletons (`export default new ClassName()`)  
**Naming:** camelCase (vars/funcs), PascalCase (classes), UPPER_CASE (constants)  
**Error Handling:** Try-catch with `logger.error()`, throw descriptive Error objects  
**JSDoc:** Required for public methods with @param and @returns  
**Logging:** Use categorised logger: `logger.llm()`, `logger.embed()`, `logger.cmd()`, `logger.cache()`, `logger.bot()`

## Architecture
**LLM:** Gemini (default) or OpenRouter, configured via `LLM_PROVIDER` env var  
**Embeddings:** OpenRouter API for semantic search (`EMBEDDING_API_KEY`, `EMBEDDING_MODEL`)  
**Database:** better-sqlite3, migrations in `src/database/db.js`, models in `src/database/models.js`  
**Config:** `config/config.json` (falls back to `config.example.json`), accessed via `src/utils/config.js`  
**Environment:** Node.js 18+, secrets in `.env` (DISCORD_BOT_TOKEN, LLM_API_KEY, EMBEDDING_API_KEY)
