import { SlashCommandBuilder } from 'discord.js';
import messageCache from '../services/messageCache.js';
import llmService from '../services/llm.js';

export default {
    data: new SlashCommandBuilder()
        .setName('frees')
        .setDescription('Analyze channel to see when everyone is free')
        .addStringOption(option =>
            option.setName('time_range')
                .setDescription('How far back to look? (e.g. 24h, 3d) - default 24h')),

    async execute(interaction) {
        await interaction.deferReply();
        const range = interaction.options.getString('time_range') || '24h';
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        // Parse range to timestamp
        let hours = 24;
        if (range.endsWith('h')) hours = parseInt(range);
        if (range.endsWith('d')) hours = parseInt(range) * 24;

        const sinceTimestamp = Math.floor(Date.now() / 1000) - (hours * 3600);

        // Fetch recent messages
        const messages = messageCache.getMessagesSince(channelId, sinceTimestamp, interaction.client.user.id, 200);

        if (messages.length === 0) {
            return interaction.editReply('No messages found in that range to analyze.');
        }

        try {
            const analysis = await llmService.analyzeAvailability(messages);
            return interaction.editReply(`🗓️ **Availability Report** (Last ${range})\n\n${analysis}`);
        } catch (e) {
            console.error(e);
            return interaction.editReply('❌ Failed to analyze availability.');
        }
    }
};
