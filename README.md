# Discord Summary Bot

A Discord bot that generates AI-powered summaries of channel conversations using Google Gemini, OpenRouter, or any OpenAI-compatible API.

## Features

- **AI-Powered Summaries**: Uses LLMs to create concise, informative summaries of Discord conversations
- **Google Gemini Integration**: Uses Gemini 2.0 Flash by default for fast, free summarisation with high context length
- **Rate Limiting**: Each user can request a summary once every 30 minutes per server
- **Smart Message Tracking**: Automatically tracks the last summary and only summarises new messages
- **Reply Threading**: Replies to the previous summary to create a conversation thread
- **Modular LLM Support**: Works with Google Gemini, OpenRouter, OpenAI, or any OpenAI-compatible API
- **Configurable Models**: Choose any LLM model supported by your API provider
- **Lightweight**: Uses SQLite for efficient local storage

## Prerequisites

- Node.js 18.0.0 or higher
- A Discord Bot Token ([create one here](https://discord.com/developers/applications))
- A Google AI API key ([get one here](https://aistudio.google.com/app/apikey)) - Free tier available!

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/discord-summary-bot.git
   cd discord-summary-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your credentials:
   ```
   DISCORD_BOT_TOKEN=your_discord_bot_token_here
   LLM_API_KEY=your_google_api_key_here
   LLM_PROVIDER=google
   LLM_MODEL=gemini-2.0-flash-exp
   ```

4. **Configure bot settings (optional)**
   ```bash
   cp config/config.example.json config/config.json
   ```
   
   Edit `config/config.json` to customise:
   - `cooldownMinutes`: Cooldown period between summaries (default: 30)
   - `maxSummaryLength`: Maximum characters in summary (default: 300)
   - `maxMessagesToFetch`: Maximum messages to fetch (default: 100)
   - `summaryPrompt`: System prompt for the LLM

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application or select your existing one
3. Go to the "Bot" section and create a bot
4. Copy the bot token to your `.env` file
5. Enable the following **Privileged Gateway Intents**:
   - Message Content Intent
6. Go to OAuth2 > URL Generator and select:
   - **Scopes**: `bot`, `applications.commands`
   - **Bot Permissions**: 
     - Read Messages/View Channels
     - Send Messages
     - Read Message History
7. Copy the generated URL and use it to invite the bot to your server

## Usage

1. **Start the bot**
   ```bash
   npm start
   ```

### Commands

The bot supports the following commands:

```
/summary              (Slash command - recommended)
!summary              (Prefix command)
@SummaryBot           (Mention the bot)
```

The bot will:
- Check if you're on cooldown (30 minutes per user per server)
- Fetch all messages since the last summary
- Generate a concise summary using AI
- Reply to the previous summary (or post a new message if it's the first summary)

## Using Different LLM Providers

### Google Gemini (Default - Recommended)
```env
LLM_PROVIDER=google
LLM_MODEL=gemini-2.0-flash-exp
```

**Why Gemini?** Fast, free tier available, extremely high context length, and excellent quality.

Popular Gemini models:
- `gemini-2.0-flash-exp` (recommended - fastest, free tier)
- `gemini-1.5-flash`
- `gemini-1.5-pro`

Get your API key: https://aistudio.google.com/app/apikey

### OpenRouter
```env
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-3.5-sonnet
```

Popular OpenRouter models:
- `anthropic/claude-3.5-sonnet`
- `openai/gpt-4-turbo`
- `meta-llama/llama-3.1-8b-instruct`

### OpenAI
```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4-turbo
```

### Other OpenAI-Compatible APIs
Set `LLM_PROVIDER=openai` and provide a custom `LLM_API_BASE_URL` in your `.env` file.

## Configuration

### Environment Variables (`.env`)

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token | Yes | - |
| `LLM_API_KEY` | Your LLM API key | Yes | - |
| `LLM_PROVIDER` | API provider (google, openrouter, openai) | No | google |
| `LLM_MODEL` | Model to use for summaries | No | gemini-2.0-flash-exp |

### Config File (`config/config.json`)

| Setting | Description | Default |
|---------|-------------|---------|
| `cooldownMinutes` | Minutes between summary requests per user | 30 |
| `maxSummaryLength` | Maximum characters in summary | 300 |
| `maxMessagesToFetch` | Maximum messages to fetch and summarise | 100 |
| `summaryPrompt` | System prompt for the LLM | See config.example.json |

## Development

Run with auto-reload during development:
```bash
npm run dev
```

## Project Structure

```
discord-summary-bot/
├── src/
│   ├── bot.js                 # Main bot entry point
│   ├── commands/
│   │   └── summarise.js       # Summary slash command
│   ├── services/
│   │   ├── llm.js            # LLM API abstraction
│   │   ├── summariser.js     # Summarisation logic
│   │   └── ratelimit.js      # Rate limiting
│   ├── database/
│   │   ├── db.js             # Database connection
│   │   └── models.js         # Data models
│   └── utils/
│       ├── config.js         # Configuration loader
│       └── logger.js         # Logging utility
├── config/
│   └── config.example.json   # Example configuration
├── data/                      # SQLite database (auto-created)
├── .env.example              # Example environment variables
└── package.json
```

## Deployment

### Local/VPS
Simply run `npm start` on your server. Consider using a process manager like PM2:
```bash
npm install -g pm2
pm2 start src/bot.js --name discord-summary-bot
pm2 save
```

### Docker (Optional)
Create a `Dockerfile` and deploy to any container hosting service.

## Troubleshooting

**Bot doesn't respond to commands**
- Ensure you've enabled the Message Content Intent in Discord Developer Portal
- Verify the bot has proper permissions in your server
- Check the console for error messages

**Rate limit errors**
- Wait for the cooldown period to expire (check the ephemeral message for remaining time)

**LLM API errors**
- Verify your API key is correct
- Check that your API provider supports the model you've configured
- Ensure you have credits/quota available
- For Gemini: Ensure you're using a valid model name from Google AI Studio

## Licence

MIT Licence - See LICENSE file for details

## Contributing

Contributions are welcome! Please see CONTRIBUTING.md for guidelines.

## Support

If you encounter issues, please open an issue on GitHub with:
- Bot version
- Error messages from console
- Steps to reproduce
