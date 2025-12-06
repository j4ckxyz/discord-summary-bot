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
            messages: [], // Store clues for recap
            usedWords: new Set(),
            meetingsCalled: new Map() // PlayId -> count
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
            game.usedWords.add(message.content.toLowerCase());

            // Advance turn
            game.turnIndex = (game.turnIndex + 1) % game.players.length;

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
    async playBotTurn(channel) {
        const game = this.games.get(channel.id);
        if (!game || game.status !== 'PLAYING') return null;

        const currentPlayer = game.players[game.turnIndex];
        if (!currentPlayer.isBot) return null;

        // Generate move
        const isImposter = currentPlayer.id === game.imposterId;
        const recentHistory = game.messages.slice(-5).map(m => `${m.player}: ${m.content}`);

        const turnData = await llmService.generateImposterTurn(
            game.word,
            game.category,
            recentHistory,
            isImposter,
            Array.from(game.usedWords)
        );

        if (turnData.action === 'VOTE') {
            try {
                // Bots can try to vote, but might be limited
                await channel.send(`🤖 **${currentPlayer.name}** triggered an Emergency Meeting!\nReason: "${turnData.value}"`);
                await this.triggerMeeting(channel, currentPlayer.id);
                return { action: 'VOTE', name: currentPlayer.name };
            } catch (e) {
                // If bot failed to vote (limit reached), fallback to clue
                // Just generate a simple clue to keep game moving
            }
        }

        // Default to CLUE if VOTE failed or action was CLUE
        let clue = turnData.value;
        if (turnData.action !== 'CLUE') {
            // Fallback generation if we tried to vote but failed
            clue = await llmService.generateImposterClue(game.word, game.category, recentHistory, isImposter, Array.from(game.usedWords));
        }

        // Record move
        game.messages.push({
            player: currentPlayer.name,
            content: clue
        });
        game.usedWords.add(clue.toLowerCase());

        // Advance turn
        game.turnIndex = (game.turnIndex + 1) % game.players.length;

        return { action: 'CLUE', name: currentPlayer.name, clue, isImposter };
    }

    isBotTurn(channelId) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return false;
        return game.players[game.turnIndex].isBot;
    }

    getCurrentPlayer(channelId) {
        const game = this.games.get(channelId);
        if (!game) return null;
        return game.players[game.turnIndex];
    }

    async startVote(channelId, interaction) {
        // Human triggered vote
        await this.triggerMeeting(interaction.channel, interaction.user.id);
    }

    async triggerMeeting(channel, callerId) {
        const channelId = channel.id;
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') throw new Error('Game not in progress.');

        // Check limits
        const calledCount = game.meetingsCalled.get(callerId) || 0;
        if (calledCount >= 1) {
            throw new Error('You have already called an Emergency Meeting this game!');
        }
        game.meetingsCalled.set(callerId, calledCount + 1);

        // Stop the game
        game.status = 'VOTING';

        const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

        let voteMessage = "**🚨 EMERGENCY MEETING! 🚨**\n\nVote for the Imposter by reacting with the number!\n\n";
        game.players.forEach((p, i) => {
            voteMessage += `${numberEmojis[i]} **${p.name}**\n`;
        });
        voteMessage += "\n(Voting ends in 60s)";

        const msg = await channel.send(voteMessage);

        for (let i = 0; i < game.players.length; i++) {
            if (i < numberEmojis.length) await msg.react(numberEmojis[i]);
        }

        const collector = msg.createReactionCollector({ time: 60000 });

        collector.on('end', async (collected) => {
            const votes = new Array(game.players.length).fill(0);

            collected.forEach((reaction) => {
                const index = numberEmojis.indexOf(reaction.emoji.name);
                if (index >= 0 && index < game.players.length) {
                    votes[index] = reaction.count - 1; // Subtract bot's reaction
                }
            });

            let maxVotes = -1;
            let winnerIndex = -1;
            let tie = false;

            for (let i = 0; i < votes.length; i++) {
                if (votes[i] > maxVotes) {
                    maxVotes = votes[i];
                    winnerIndex = i;
                    tie = false;
                } else if (votes[i] === maxVotes) {
                    tie = true;
                }
            }

            const imposterPlayer = game.players.find(p => p.id === game.imposterId);

            let resultMsg = "**🗳️ VOTING ENDED!**\n\n";
            if (tie || maxVotes === 0) {
                resultMsg += `🤷 It was a tie (or no votes)! No one was ejected.\n`;
                // Resume game
                game.status = 'PLAYING';
                resultMsg += `\n**Game Resuming...**`;
                await channel.send(resultMsg);
            } else {
                const ejected = game.players[winnerIndex];
                const wasImposter = ejected.id === game.imposterId;
                resultMsg += `👋 **${ejected.name}** was voted out with ${maxVotes} votes!\n\n`;
                resultMsg += wasImposter ? `✅ **THEY WERE THE IMPOSTER!**` : `❌ **They were NOT the imposter...**`;

                resultMsg += `\n\n🕵️ **The Real Imposter:** ${imposterPlayer.name}`;
                resultMsg += `\n📖 **The Secret Word:** ${game.word}`;

                // End game
                this.games.delete(channelId);
                await channel.send(resultMsg);
            }
        });
    }

    endGame(channelId) {
        this.games.delete(channelId);
    }
}

export default new ImposterService();
