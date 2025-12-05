import { SlashCommandBuilder } from 'discord.js';
import { TodoModel, SettingsModel } from '../database/models.js';

export default {
    data: new SlashCommandBuilder()
        .setName('todo')
        .setDescription('Manage channel todo list')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a new todo item')
                .addStringOption(option =>
                    option.setName('content')
                        .setDescription('The todo item content')
                        .setRequired(true))
                .addUserOption(option =>
                    option.setName('assignee')
                        .setDescription('User to assign this todo to')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all pending todos'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('done')
                .setDescription('Mark a todo as done')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the todo item')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a todo item')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the todo item')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        if (subcommand === 'add') {
            const content = interaction.options.getString('content');
            const assignee = interaction.options.getUser('assignee');
            const assigneeId = assignee ? assignee.id : null;

            // check limit
            const settings = SettingsModel.getSettings(guildId);
            const todos = TodoModel.getChannelTodos(guildId, channelId);
            if (todos.length >= settings.max_todos) {
                return interaction.reply({ content: `❌ This channel has reached the limit of ${settings.max_todos} active todos.`, ephemeral: true });
            }

            TodoModel.createTodo(guildId, channelId, userId, content, assigneeId);

            let response = `✅ Added todo: "${content}"`;
            if (assignee) {
                response += ` (Assigned to ${assignee})`;
            }
            return interaction.reply(response);
        }

        if (subcommand === 'list') {
            const todos = TodoModel.getChannelTodos(guildId, channelId);

            if (todos.length === 0) {
                return interaction.reply('📝 No pending todos for this channel.');
            }

            const list = todos.map(t => {
                const assigned = t.assignee_id ? ` -> <@${t.assignee_id}>` : '';
                return `**${t.id}**. ${t.content}${assigned}`;
            }).join('\n');

            return interaction.reply({
                content: `**📝 Todo List:**\n${list}`,
                allowedMentions: { users: [] } // Don't ping on list
            });
        }

        if (subcommand === 'done') {
            const id = interaction.options.getInteger('id');
            // Verify todo exists and belongs to this channel
            const todos = TodoModel.getChannelTodos(guildId, channelId);
            const todo = todos.find(t => t.id === id);

            if (!todo) {
                return interaction.reply({ content: `❌ Todo #${id} not found in this channel.`, ephemeral: true });
            }

            TodoModel.updateTodoStatus(id, 'done');
            return interaction.reply(`✅ Marked todo #${id} as done!`);
        }

        if (subcommand === 'remove') {
            const id = interaction.options.getInteger('id');
            const todos = TodoModel.getChannelTodos(guildId, channelId);
            const todo = todos.find(t => t.id === id);

            if (!todo) {
                return interaction.reply({ content: `❌ Todo #${id} not found in this channel.`, ephemeral: true });
            }

            TodoModel.deleteTodo(id);
            return interaction.reply(`🗑️ Deleted todo #${id}.`);
        }
    },

    // Helper for text command handling if needed in future
    async executeText(message, args) {
        if (!args.length) return message.reply('Usage: !todo <add|list|done|remove> [args]');

        const subcommand = args[0].toLowerCase();
        const contentRaw = args.slice(1).join(' ');

        if (subcommand === 'add') {
            if (!contentRaw) return message.reply('Please provide content for the todo.');
            const todoContent = contentRaw; // Simplification: no mention parsing for assignment in text cmd yet
            TodoModel.createTodo(message.guild.id, message.channel.id, message.author.id, todoContent, null);
            return message.reply(`✅ Added todo: "${todoContent}"`);
        }

        if (subcommand === 'list') {
            const todos = TodoModel.getChannelTodos(message.guild.id, message.channel.id);
            if (todos.length === 0) return message.reply('📝 No pending todos.');

            const list = todos.map(t => {
                const assigned = t.assignee_id ? ` -> <@${t.assignee_id}>` : '';
                return `**${t.id}**. ${t.content}${assigned}`;
            }).join('\n');
            return message.reply({ content: `**📝 Todo List:**\n${list}`, allowedMentions: { users: [] } });
        }

        if (subcommand === 'done' || subcommand === 'check') {
            const id = parseInt(args[1]);
            if (isNaN(id)) return message.reply('Please provide a valid ID.');

            const todos = TodoModel.getChannelTodos(message.guild.id, message.channel.id);
            if (!todos.find(t => t.id === id)) return message.reply('❌ Todo not found.');

            TodoModel.updateTodoStatus(id, 'done');
            return message.reply(`✅ Marked todo #${id} as done!`);
        }

        if (subcommand === 'remove') {
            const id = parseInt(args[1]);
            if (isNaN(id)) return message.reply('Please provide a valid ID.');

            TodoModel.deleteTodo(id);
            return message.reply(`🗑️ Deleted todo #${id}.`);
        }
    }
};
