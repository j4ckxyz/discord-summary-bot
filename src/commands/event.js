import { SlashCommandBuilder } from 'discord.js';
import { EventModel, SettingsModel } from '../database/models.js';

export default {
    data: new SlashCommandBuilder()
        .setName('event')
        .setDescription('Manage channel events')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new event')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Event name')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('time')
                        .setDescription('Time (e.g. "tomorrow 8pm", "in 2h")')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Event description')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List upcoming events'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('join')
                .setDescription('Join an event')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the event')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave')
                .setDescription('Leave an event')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the event')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        if (subcommand === 'create') {
            const name = interaction.options.getString('name');
            const timeStr = interaction.options.getString('time');
            const description = interaction.options.getString('description') || '';

            // Simple relative parse or fallback
            let time = parseTime(timeStr);
            if (!time) {
                return interaction.reply({ content: `❌ Could not understand time "${timeStr}". Try "in 5m", "tomorrow", etc.`, ephemeral: true });
            }

            // Check limit
            const settings = SettingsModel.getSettings(guildId);
            const events = EventModel.getChannelEvents(guildId, channelId);
            if (events.length >= settings.max_events) {
                return interaction.reply({ content: `❌ This channel has reached the limit of ${settings.max_events} upcoming events.`, ephemeral: true });
            }

            EventModel.createEvent(guildId, channelId, userId, name, description, time);
            const dateStr = new Date(time * 1000).toLocaleString();
            return interaction.reply(`📅 Created event **${name}** for ${dateStr}. \n${description}`);
        }

        if (subcommand === 'list') {
            const events = EventModel.getChannelEvents(guildId, channelId);

            if (events.length === 0) {
                return interaction.reply('📅 No upcoming events in this channel.');
            }

            const list = events.map(e => {
                let attendees = [];
                try { attendees = JSON.parse(e.attendees); } catch (_) { }
                const dateStr = new Date(e.time * 1000).toLocaleString();
                return `**${e.id}**. **${e.name}** - ${dateStr} (${attendees.length} attending)`;
            }).join('\n');

            return interaction.reply(`**📅 Upcoming Events:**\n${list}`);
        }

        if (subcommand === 'join') {
            const id = interaction.options.getInteger('id');
            const res = EventModel.addAttendee(id, userId);
            if (res === false) return interaction.reply({ content: '❌ Event not found.', ephemeral: true });
            if (res.changes === 0) return interaction.reply({ content: '⚠️ You are already attending.', ephemeral: true });

            return interaction.reply(`✅ Joined event #${id}!`);
        }

        if (subcommand === 'leave') {
            const id = interaction.options.getInteger('id');
            const res = EventModel.removeAttendee(id, userId);
            if (res === false) return interaction.reply({ content: '❌ Event not found.', ephemeral: true });

            return interaction.reply(`👋 Left event #${id}.`);
        }
    },

    async executeText(message, args) {
        // Basic text command support could be added here similar to todo
        if (!args.length) return message.reply('Usage: !event <create|list|join|leave> [args]');
        const subcommand = args[0].toLowerCase();

        if (subcommand === 'list') {
            const events = EventModel.getChannelEvents(message.guild.id, message.channel.id);
            if (events.length === 0) return message.reply('📅 No upcoming events.');
            const list = events.map(e => {
                const dateStr = new Date(e.time * 1000).toLocaleString();
                return `**${e.id}**. **${e.name}** - ${dateStr}`;
            }).join('\n');
            return message.reply(`**📅 Upcoming Events:**\n${list}`);
        }
        // Support other commands as needed
    }
};

// Simple relative time parser helper
function parseTime(input) {
    const now = Date.now();
    const str = input.toLowerCase();

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
