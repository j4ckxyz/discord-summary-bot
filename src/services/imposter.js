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
            hint: null,
            imposterId: null,
            turnIndex: 0,
            turnOrder: [], // Array of player IDs in order
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
        game.hint = data.hint;

        // Pick Imposter
        const imposterIndex = Math.floor(Math.random() * game.players.length);
        game.imposterId = game.players[imposterIndex].id;

        game.status = 'PLAYING';
        // Create shuffled turn order
        game.turnOrder = [...game.players].sort(() => Math.random() - 0.5).map(p => p.id);
        game.turnIndex = 0; // Start with first player in shuffled list
        game.round = 1;
        game.messages = [];

        return game;
    }

    /**
     * Handle a user message during the game
     * Only accepts messages from the CURRENT player.
     * Returns: 'VALID_MOVE' | 'IGNORED'
     */
    handleMessage(channelId, message) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return { status: 'IGNORED' };
        if (message.author.bot) return { status: 'IGNORED' };

        // Get current player
        const currentUserId = game.turnOrder[game.turnIndex];
        const currentPlayer = game.players.find(p => p.id === currentUserId);

        // ONLY accept messages from the current player
        if (message.author.id !== currentUserId) {
            return { status: 'IGNORED' };
        }

        // It's the current player's message
        const content = message.content.trim();

        // Check for duplicate words
        if (game.usedWords.has(content.toLowerCase())) {
            return { status: 'DUPLICATE', word: content };
        }

        // Record the clue
        game.messages.push({
            player: currentPlayer.name,
            playerId: currentPlayer.id,
            content: content
        });
        game.usedWords.add(content.toLowerCase());

        // Advance turn
        game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;

        // Check if we completed a round
        if (game.turnIndex === 0) {
            game.round++;
        }

        return { status: 'VALID_MOVE', player: currentPlayer.name, clue: content };
    }

    /**
     * Get formatted clue history for display
     */
    getClueHistory(channelId) {
        const game = this.games.get(channelId);
        if (!game || game.messages.length === 0) return null;

        return game.messages.map((m, i) => `${i + 1}. **${m.player}**: ${m.content}`).join('\n');
    }

    /**
     * Get the current round number
     */
    getRound(channelId) {
        const game = this.games.get(channelId);
        return game ? game.round : 0;
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
        const recentHistory = game.messages.map(m => `${m.player}: ${m.content}`);

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
        game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;

        return { action: 'CLUE', name: currentPlayer.name, clue, isImposter };
    }

    isBotTurn(channelId) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'PLAYING') return false;

        const currentUserId = game.turnOrder[game.turnIndex];
        const currentPlayer = game.players.find(p => p.id === currentUserId);
        return currentPlayer.isBot;
    }

    getCurrentPlayer(channelId) {
        const game = this.games.get(channelId);
        if (!game) return null;

        if (game.status === 'LOBBY') return game.players[0]; // Host

        const currentUserId = game.turnOrder[game.turnIndex];
        return game.players.find(p => p.id === currentUserId);
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

        if (calledCount >= 3) {
            throw new Error('You have already called 3 Emergency Meetings this game!');
        }
        game.meetingsCalled.set(callerId, calledCount + 1);

        // Stop the game
        game.status = 'VOTING';

        // Build button rows (max 5 buttons per row)
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');

        const buttons = game.players.map((p, i) =>
            new ButtonBuilder()
                .setCustomId(`imposter_vote_${channelId}_${i}`)
                .setLabel(p.name)
                .setStyle(ButtonStyle.Secondary)
        );

        // Split into rows of 5
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) {
            rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        }

        // Show clue recap
        let clueRecap = '**Clues so far:**\n';
        game.messages.forEach((m, i) => {
            clueRecap += `${i + 1}. ${m.player}: ${m.content}\n`;
        });

        const voteMessage = `**🚨 EMERGENCY MEETING! 🚨**\n\n${clueRecap}\n**Click a button to vote!** (60 seconds)\n_Each player can call up to 3 meetings per game._`;

        const msg = await channel.send({ content: voteMessage, components: rows });

        // Track votes with a Map
        const voterChoices = new Map();

        const collector = msg.createMessageComponentCollector({ time: 60000 });

        // Resolve Bot Votes asynchronously
        this.resolveBotVotes(channelId, voterChoices, collector);

        collector.on('collect', async (interaction) => {
            // Only players can vote
            if (!game.players.some(p => p.id === interaction.user.id)) {
                return interaction.reply({ content: '❌ You are not in this game!', ephemeral: true });
            }

            // Check if already voted
            if (voterChoices.has(interaction.user.id)) {
                return interaction.reply({ content: '❌ You already voted!', ephemeral: true });
            }

            // Parse vote
            const parts = interaction.customId.split('_');
            const playerIndex = parseInt(parts[3], 10);
            const votedFor = game.players[playerIndex];

            voterChoices.set(interaction.user.id, playerIndex);

            await interaction.reply({ content: `✅ You voted for **${votedFor.name}**`, ephemeral: true });

            // Check if everyone voted
            if (voterChoices.size === game.players.length) {
                collector.stop('all_voted');
            }
        });

        collector.on('end', async () => {
            // Disable buttons
            rows.forEach(row => row.components.forEach(btn => btn.setDisabled(true)));
            await msg.edit({ components: rows }).catch(() => { });

            // Count votes
            const votes = new Array(game.players.length).fill(0);
            voterChoices.forEach((playerIndex) => {
                votes[playerIndex]++;
            });

            // Find winner
            let maxVotes = 0;
            let winnerIndex = -1;
            let tie = false;

            for (let i = 0; i < votes.length; i++) {
                if (votes[i] > maxVotes) {
                    maxVotes = votes[i];
                    winnerIndex = i;
                    tie = false;
                } else if (votes[i] === maxVotes && votes[i] > 0) {
                    tie = true;
                }
            }

            const imposterPlayer = game.players.find(p => p.id === game.imposterId);

            let resultMsg = '**🗳️ VOTING ENDED!**\n\n';
            resultMsg += `Votes: ${votes.map((v, i) => `${game.players[i].name}: ${v}`).join(', ')}\n\n`;

            if (tie || maxVotes === 0) {
                resultMsg += '🤷 It was a tie (or no votes)! No one was ejected.\n';
                game.status = 'PLAYING';
                resultMsg += '\n**Game Resuming...**';
                await channel.send(resultMsg);
            } else {
                const ejected = game.players[winnerIndex];
                const wasImposter = ejected.id === game.imposterId;
                resultMsg += `👋 **${ejected.name}** was voted out with ${maxVotes} vote(s)!\n\n`;
                resultMsg += wasImposter ? '✅ **THEY WERE THE IMPOSTER!**' : '❌ **They were NOT the imposter...**';

                resultMsg += `\n\n🕵️ **The Real Imposter:** ${imposterPlayer.name}`;
                resultMsg += `\n📖 **The Secret Word:** ${game.word}`;

                this.games.delete(channelId);
                await channel.send(resultMsg);

            }
        });
    }

    async resolveBotVotes(channelId, voterChoices, collector) {
        const game = this.games.get(channelId);
        if (!game || game.status !== 'VOTING') return;

        const bots = game.players.filter(p => p.isBot);
        if (bots.length === 0) return;

        // Wait a bit for humans to start voting
        await new Promise(r => setTimeout(r, 5000));

        for (const bot of bots) {
            if (game.status !== 'VOTING') break; // Vote might have ended

            // Small random delay for realism
            await new Promise(r => setTimeout(r, Math.random() * 5000 + 2000));

            // Generate vote
            const isImposter = bot.id === game.imposterId;
            const history = game.messages.map(m => `${m.player}: ${m.content}`);

            // Only pass necessary info to LLM
            // Filter out self so bot doesn't vote for itself
            const activePlayers = game.players
                .filter(p => p.id !== bot.id)
                .map(p => ({ id: p.id, name: p.name }));

            try {
                const votedId = await llmService.generateImposterVote(
                    game.word,
                    game.category,
                    history,
                    isImposter,
                    activePlayers,
                    true // Use fast/fallback model
                );

                if (votedId) {
                    // Find index of voted player
                    const votedIndex = game.players.findIndex(p => p.id === votedId);
                    if (votedIndex !== -1) {
                        voterChoices.set(bot.id, votedIndex);
                    }
                }
            } catch (e) { }

            // Check if everyone voted (bots + humans)
            if (voterChoices.size === game.players.length) {
                collector.stop('all_voted');
            }
        }
    }

    endGame(channelId) {
        this.games.delete(channelId);
    }
}

export default new ImposterService();
