import axios from 'axios';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
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
      // Configure safety settings to be permissive for chat summarization
      // Discord chats may contain mature language that shouldn't block summarization
      const safetySettings = [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
      ];

      const model = this.geminiClient.getGenerativeModel({ 
        model: this.model,
        systemInstruction: systemPrompt,
        safetySettings
      });

      const result = await model.generateContent(userPrompt);
      const response = await result.response;
      
      // Check if the response was blocked
      if (!response.text) {
        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
          logger.warn(`Gemini blocked response: ${blockReason}`);
          throw new Error(`Content blocked: ${blockReason}`);
        }
        throw new Error('Empty response from Gemini');
      }
      
      return response.text();
    } catch (error) {
      logger.error('Gemini API error:', error.message);
      throw new Error(`Failed to generate summary from Gemini: ${error.message}`);
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
          max_tokens: 1000,
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
   * @param {Array} messages - Array of message objects {author, authorId, content, timestamp, referencedMessageId, referencedAuthor}
   * @param {string} mode - 'default', 'count', or 'user'
   * @param {string} targetUsername - Username to focus on (for user mode)
   * @returns {Promise<string>} - The summary text
   */
  async summariseMessages(messages, mode = 'default', targetUsername = null) {
    // Build username -> userId map for mentions
    const userMap = this.buildUserMap(messages);
    
    // Use topic-based format for large message counts (>100 messages)
    const useTopicFormat = mode === 'count' && messages.length > 100;
    
    const systemPrompt = useTopicFormat 
      ? this.getTopicBasedSystemPrompt()
      : config.summaryPrompt;
    
    // Format messages for the LLM with reply chain information
    const formattedMessages = messages
      .map(msg => {
        let msgStr = `[${msg.timestamp}] ${msg.author}: ${msg.content}`;
        if (msg.referencedAuthor) {
          msgStr += ` (replying to ${msg.referencedAuthor})`;
        }
        return msgStr;
      })
      .join('\n');

    let userPrompt;
    
    if (mode === 'user' && targetUsername) {
      // User-specific summary: focus only on what the target user said
      userPrompt = `Messages from ${targetUsername}:\n\n${formattedMessages}\n\nProvide a neutral summary of what ${targetUsername} discussed in their 50 most recent messages. Focus ONLY on ${targetUsername}'s contributions. Only mention other users if they are directly relevant to what ${targetUsername} said (e.g., if ${targetUsername} replied to them or discussed them). The summary must be ${config.maxSummaryLength} characters or less and must not end abruptly or be cut off.`;
    } else if (useTopicFormat) {
      // Topic-based format for large message sets
      userPrompt = `Messages to summarise:\n\n${formattedMessages}\n\nAnalyze the conversation and identify the main topics discussed. Format your response as:

**Topic Name (2-4 words)**
• Brief summary of what happened (1 sentence, mention key participants)
• Another key point if needed (1 sentence)

IMPORTANT RULES:
- Keep each topic section SHORT (2-3 bullet points max)
- Each bullet point should be ONE sentence only
- Focus on WHAT was discussed and WHO participated
- Be concise and to the point
- Create multiple mini-topics rather than long detailed ones
- Total output should stay under 2000 characters if possible

Example format:
**Server Setup**
• Alice and Bob discussed migrating to Docker
• Charlie suggested using compose files

**Bug Reports**
• Dave found a rate limit issue
• Alice fixed it in commit abc123`;
    } else {
      // Default summary: include everyone
      userPrompt = `Messages to summarise:\n\n${formattedMessages}\n\nProvide a neutral summary. Include who said what and note any conversation threads where users are replying to each other. The summary must be ${config.maxSummaryLength} characters or less and must not end abruptly or be cut off.`;
    }

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    
    logger.debug(`LLM returned summary of ${summary.length} characters`);
    
    // For topic format, don't enforce character limit, just replace usernames with mentions
    if (useTopicFormat) {
      return this.replaceUsernamesWithMentions(summary.trim(), userMap);
    }
    
    // Ensure summary doesn't exceed max length and doesn't end with trailing dots
    let trimmedSummary = summary.trim();
    
    if (trimmedSummary.length > config.maxSummaryLength) {
      // Find the last complete sentence within the limit
      const withinLimit = trimmedSummary.substring(0, config.maxSummaryLength);
      const lastPeriod = withinLimit.lastIndexOf('.');
      const lastExclamation = withinLimit.lastIndexOf('!');
      const lastQuestion = withinLimit.lastIndexOf('?');
      
      const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
      
      if (lastSentenceEnd > config.maxSummaryLength * 0.7) {
        // If we can find a sentence ending in the last 30% of the limit, use it
        trimmedSummary = withinLimit.substring(0, lastSentenceEnd + 1);
      } else {
        // Otherwise, just truncate at a word boundary
        const lastSpace = withinLimit.lastIndexOf(' ');
        if (lastSpace > 0) {
          trimmedSummary = withinLimit.substring(0, lastSpace) + '.';
        } else {
          trimmedSummary = withinLimit + '.';
        }
      }
    }
    
    // Replace usernames with Discord mentions
    return this.replaceUsernamesWithMentions(trimmedSummary, userMap);
  }

  /**
   * Build a map of usernames to user IDs from messages
   * @param {Array} messages - Array of message objects
   * @returns {Map<string, string>} - Map of username -> userId
   */
  buildUserMap(messages) {
    const userMap = new Map();
    for (const msg of messages) {
      if (msg.author && msg.authorId) {
        userMap.set(msg.author.toLowerCase(), msg.authorId);
      }
    }
    return userMap;
  }

  /**
   * Replace usernames in text with Discord mentions
   * @param {string} text - The text containing usernames
   * @param {Map<string, string>} userMap - Map of username -> userId
   * @returns {string} - Text with usernames replaced by mentions
   */
  replaceUsernamesWithMentions(text, userMap) {
    let result = text;
    
    // Sort by username length (longest first) to avoid partial replacements
    const sortedUsers = [...userMap.entries()].sort((a, b) => b[0].length - a[0].length);
    
    for (const [username, userId] of sortedUsers) {
      // Match username as a whole word (case-insensitive)
      // Avoid replacing if already in a mention format or URL
      const regex = new RegExp(`(?<!<@|<@!|/)\\b${this.escapeRegex(username)}\\b(?!'s\\b)`, 'gi');
      result = result.replace(regex, `<@${userId}>`);
    }
    
    // Also handle possessives like "username's" -> "<@id>'s"
    for (const [username, userId] of sortedUsers) {
      const possessiveRegex = new RegExp(`(?<!<@|<@!|/)\\b${this.escapeRegex(username)}'s\\b`, 'gi');
      result = result.replace(possessiveRegex, `<@${userId}>'s`);
    }
    
    return result;
  }

  /**
   * Escape special regex characters in a string
   * @param {string} string - The string to escape
   * @returns {string} - Escaped string
   */
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get system prompt for topic-based summaries
   * @returns {string} - The system prompt
   */
  getTopicBasedSystemPrompt() {
    return 'You are a Discord chat summariser. Organize conversations by topic using SHORT bullet points. Each topic should have 2-3 bullet points MAX, with each point being ONE sentence. Be concise, neutral, and objective. Always mention who said what.';
  }

  /**
   * Summarize a chunk of messages for hierarchical summarization
   * @param {Array} messages - Array of message objects for this chunk
   * @param {number} chunkIndex - Which chunk this is (1-based)
   * @param {number} totalChunks - Total number of chunks
   * @param {string} startTime - Start time of the chunk
   * @param {string} endTime - End time of the chunk
   * @returns {Promise<string>} - Chunk summary
   */
  async summariseChunk(messages, chunkIndex, totalChunks, startTime, endTime) {
    const systemPrompt = `You are a Discord chat summariser creating a detailed summary of chunk ${chunkIndex} of ${totalChunks}.

CRITICAL REQUIREMENTS:
- ALWAYS include usernames when describing who said what
- Include notable/funny/important DIRECT QUOTES with attribution (e.g., username said "exact quote")
- Preserve specific details, numbers, links, and decisions
- Don't generalize - be specific about what each person contributed
- Group by topic but maintain detail within each topic

Your summary will be combined with other chunk summaries, so preserve all important information.`;

    // Format messages for the LLM
    const formattedMessages = messages
      .map(msg => {
        let msgStr = `[${msg.timestamp}] ${msg.author}: ${msg.content}`;
        if (msg.referencedAuthor) {
          msgStr += ` (replying to ${msg.referencedAuthor})`;
        }
        return msgStr;
      })
      .join('\n');

    const userPrompt = `Time range: ${startTime} to ${endTime}
Messages in this chunk: ${messages.length}

${formattedMessages}

Create a DETAILED summary of this chunk. Requirements:
1. Use **Topic Headers** for each distinct discussion
2. Under each topic, use bullet points with USERNAME attribution
3. Include direct quotes for memorable/important statements: username said "quote"
4. Capture decisions, links shared, questions asked, and answers given
5. Don't lose information - this will be merged with other summaries later
6. Be comprehensive - aim for 1500-3000 characters`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    logger.debug(`Chunk ${chunkIndex} summary: ${summary.length} characters`);
    
    return summary.trim();
  }

  /**
   * Combine multiple chunk summaries into a final summary
   * @param {Array} chunkSummaries - Array of {index, startTime, endTime, messageCount, summary}
   * @param {number} totalMessages - Total number of messages across all chunks
   * @returns {Promise<string>} - Final combined summary
   */
  async combineSummaries(chunkSummaries, totalMessages) {
    const systemPrompt = `You are a Discord chat summariser combining ${chunkSummaries.length} detailed chunk summaries into one comprehensive final summary.

CRITICAL REQUIREMENTS:
- PRESERVE all usernames - never remove attribution
- KEEP important direct quotes with attribution
- Merge related topics across chunks but retain all significant details
- Don't dilute or over-generalize - specific details matter
- The final summary should be comprehensive and informative
- Organize by topic, with the most active/important topics first`;

    const summariesText = chunkSummaries.map(chunk => 
      `=== Chunk ${chunk.index} (${chunk.startTime} - ${chunk.endTime}, ${chunk.messageCount} messages) ===\n${chunk.summary}`
    ).join('\n\n');

    const userPrompt = `Total messages summarized: ${totalMessages}
Number of chunks: ${chunkSummaries.length}

Partial summaries to combine:

${summariesText}

Create a COMPREHENSIVE final summary that:
1. Groups related topics with **Bold Headers**
2. Preserves WHO said WHAT (always include usernames)
3. Keeps notable quotes with attribution
4. Includes all important details, decisions, and discussions
5. Orders topics by importance/activity level
6. Does NOT lose information from the chunk summaries
7. Can be long if needed - quality over brevity`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    logger.debug(`Final combined summary: ${summary.length} characters`);
    
    return summary.trim();
  }

  /**
   * Generate a catchup summary for messages since user was away
   * @param {Array} messages - Array of message objects
   * @param {Array} mentionedMessages - Messages that mention the requester
   * @param {string} requesterId - User ID who requested catchup
   * @returns {Promise<string>} - Catchup summary
   */
  async summariseCatchup(messages, mentionedMessages, requesterId) {
    const userMap = this.buildUserMap(messages);
    
    const systemPrompt = `You are a friendly Discord user catching someone up on what they missed.
Write like you're chatting naturally - casual, conversational, no formatting. Just a normal message.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    let mentionNote = '';
    if (mentionedMessages.length > 0) {
      const mentionAuthors = [...new Set(mentionedMessages.map(m => m.author))].join(', ');
      mentionNote = `\n\nIMPORTANT: They were mentioned by ${mentionAuthors} - make sure to tell them about this first!`;
    }

    const userPrompt = `Here's what happened while they were gone (${messages.length} messages):

${formattedMessages}
${mentionNote}

Catch them up casually like a friend would. Keep it short and natural - just the important stuff.

Example tone: "Hey! So while you were gone, username and username2 were chatting about [topic]. username mentioned [key point]. ${mentionedMessages.length > 0 ? 'Oh and username pinged you about [thing].' : ''}"

RULES:
- Max 400 characters
- No markdown formatting (no bold, no bullets, no headers)
- Sound like a natural Discord message
- Mention usernames naturally in the flow
- If they were mentioned, lead with that`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(summary.trim(), userMap);
  }

  /**
   * Generate a topic-focused summary
   * @param {Array} messages - Array of message objects about the topic
   * @param {string} keyword - The topic keyword
   * @returns {Promise<string>} - Topic summary
   */
  async summariseTopic(messages, keyword) {
    const userMap = this.buildUserMap(messages);
    
    const systemPrompt = `You are a friendly Discord user explaining what's been said about a topic.
Write like you're chatting naturally - casual, conversational, no formatting. Just a normal message.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    const userPrompt = `Here are ${messages.length} messages about "${keyword}":

${formattedMessages}

Explain what people have been saying about "${keyword}" casually, like you're filling someone in.

Example tone: "So about ${keyword} - username was saying [point], and username2 thinks [opinion]. They ended up agreeing that [conclusion]."

RULES:
- Max 400 characters
- No markdown formatting (no bold, no bullets, no headers)
- Sound like a natural Discord message
- Mention usernames naturally when attributing opinions
- Capture the key points and any disagreements`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(summary.trim(), userMap);
  }

  /**
   * Generate an explanation to help understand a topic
   * @param {Array} messages - Array of message objects about the topic
   * @param {string} topic - The topic to explain
   * @returns {Promise<string>} - Explanation text
   */
  async generateExplanation(messages, topic) {
    const userMap = this.buildUserMap(messages);
    
    const systemPrompt = `You are a friendly Discord user casually explaining something to someone who asked. 
Write like you're chatting naturally - no formatting, no headers, no bullet points. Just a casual message.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    const userPrompt = `Someone asked about "${topic}". Here's the recent discussion:

${formattedMessages}

Reply casually like a helpful Discord user catching them up. Write 2-3 sentences max, mention who said what naturally.

Example tone: "Oh yeah, username was talking about that earlier - basically [quick summary]. username mentioned [detail] too."

RULES:
- Max 300 characters
- No markdown formatting (no bold, no bullets, no headers)
- Sound like a natural Discord message
- Reference usernames naturally in the flow`;

    const explanation = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(explanation.trim(), userMap);
  }
}

export default new LLMService();
