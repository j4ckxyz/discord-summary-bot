import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

class LLMService {
  constructor() {
    this.apiKey = process.env.LLM_API_KEY;
    this.provider = process.env.LLM_PROVIDER || 'google';
    this.model = process.env.LLM_MODEL || 'gemini-2.0-flash-exp';
    
    if (!this.apiKey) {
      throw new Error('LLM_API_KEY environment variable is required');
    }

    // Initialize Google Gemini client if using Google
    if (this.provider === 'google') {
      this.geminiClient = new GoogleGenerativeAI(this.apiKey);
    }
  }

  /**
   * Generate a completion using Google Gemini
   * @param {string} systemPrompt - The system prompt
   * @param {string} userPrompt - The user prompt
   * @returns {Promise<string>} - The generated text
   */
  async generateGeminiCompletion(systemPrompt, userPrompt) {
    try {
      const model = this.geminiClient.getGenerativeModel({ 
        model: this.model,
        systemInstruction: systemPrompt
      });

      const result = await model.generateContent(userPrompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      logger.error('Gemini API error:', error.message);
      throw new Error('Failed to generate summary from Gemini');
    }
  }

  /**
   * Generate a completion using OpenAI-compatible API
   * @param {string} systemPrompt - The system prompt
   * @param {string} userPrompt - The user prompt
   * @returns {Promise<string>} - The generated text
   */
  async generateOpenAICompletion(systemPrompt, userPrompt) {
    try {
      let baseUrl;
      if (this.provider === 'openrouter') {
        baseUrl = 'https://openrouter.ai/api/v1';
      } else if (this.provider === 'openai') {
        baseUrl = 'https://api.openai.com/v1';
      } else {
        baseUrl = process.env.LLM_API_BASE_URL || 'https://openrouter.ai/api/v1';
      }

      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 500,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/discord-summary-bot',
            'X-Title': 'Discord Summary Bot'
          }
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      logger.error('LLM API error:', error.response?.data || error.message);
      throw new Error('Failed to generate summary from LLM');
    }
  }

  /**
   * Generate a completion using the configured LLM
   * @param {string} systemPrompt - The system prompt
   * @param {string} userPrompt - The user prompt
   * @returns {Promise<string>} - The generated text
   */
  async generateCompletion(systemPrompt, userPrompt) {
    if (this.provider === 'google') {
      return this.generateGeminiCompletion(systemPrompt, userPrompt);
    } else {
      return this.generateOpenAICompletion(systemPrompt, userPrompt);
    }
  }

  /**
   * Generate a summary from Discord messages
   * @param {Array} messages - Array of message objects {author, content, timestamp}
   * @returns {Promise<string>} - The summary text
   */
  async summariseMessages(messages) {
    const systemPrompt = config.summaryPrompt;
    
    // Format messages for the LLM
    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    const userPrompt = `Messages to summarise:\n\n${formattedMessages}\n\nProvide a summary in exactly ${config.maxSummaryLength} characters or less.`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    
    // Ensure summary doesn't exceed max length
    if (summary.length > config.maxSummaryLength) {
      return summary.substring(0, config.maxSummaryLength - 3) + '...';
    }
    
    return summary;
  }
}

export default new LLMService();
