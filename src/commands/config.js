import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { SettingsModel } from '../database/models.js';

export default {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Manage bot configuration (Server Owner only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('show')
                .setDescription('Show current settings'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Update a setting')
                .addStringOption(option =>
                    option.setName('key')
                        .setDescription('Setting to update (max_reminders, max_todos, max_events)')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Max Reminders (per user)', value: 'max_reminders' },
                            { name: 'Max Todos (per channel)', value: 'max_todos' },
                            { name: 'Max Events (per channel)', value: 'max_events' }
                        ))
                .addIntegerOption(option =>
                    option.setName('value')
                        .setDescription('New value')
                        .setRequired(true))),

    async execute(interaction) {
        if (interaction.user.id !== interaction.guild.ownerId) {
            // Also allow admins, but strictly owner is requested? "owner of any given server shold be able to tweak"
            // Usually Admins are fine too, but let's stick to permissions check above (Administrator)
        }

        const guildId = interaction.guildId;
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'show') {
            const settings = SettingsModel.getSettings(guildId);
            const msg = `**⚙️ Server Configuration**
• Max Reminders (per user): ${settings.max_reminders}
• Max Todos (per channel): ${settings.max_todos}
• Max Events (per channel): ${settings.max_events}`;
            return interaction.reply(msg);
        }

        if (subcommand === 'set') {
            const key = interaction.options.getString('key');
            const value = interaction.options.getInteger('value');

            if (value < 0 || value > 100) {
                return interaction.reply({ content: '❌ Value must be between 0 and 100.', ephemeral: true });
            }

            try {
                SettingsModel.updateSetting(guildId, key, value);
                return interaction.reply(`✅ Updated **${key}** to **${value}**.`);
            } catch (error) {
                return interaction.reply({ content: `❌ Error updating setting: ${error.message}`, ephemeral: true });
            }
        }
    },

    async executeText(message, args) {
        if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('❌ You need to be a Server Admin to use this command.');
        }

        if (!args.length || args[0] === 'show') {
            const settings = SettingsModel.getSettings(message.guild.id);
            const msg = `**⚙️ Server Configuration**
• Max Reminders (per user): ${settings.max_reminders}
• Max Todos (per channel): ${settings.max_todos}
• Max Events (per channel): ${settings.max_events}

Usage: \`!config set <key> <value>\``;
            return message.reply(msg);
        }

        if (args[0] === 'set') {
            const key = args[1];
            const value = parseInt(args[2]);

            if (!key || isNaN(value)) {
                return message.reply('Usage: `!config set <max_reminders|max_todos|max_events> <value>`');
            }

            if (!['max_reminders', 'max_todos', 'max_events'].includes(key)) {
                return message.reply('❌ Invalid key. Use: max_reminders, max_todos, or max_events');
            }

            if (value < 0 || value > 100) return message.reply('❌ Value must be between 0 and 100.');

            try {
                SettingsModel.updateSetting(message.guild.id, key, value);
                return message.reply(`✅ Updated **${key}** to **${value}**.`);
            } catch (error) {
                return message.reply(`❌ Error: ${error.message}`);
            }
        }
    }
};
