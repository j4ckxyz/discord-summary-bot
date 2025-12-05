import { SlashCommandBuilder } from 'discord.js';
import searchService from '../services/search.js';
import llmService from '../services/llm.js';
import logger from '../utils/logger.js';

export default {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Quickly search the web')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What to search for')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();
        const query = interaction.options.getString('query');
        await this.handleSearch(interaction, query);
    },

    async executeText(message, args) {
        if (!args.length) return message.reply('Usage: !search <query>');
        const query = args.join(' ');
        const replyMsg = await message.reply('🔍 Searching...');

        try {
            const result = await this.performSearch(query);
            await replyMsg.edit(result);
        } catch (error) {
            await replyMsg.edit(error.message);
        }
    },

    // Shared logic
    async handleSearch(interaction, query) {
        try {
            const result = await this.performSearch(query);
            await interaction.editReply(result);
        } catch (error) {
            await interaction.editReply(error.message);
        }
    },

    async performSearch(query) {
        try {
            const results = await searchService.search(query);

            if (results.length === 0) {
                return 'No results found.';
            }

            const summary = await llmService.summariseSearchResults(query, results);
            return `🔍 **Result for:** "${query}"\n${summary}`;
        } catch (error) {
            logger.error('Search command failed:', error);
            if (error.message.includes('configuration missing')) {
                return '⚠️ Search is not configured (API Key missing).';
            }
            return '❌ Failed to perform search.';
        }
    }
};
