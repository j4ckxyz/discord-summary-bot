import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a simple poll')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('The question to ask')
                .setRequired(true))
        .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true))
        .addStringOption(option => option.setName('option2').setDescription('Second option').setRequired(true))
        .addStringOption(option => option.setName('option3').setDescription('Third option'))
        .addStringOption(option => option.setName('option4').setDescription('Fourth option'))
        .addStringOption(option => option.setName('option5').setDescription('Fifth option')),

    async execute(interaction) {
        const question = interaction.options.getString('question');
        const options = [
            interaction.options.getString('option1'),
            interaction.options.getString('option2'),
            interaction.options.getString('option3'),
            interaction.options.getString('option4'),
            interaction.options.getString('option5')
        ].filter(Boolean);

        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

        let content = `📊 **${question}**\n\n`;
        options.forEach((opt, index) => {
            content += `${emojis[index]} ${opt}\n`;
        });

        const msg = await interaction.reply({ content, fetchReply: true });

        for (let i = 0; i < options.length; i++) {
            await msg.react(emojis[i]);
        }
    },

    async executeText(message, args) {
        // !poll "Question" "Option 1" "Option 2"
        // Simple parsing: if quotes used, complex logic needed.
        // Let's assume simpler syntax for text: !poll Question | Opt1 | Opt2

        const fullText = args.join(' ');
        const parts = fullText.split('|').map(p => p.trim()).filter(Boolean);

        if (parts.length < 3) {
            return message.reply('Usage: `!poll Question | Option 1 | Option 2`');
        }

        const question = parts[0];
        const options = parts.slice(1).slice(0, 9); // Max 9

        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

        let content = `📊 **${question}**\n\n`;
        options.forEach((opt, index) => {
            content += `${emojis[index]} ${opt}\n`;
        });

        const msg = await message.reply(content);

        for (let i = 0; i < options.length; i++) {
            await msg.react(emojis[i]);
        }
    }
};
