import { SlashCommandBuilder } from 'discord.js';
import { ReminderModel } from '../database/models.js';
import { parseTime } from '../utils/timeParser.js';

export default {
    data: new SlashCommandBuilder()
        .setName('timer')
        .setDescription('Set a quick timer')
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Duration (e.g. 10m, 1h, 30s)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Optional message')),

    async execute(interaction) {
        await interaction.deferReply();
        const durationStr = interaction.options.getString('duration');
        const message = interaction.options.getString('message') || 'Timer up!';
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        // Force "in" prefix if missing to help parser for pure durations
        // Actually timeParser handles "10m" directly.
        const time = await parseTime(durationStr);

        if (!time) {
            return interaction.editReply({ content: `❌ Invalid duration. Try "10m", "1h", "30s".` });
        }

        const now = Math.floor(Date.now() / 1000);
        if (time <= now) {
            return interaction.editReply({ content: `❌ Timer duration must be in the future.` });
        }

        // Timer is just a reminder really, but we can default it to private unless requested? 
        // User asked for group features, maybe timer should be public by default since it replaces a bot command?
        // Let's make it personal but posted in channel (so same as reminder).

        ReminderModel.createReminder(userId, guildId, channelId, message, time, 0); // 0 = private for now, or maybe make it public?
        // Let's keep it personal notification for now to avoid spam, but reply confirms it.

        return interaction.editReply(`⏲️ Timer set for **${durationStr}**! (<t:${time}:R>)`);
    },

    async executeText(message, args) {
        if (!args.length) return message.reply('Usage: !timer <duration> [message]');

        const durationStr = args[0];
        const timerMsg = args.slice(1).join(' ') || 'Timer up!';

        const time = await parseTime(durationStr);
        if (!time) return message.reply('❌ Invalid duration. Try "10m", "1h".');

        const now = Math.floor(Date.now() / 1000);
        if (time <= now) return message.reply('❌ Duration must be valid.');

        ReminderModel.createReminder(message.author.id, message.guild.id, message.channel.id, timerMsg, time, 0);
        return message.reply(`⏲️ Timer set for **${durationStr}**! (<t:${time}:R>)`);
    }
};
