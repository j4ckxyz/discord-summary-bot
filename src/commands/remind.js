import { SlashCommandBuilder } from 'discord.js';
import { ReminderModel, SettingsModel } from '../database/models.js';
import { parseTime } from '../utils/timeParser.js';

export default {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set a reminder')
        .addSubcommand(subcommand =>
            subcommand
                .setName('me')
                .setDescription('Remind me about something')
                .addStringOption(option =>
                    option.setName('time')
                        .setDescription('When to remind you (e.g. "in 5m", "tomorrow", "Sunday at 5pm")')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('What to remind you about')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Set a reminder for the whole channel')
                .addStringOption(option =>
                    option.setName('time')
                        .setDescription('When to remind the channel')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('What to remind about')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List your active reminders'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a reminder')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('Reminder ID')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        if (subcommand === 'me' || subcommand === 'channel') {
            await interaction.deferReply();
            const timeStr = interaction.options.getString('time');
            const message = interaction.options.getString('message');
            const isPublic = subcommand === 'channel';

            const time = await parseTime(timeStr);
            if (!time) {
                return interaction.editReply({ content: `❌ Could not understand time "${timeStr}". Try "in 5m", "tomorrow", or "Sunday at 5pm".` });
            }

            // check limit
            const settings = SettingsModel.getSettings(guildId);
            const userReminders = ReminderModel.getUserReminders(userId, guildId);
            if (userReminders.length >= settings.max_reminders) {
                // For public reminders, maybe we should have a shared limit? 
                // For now, count towards user's limit to prevent spam.
                return interaction.editReply({ content: `❌ You have reached the limit of ${settings.max_reminders} active reminders in this server.` });
            }

            ReminderModel.createReminder(userId, guildId, channelId, message, time, isPublic);
            const prefix = isPublic ? '📢 Group Reminder set! I will remind here' : "⏰ I'll remind you";
            return interaction.editReply(`${prefix} to **${message}** <t:${time}:R>!`);
        }

        if (subcommand === 'list') {
            const reminders = ReminderModel.getUserReminders(userId, guildId);

            if (reminders.length === 0) {
                return interaction.reply({ content: '🔕 You have no active reminders.', ephemeral: true });
            }

            const list = reminders.map(r => {
                const type = r.is_public ? '📢 (Public)' : '🔒';
                return `**${r.id}**. ${type} ${r.message} (<t:${r.time}:R>)`;
            }).join('\n');

            return interaction.reply({ content: `**⏰ Your Reminders:**\n${list}`, ephemeral: true });
        }

        if (subcommand === 'delete') {
            const id = interaction.options.getInteger('id');
            const res = ReminderModel.deleteReminder(id, userId);

            if (res.changes === 0) {
                return interaction.reply({ content: `❌ Reminder #${id} not found or doesn't belong to you.`, ephemeral: true });
            }

            return interaction.reply({ content: `🗑️ Deleted reminder #${id}.`, ephemeral: true });
        }
    },

    async executeText(message, args) {
        if (!args.length) return message.reply('Usage: !remindme <time> <message> OR !remind list');

        const subcommand = args[0].toLowerCase();

        if (subcommand === 'list') {
            const reminders = ReminderModel.getUserReminders(message.author.id, message.guild.id);
            if (reminders.length === 0) return message.reply('🔕 You have no active reminders.');
            const list = reminders.map(r => `**${r.id}**. ${r.message} (<t:${r.time}:R>)`).join('\n');
            return message.reply(`**⏰ Your Reminders:**\n${list}`);
        }

        // Default to "remind me" logic: !remindme 10m Check oven
        // We assume the first arg is time if it looks like it
        const timeStr = args[0];
        let time = await parseTime(timeStr);
        let reminderMsg;

        if (time) {
            reminderMsg = args.slice(1).join(' ');
        } else {
            // Try first 2 words: "in 20m" or "next friday"
            const timeStr2 = args.slice(0, 2).join(' ');
            const time2 = await parseTime(timeStr2);
            if (time2) {
                time = time2;
                reminderMsg = args.slice(2).join(' ');
            } else {
                // Try first 3 words: "next friday at 5pm"
                const timeStr3 = args.slice(0, 3).join(' ');
                const time3 = await parseTime(timeStr3);
                if (time3) {
                    time = time3;
                    reminderMsg = args.slice(3).join(' ');
                }
            }
        }

        if (time) {
            if (!reminderMsg) return message.reply('Please provide a message for the reminder.');

            // check limit
            const settings = SettingsModel.getSettings(message.guild.id);
            const userReminders = ReminderModel.getUserReminders(message.author.id, message.guild.id);
            if (userReminders.length >= settings.max_reminders) {
                return message.reply(`❌ You have reached the limit of ${settings.max_reminders} active reminders.`);
            }

            ReminderModel.createReminder(message.author.id, message.guild.id, message.channel.id, reminderMsg, time);
            return message.reply(`⏰ I'll remind you to **${reminderMsg}** <t:${time}:R>!`);
        } else {
            return message.reply(`❌ Could not understand time. Try "10m", "in 1h", "tomorrow", or "Sunday at 5pm".`);
        }
    }
};
