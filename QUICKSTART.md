# Quick Start Guide

Get your Discord Summary Bot running in 5 minutes!

## Step 1: Get a Google AI API Key (Free)

1. Visit https://aistudio.google.com/app/apikey
2. Click "Create API Key"
3. Copy your API key

## Step 2: Create a Discord Bot

1. Go to https://discord.com/developers/applications
2. Click "New Application" and give it a name
3. Go to "Bot" section and click "Add Bot"
4. Under "Privileged Gateway Intents", enable **Message Content Intent**
5. Click "Reset Token" and copy your bot token
6. Go to OAuth2 > URL Generator:
   - Select scopes: `bot` and `applications.commands`
   - Select permissions: `Read Messages/View Channels`, `Send Messages`, `Read Message History`
   - Copy the generated URL and open it to invite the bot to your server

## Step 3: Configure the Bot

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials
nano .env  # or use your preferred editor
```

Your `.env` should look like:
```
DISCORD_BOT_TOKEN=your_discord_token_here
LLM_API_KEY=your_google_api_key_here
LLM_PROVIDER=google
LLM_MODEL=gemini-2.0-flash-exp
```

## Step 4: Install and Run

```bash
# Install dependencies
npm install

# Start the bot
npm start
```

You should see:
```
[timestamp] [INFO] Logged in as YourBot#1234
[timestamp] [INFO] Bot is ready to summarise!
```

4. **Test the Bot**:
   Go to a channel where the bot is present and type:
   ```
   /summary              (Slash command)
   !summary              (Prefix command)
   ```

The bot will generate a summary of all messages since the last summary!

## Customisation (Optional)

Copy the config template and edit settings:
```bash
cp config/config.example.json config/config.json
nano config/config.json
```

Available settings:
- `cooldownMinutes`: Change cooldown period (default: 30)
- `maxSummaryLength`: Adjust summary length (default: 300)
- `maxMessagesToFetch`: Change how many messages to look back (default: 100)

## Using a Different LLM Provider

### OpenRouter
```env
LLM_PROVIDER=openrouter
LLM_API_KEY=your_openrouter_key
LLM_MODEL=anthropic/claude-3.5-sonnet
```

### OpenAI
```env
LLM_PROVIDER=openai
LLM_API_KEY=your_openai_key
LLM_MODEL=gpt-4-turbo
```

## Troubleshooting

**Bot shows offline**
- Check your Discord bot token is correct
- Ensure you've saved the `.env` file

**Slash command doesn't appear**
- Wait a few minutes for Discord to sync commands
- Try kicking and re-inviting the bot

**"No messages to summarise" error**
- This is normal if no one has chatted since the last summary
- Try sending some test messages first

**Gemini API errors**
- Verify your API key at https://aistudio.google.com/app/apikey
- Check you haven't exceeded the free tier limits (very generous)

Need more help? Check the full README.md!
