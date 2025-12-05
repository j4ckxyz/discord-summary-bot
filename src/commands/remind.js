import { SlashCommandBuilder } from 'discord.js';
import { ReminderModel, SettingsModel } from '../database/models.js';

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
                        .setDescription('When to remind you (e.g. "in 5m", "tomorrow")')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('What to remind you about')
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

        if (subcommand === 'me') {
            const timeStr = interaction.options.getString('time');
            const message = interaction.options.getString('message');

            const time = parseTime(timeStr);
            if (!time) {
                return interaction.reply({ content: `❌ Could not understand time "${timeStr}". Try "in 5m", "tomorrow", etc.`, ephemeral: true });
            }

            // check limit
            const settings = SettingsModel.getSettings(guildId);
            const userReminders = ReminderModel.getUserReminders(userId, guildId);
            if (userReminders.length >= settings.max_reminders) {
                return interaction.reply({ content: `❌ You have reached the limit of ${settings.max_reminders} active reminders in this server.`, ephemeral: true });
            }

            ReminderModel.createReminder(userId, guildId, channelId, message, time);
            return interaction.reply(`⏰ I'll remind you to **${message}** <t:${time}:R>!`);
        }

        if (subcommand === 'list') {
            const reminders = ReminderModel.getUserReminders(userId, guildId);

            if (reminders.length === 0) {
                return interaction.reply({ content: '🔕 You have no active reminders.', ephemeral: true });
            }

            const list = reminders.map(r => {
                return `**${r.id}**. ${r.message} (<t:${r.time}:R>)`;
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
        const time = parseTime(timeStr);

        if (time) {
            const reminderMsg = args.slice(1).join(' ');
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
            // Maybe complex parsing "in 5 minutes" where "in" is args[0]
            // Simple fallback: try to join first 2 args
            const timeStr2 = args.slice(0, 2).join(' ');
            const time2 = parseTime(timeStr2);
            if (time2) {
                const reminderMsg = args.slice(2).join(' ');
                if (!reminderMsg) return message.reply('Please provide a message for the reminder.');
                ReminderModel.createReminder(message.author.id, message.guild.id, message.channel.id, reminderMsg, time2);
                return message.reply(`⏰ I'll remind you to **${reminderMsg}** <t:${time2}:R>!`);
            }

            return message.reply(`❌ Could not understand time. Try "10m", "in 1h", "tomorrow".`);
        }
    }
};

// Reused simple time parser (could be shared utility)
function parseTime(input) {
    const now = Date.now();
    const str = input.toLowerCase();

    // "10m", "1h"
    const simpleRegex = /^(\d+)(m|h|d|s)$/;
    const simpleMatch = str.match(simpleRegex);
    if (simpleMatch) {
        const amount = parseInt(simpleMatch[1]);
        const unit = simpleMatch[2];
        let ms = 0;
        if (unit === 's') ms = amount * 1000;
        else if (unit === 'm') ms = amount * 60 * 1000;
        else if (unit === 'h') ms = amount * 60 * 60 * 1000;
        else if (unit === 'd') ms = amount * 24 * 60 * 60 * 1000;
        return Math.floor((now + ms) / 1000);
    }

    // "in X m/h/d"
    const regex = /in\s+(\d+)\s*(m|h|d|min|mins|hour|hours|day|days)/;
    const match = str.match(regex);
    if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        let ms = 0;
        if (unit.startsWith('m')) ms = amount * 60 * 1000;
        else if (unit.startsWith('h')) ms = amount * 60 * 60 * 1000;
        else if (unit.startsWith('d')) ms = amount * 24 * 60 * 60 * 1000;

        return Math.floor((now + ms) / 1000);
    }

    // "tomorrow"
    if (str.includes('tomorrow')) {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0); // Default 9am
        return Math.floor(d.getTime() / 1000);
    }

    return null;
}
