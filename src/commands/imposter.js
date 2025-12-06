import { SlashCommandBuilder } from 'discord.js';
import imposterService from '../services/imposter.js';
import logger from '../utils/logger.js';

export default {
    data: new SlashCommandBuilder()
        .setName('imposter')
        .setDescription('Play the Imposter (Word Chameleon) party game')
        .addSubcommand(sub =>
            sub.setName('create').setDescription('Create a new game lobby'))
        .addSubcommand(sub =>
            sub.setName('join').setDescription('Join the lobby'))
        .addSubcommand(sub =>
            sub.setName('start').setDescription('Start the game (Host only)'))
        .addSubcommand(sub =>
            sub.setName('addbot').setDescription('Add an AI bot player'))
        .addSubcommand(sub =>
            sub.setName('stop').setDescription('Stop the game')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const channelId = interaction.channelId;
        const userId = interaction.user.id;
        const userName = interaction.user.displayName; // or username

        try {
            if (sub === 'create') {
                imposterService.createGame(channelId, userId, userName);
                return interaction.reply(`🕵️ **Imposter Game Lobby Created!**\nHost: ${userName}\n\nType \`/imposter join\` to join!`);
            }

            if (sub === 'join') {
                const game = imposterService.joinGame(channelId, userId, userName);
                const names = game.players.map(p => p.name).join(', ');
                return interaction.reply(`✅ **Joined!**\nPlayers (${game.players.length}): ${names}`);
            }

            if (sub === 'start') {
                await interaction.deferReply();
                const game = await imposterService.startGame(channelId, userId);

                // DM everyone
                const dmPromises = game.players.map(async (p) => {
                    const user = await interaction.client.users.fetch(p.id);
                    if (p.id === game.imposterId) {
                        return user.send(`🕵️ **YOU ARE THE IMPOSTER** 🕵️\n\nThe Category is: **${game.category}**.\nTry to blend in!`);
                    } else {
                        return user.send(`👤 **You are a Civilian**.\n\nThe Word is: **${game.word}**\nCategory: ${game.category}.`);
                    }
                });

                await Promise.all(dmPromises);

                const firstPlayer = game.players[game.turnIndex];
                await interaction.editReply(`🎲 **Game Started!** Check your DMs!\n\nThe Category is: **${game.category}**\n\n👉 **It is ${firstPlayer.name}'s turn!** Type a single word clue in this channel.`);

                // If first player is bot, trigger loop event
                if (firstPlayer.isBot) {
                    interaction.client.emit('gameStart', interaction.channel);
                }
                return;
            }

            if (sub === 'addbot') {
                try {
                    const game = imposterService.addBot(channelId);
                    const names = game.players.map(p => p.name).join(', ');
                    return interaction.reply(`🤖 **Bot Added!**\nPlayers: ${names}`);
                } catch (e) {
                    return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
                }
            }

            if (sub === 'stop') {
                imposterService.endGame(channelId);
                return interaction.reply('🛑 Game stopped.');
            }

        } catch (error) {
            return interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        }
    }
};
