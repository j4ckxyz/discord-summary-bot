# Discord Summary Bot 🤖

A powerful, feature-rich Discord bot that uses AI (Google Gemini or OpenAI) to summarize conversations, manage tasks, schedule events, and play games!

## ✨ Features

### 🧠 AI Summarization
- **`/summary`**: Summarize recent chat history.
    - `/summary` (last 300 msgs)
    - `/summary 500` (count)
    - `/summary @user` (focus on specific user)
- **`/catchup`**: Get a personalized summary of what you missed while away.
    - Auto-detects your last message or accepts time ranges (`1h`, `24h`).
- **`/topic <keyword>`**: Find and summarize discussions about a specific topic.
- **`/explain <concept>`**: Ask the AI to explain a concept based on chat history.

### 📅 Productivity & Tools
- **`/remind`**: Set natural language reminders ("remind me to check logs in 2 hours").
    - Supports personal DMs and channel reminders.
- **`/todo`**: Manage a personal task list.
- **`/event`**: Create scheduled events with "Join" buttons and notifications.
- **`/frees`**: Analyze chat to see when people are free/available.
- **`/search`**: Search the web and get AI-summarized answers with sources.
- **`/timer`**: Set a countdown timer.

### 🎮 Games & Fun
- **`/imposter`**: Play "Word Chameleon" (Imposter) with friends or AI bots!
    - **Add AI Bots**: `/imposter addbot` (Play solo or fill the lobby!)
    - **Voting**: `/imposter vote` (Interactive voting system)
    - **Roles**: Secret roles revealed via button clicks.
- **`/roll` / `/flip`**: Dice roll and coin flip.
- **`/poll`**: Create simple polls.

---

## 🚀 Setup Guide

### Prerequisites
- Node.js v18+
- SQLite3
- A Discord Bot Token [Get one here](https://discord.com/developers/applications)
- A Google Gemini API Key [Get one here](https://makersuite.google.com/app/apikey) (or OpenAI Key)

### Installation
1.  **Clone the repo**
    ```bash
    git clone https://github.com/yourusername/discord-summary-bot.git
    cd discord-summary-bot
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment**
    Create a `.env` file in the root directory:
    ```env
    DISCORD_BOT_TOKEN=your_discord_token_here
    LLM_API_KEY=your_gemini_key_here
    LLM_PROVIDER=google
    # LLM_MODEL=gemini-2.0-flash-exp (Optional, defaults to gemini-2.0-flash-exp)
    ```

4.  **Run the Bot**
    ```bash
    npm start
    ```

---

## 🛠️ Commands List

| Command | Description |
| :--- | :--- |
| `/summary [count/user]` | Summarize channel messages. |
| `/catchup [time]` | Summarize what you missed. |
| `/topic [keyword]` | Search for a topic. |
| `/remind [what] [when]` | Set a reminder. |
| `/event create` | Schedule an event. |
| `/imposter create` | Start an Imposter game lobby. |
| `/imposter addbot` | Add an AI player to the game. |
| `/imposter vote` | Start a vote to eject the imposter. |
| `/search [query]` | AI Web Search. |

---

## 🔒 Permissions
Ensure the bot has the following permissions in your server:
- Read Messages / View Channels
- Send Messages
- Embed Links
- Add Reactions
- Use External Emojis
- Manage Messages (Optional: for cleaner game moderation)

## 🤝 Contributing
Feel free to open issues or submit PRs!
