import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { EventModel, SettingsModel } from '../database/models.js';
import { parseTime } from '../utils/timeParser.js';

export default {
    data: new SlashCommandBuilder()
        // ... (subcommand config remains same)
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
                        .setDescription('Time (e.g. "tomorrow 8pm", "in 2h", "Sunday 5pm")')
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
                .setName('view')
                .setDescription('View event details and manage participation')
                .addIntegerOption(option =>
                    option.setName('id')
                    .setDescription('The ID of the event')
                    .setRequired(true)))
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
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit')
                .setDescription('Edit an event')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('Event ID')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('New name'))
                .addStringOption(option =>
                    option.setName('time')
                        .setDescription('New time'))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('New description')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Cancel an event')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('Event ID')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        if (subcommand === 'create') {
            await interaction.deferReply();
            const name = interaction.options.getString('name');
            const timeStr = interaction.options.getString('time');
            const description = interaction.options.getString('description') || '';

            // Simple relative parse or fallback
            // Now using intelligent async parser
            let time = await parseTime(timeStr);
            if (!time) {
                return interaction.editReply({ content: `❌ Could not understand time "${timeStr}". Try "in 5m", "tomorrow", "Friday at 8pm" etc.` });
            }

            // Check limit
            const settings = SettingsModel.getSettings(guildId);
            const events = EventModel.getChannelEvents(guildId, channelId);
            if (events.length >= settings.max_events) {
                return interaction.editReply({ content: `❌ This channel has reached the limit of ${settings.max_events} upcoming events.` });
            }

            const result = EventModel.createEvent(guildId, channelId, userId, name, description, time);
            const eventId = result.lastInsertRowid; // Use ID from result for buttons

            // Redirect to view
            return this.renderEventView(interaction, eventId, true);
        }

        if (subcommand === 'list') {
            const events = EventModel.getChannelEvents(guildId, channelId);

            if (events.length === 0) {
                return interaction.reply('📅 No upcoming events in this channel.');
            }

            const list = events.map(e => {
                let attendees = [];
                try { attendees = JSON.parse(e.attendees); } catch (_) {}
                const dateStr = new Date(e.time * 1000).toLocaleString();
                return `**#${e.id}** - **${e.name}**\n🕒 <t:${e.time}:R> (${dateStr})\n👥 ${attendees.length} attending\n`;
            }).join('\n');

            return interaction.reply(`**📅 Upcoming Events**\nUse \`/event view [id]\` for details and to join.\n\n${list}`);
        }

        if (subcommand === 'view') {
            const id = interaction.options.getInteger('id');
            return this.renderEventView(interaction, id);
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

        if (subcommand === 'delete') {
            const id = interaction.options.getInteger('id');
            const event = EventModel.getEvent(id);

            if (!event) return interaction.reply({ content: '❌ Event not found.', ephemeral: true });

            const member = await interaction.guild.members.fetch(userId);
            const isAdmin = member.permissions.has('ManageGuild') || member.permissions.has('Administrator');

            if (event.creator_id !== userId && !isAdmin) {
                return interaction.reply({ content: '❌ You can only delete events you created.', ephemeral: true });
            }

            EventModel.deleteEvent(id);
            return interaction.reply(`🗑️ Event #${id} has been cancelled.`);
        }

        if (subcommand === 'edit') {
            const id = interaction.options.getInteger('id');
            const name = interaction.options.getString('name');
            const timeStr = interaction.options.getString('time');
            const description = interaction.options.getString('description');

            const event = EventModel.getEvent(id);
            if (!event) return interaction.reply({ content: '❌ Event not found.', ephemeral: true });

            const member = await interaction.guild.members.fetch(userId);
            const isAdmin = member.permissions.has('ManageGuild') || member.permissions.has('Administrator');

            if (event.creator_id !== userId && !isAdmin) {
                return interaction.reply({ content: '❌ You can only edit events you created.', ephemeral: true });
            }

            let newTime = event.time;
            if (timeStr) {
                const parsed = await parseTime(timeStr);
                if (!parsed) return interaction.reply({ content: `❌ Could not understand time "${timeStr}".`, ephemeral: true });
                newTime = parsed;
            }

            EventModel.updateEvent(id, name, description, newTime);
            return interaction.reply(`✅ Event #${id} updated.`);
        }
    },

    async renderEventView(interaction, eventId, isEdit = false) {
        const event = EventModel.getEvent(eventId);
        if (!event) {
            const msg = { content: '❌ Event not found.', ephemeral: true };
            return isEdit ? interaction.editReply(msg) : interaction.reply(msg);
        }

        let attendees = [];
        try { attendees = JSON.parse(event.attendees); } catch (_) {}

        const embed = new EmbedBuilder()
            .setTitle(`📅 ${event.name}`)
            .setDescription(event.description || 'No description provided.')
            .setColor(0x3498db)
            .addFields(
                { name: 'Time', value: `<t:${event.time}:F> (<t:${event.time}:R>)`, inline: true },
                { name: 'Host', value: `<@${event.creator_id}>`, inline: true },
                { name: 'Participants (' + attendees.length + ')', value: attendees.length > 0 ? attendees.map(id => `<@${id}>`).join(', ') : 'No one yet!' }
            )
            .setFooter({ text: `Event ID: ${event.id}` });

        // Buttons
        const joinBtn = new ButtonBuilder()
            .setCustomId(`event_join_${event.id}`)
            .setLabel('Join')
            .setStyle(ButtonStyle.Success);
        
        const leaveBtn = new ButtonBuilder()
            .setCustomId(`event_leave_${event.id}`)
            .setLabel('Leave')
            .setStyle(ButtonStyle.Secondary);

        const deleteBtn = new ButtonBuilder()
            .setCustomId(`event_delete_${event.id}`)
            .setLabel('Cancel Event')
            .setStyle(ButtonStyle.Danger);

        const row1 = new ActionRowBuilder().addComponents(joinBtn, leaveBtn, deleteBtn);

        // Reminder Select Menu
        const select = new StringSelectMenuBuilder()
            .setCustomId(`event_remind_select_${event.id}`)
            .setPlaceholder('⏰ Set a reminder...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('15 minutes before').setValue('15m'),
                new StringSelectMenuOptionBuilder().setLabel('1 hour before').setValue('1h'),
                new StringSelectMenuOptionBuilder().setLabel('1 day before').setValue('1d'),
                new StringSelectMenuOptionBuilder().setLabel('At event time').setValue('0m'),
            );

        const row2 = new ActionRowBuilder().addComponents(select);

        const payload = { content: '', embeds: [embed], components: [row1, row2] };
        return isEdit ? interaction.editReply(payload) : interaction.reply(payload);
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
                return `**#${e.id}** - **${e.name}** - ${dateStr}`;
            }).join('\n');
            return message.reply(`**📅 Upcoming Events:**\n${list}\nUse \`/event view [id]\` for more.`);
        }
        // Support other commands as needed
    }
};
