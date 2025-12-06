import logger from '../utils/logger.js';
import llmService from './llm.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

class ImposterService {
    constructor() {
        // Map<channelId, GameState>
        this.games = new Map();
    }

    /**
     * Create a new game lobby in a channel
     */
    createGame(channelId, creatorId, creatorName) {
        if (this.games.has(channelId)) {
            throw new Error('A game is already in progress in this channel.');
        }

        this.games.set(channelId, {
            status: 'LOBBY', // LOBBY, PLAYING, VOTING
            players: [{ id: creatorId, name: creatorName, score: 0 }],
            hostId: creatorId,
            word: null,
            category: null,
            imposterId: null,
            turnIndex: 0,
            round: 0,
            maxRounds: 2, // 2 rounds of clues before voting
            messages: [] // Store clues for recap
        });

        return this.games.get(channelId);
    }

    getGame(channelId) {
        return this.games.get(channelId);
    }

    joinGame(channelId, userId, userName) {
        const game = this.games.get(channelId);
        if (!game) throw new Error('No game found in this channel.');
        if (game.status !== 'LOBBY') throw new Error('Game already started.');
        if (game.players.some(p => p.id === userId)) throw new Error('You already joined.');

        game.players.push({ id: userId, name: userName, score: 0 });
        return game;
    }

    async startGame(channelId, userId) {
        const game = this.games.get(channelId);
        if (!game) throw new Error('No game found.');
        if (game.hostId !== userId) throw new Error('Only the host can start the game.');
        if (game.players.length < 2) throw new Error('Need at least 2 players to start.');

        // Fetch word from LLM
        const data = await llmService.generateImposterGame();
        game.word = data.word;
        game.category = data.category;

        // Pick Imposter
        const imposterIndex = Math.floor(Math.random() * game.players.length);
        game.imposterId = game.players[imposterIndex].id;

        game.status = 'PLAYING';
        game.turnIndex = Math.floor(Math.random() * game.players.length); // Random start
        game.round = 1;
        game.messages = [];

        return game;
    }

    /**
     * Handle a user message during the game
     * Returns true if message should be kept, false if it should be deleted (out of turn)
     */
    handleMessage(channelId, message) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return true;

        if (message.author.bot) return true; // Ignore bots
        if (!game.players.some(p => p.id === message.author.id)) return true; // Ignore non-players (maybe?)

        const currentPlayer = game.players[game.turnIndex];

        // If it's the current player's turn
        if (message.author.id === currentPlayer.id) {
            // Check content length (should be short-ish)
            game.messages.push({
                player: currentPlayer.name,
                content: message.content
            });

            // Advance turn
            game.turnIndex = (game.turnIndex + 1) % game.players.length;

            // Check if loop completed
            if (game.turnIndex === 0) { // Naive round check, assumes Player 0 started loop? No.
                // Actually we just count turns. 
                // Better: Track how many moves made. 
            }

            // We need to notify next player.
            // Return 'PROCESS_TURN' to let bot.js know to trigger next turn msg
            return 'VALID_MOVE';
        } else {
            // Out of turn!
            return 'OUT_OF_TURN';
        }
    }

    addBot(channelId) {
        const game = this.games.get(channelId);
        if (!game) throw new Error('No game lobby found. Create one first.');
        if (game.status !== 'LOBBY') throw new Error('Game already started.');

        const botNumber = game.players.filter(p => p.isBot).length + 1;
        const botName = `Bot ${botNumber}`;
        const botId = `bot_${Date.now()}_${botNumber}`;

        game.players.push({
            id: botId,
            name: botName,
            score: 0,
            isBot: true
        });

        return game;
    }

    /**
     * Trigger a bot turn if it is currently a bot's turn
     * @returns {Promise<string|null>} The clue the bot gave, or null if not bot turn
     */
    async playBotTurn(channelId) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return null;

        const currentPlayer = game.players[game.turnIndex];
        if (!currentPlayer.isBot) return null;

        // Generate clue
        const isImposter = currentPlayer.id === game.imposterId;
        // Get last few messages as context
        const recentHistory = game.messages.slice(-5).map(m => `${m.player}: ${m.content}`);

        const clue = await llmService.generateImposterClue(
            game.word,
            game.category,
            recentHistory,
            isImposter
        );

        // Record move
        game.messages.push({
            player: currentPlayer.name,
            content: clue
        });

        // Advance turn
        game.turnIndex = (game.turnIndex + 1) % game.players.length;

        return { name: currentPlayer.name, clue, isImposter };
    }

    isBotTurn(channelId) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return false;
        return game.players[game.turnIndex].isBot;
    }

    // Helper to advance game state manually or check rounds
    // This is a bit simplified. Ideally we track "turns taken" vs "total players"
    getCurrentPlayer(channelId) {
        const game = this.games.get(channelId);
        if (!game) return null;
        return game.players[game.turnIndex];
    }

    endGame(channelId) {
        this.games.delete(channelId);
    }
}

export default new ImposterService();
