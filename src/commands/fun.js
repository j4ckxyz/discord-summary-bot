import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('fun')
        .setDescription('Fun commands')
        .addSubcommand(subcommand =>
            subcommand
                .setName('roll')
                .setDescription('Roll a dice')
                .addIntegerOption(option =>
                    option.setName('sides')
                        .setDescription('Number of sides (default 6)')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('flip')
                .setDescription('Flip a coin')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'roll') {
            const sides = interaction.options.getInteger('sides') || 6;
            const result = Math.floor(Math.random() * sides) + 1;
            return interaction.reply(`🎲 You rolled a **${result}** (d${sides})!`);
        }

        if (subcommand === 'flip') {
            const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            return interaction.reply(`🪙 **${result}**!`);
        }
    },

    // Quick text aliases if desired
    async executeText(message, args) {
        const command = message.content.slice(1).split(' ')[0].toLowerCase(); // !roll or !flip

        if (command === 'roll') {
            const sides = parseInt(args[0]) || 6;
            const result = Math.floor(Math.random() * sides) + 1;
            return message.reply(`🎲 You rolled a **${result}** (d${sides})!`);
        }

        if (command === 'flip') {
            const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            return message.reply(`🪙 **${result}**!`);
        }
    }
};
