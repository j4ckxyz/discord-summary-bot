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
    const startTime = Date.now();
    const promptLength = systemPrompt.length + userPrompt.length;

    logger.llm(`Gemini API call starting | model=${this.model} | prompt_chars=${promptLength}`);

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
          logger.llm(`Gemini response BLOCKED | reason=${blockReason}`, 'WARN');
          throw new Error(`Content blocked: ${blockReason}`);
        }
        throw new Error('Empty response from Gemini');
      }

      const responseText = response.text();
      const elapsed = Date.now() - startTime;

      logger.llm(`Gemini API call complete | response_chars=${responseText.length} | time=${elapsed}ms`);

      return responseText;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.llm(`Gemini API call FAILED | error=${error.message} | time=${elapsed}ms`, 'ERROR');
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
    const startTime = Date.now();
    const promptLength = systemPrompt.length + userPrompt.length;

    let baseUrl;
    if (this.provider === 'openrouter') {
      baseUrl = 'https://openrouter.ai/api/v1';
    } else if (this.provider === 'openai') {
      baseUrl = 'https://api.openai.com/v1';
    } else {
      baseUrl = process.env.LLM_API_BASE_URL || 'https://openrouter.ai/api/v1';
    }

    logger.llm(`${this.provider} API call starting | model=${this.model} | prompt_chars=${promptLength}`);

    try {
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

      const responseText = response.data.choices[0].message.content;
      const elapsed = Date.now() - startTime;
      const usage = response.data.usage;

      if (usage) {
        logger.llm(`${this.provider} API call complete | response_chars=${responseText.length} | tokens_in=${usage.prompt_tokens} | tokens_out=${usage.completion_tokens} | time=${elapsed}ms`);
      } else {
        logger.llm(`${this.provider} API call complete | response_chars=${responseText.length} | time=${elapsed}ms`);
      }

      return responseText;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.llm(`${this.provider} API call FAILED | error=${error.response?.data?.error?.message || error.message} | time=${elapsed}ms`, 'ERROR');
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
   * @returns {Map<string, Object>} - Map of username -> {userId, displayName}
   */
  buildUserMap(messages) {
    const userMap = new Map();
    for (const msg of messages) {
      if (msg.author && msg.authorId) {
        userMap.set(msg.author.toLowerCase(), {
          userId: msg.authorId,
          displayName: msg.displayName || msg.author
        });
      }
    }
    return userMap;
  }

  /**
   * Replace usernames in text with display name format (no pings)
   * @param {string} text - The text containing usernames
   * @param {Map<string, Object>} userMap - Map of username -> {userId, displayName}
   * @returns {string} - Text with usernames replaced by display name format
   */
  replaceUsernamesWithMentions(text, userMap) {
    let result = text;

    // Sort by username length (longest first) to avoid partial replacements
    const sortedUsers = [...userMap.entries()].sort((a, b) => b[0].length - a[0].length);

    for (const [username, userData] of sortedUsers) {
      // Format: DisplayName (@username)
      const displayFormat = userData.displayName !== username
        ? `${userData.displayName} (@${username})`
        : `@${username}`;

      // Match username as a whole word (case-insensitive)
      const regex = new RegExp(`(?<!<@|<@!|/|@)\\b${this.escapeRegex(username)}\\b(?!'s\\b)`, 'gi');
      result = result.replace(regex, displayFormat);
    }

    // Also handle possessives like "username's" -> "DisplayName (@username)'s"
    for (const [username, userData] of sortedUsers) {
      const displayFormat = userData.displayName !== username
        ? `${userData.displayName} (@${username})`
        : `@${username}`;

      const possessiveRegex = new RegExp(`(?<!<@|<@!|/|@)\\b${this.escapeRegex(username)}'s\\b`, 'gi');
      result = result.replace(possessiveRegex, `${displayFormat}'s`);
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

    const systemPrompt = `You are a neutral, concise summariser. Write in clear British English. Be factual and objective. No slang, no casual language, no emojis. Use quotes sparingly for important statements only.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    let mentionNote = '';
    if (mentionedMessages.length > 0) {
      const mentionAuthors = [...new Set(mentionedMessages.map(m => m.author))].join(', ');
      mentionNote = `\n\nNOTE: The user was mentioned by: ${mentionAuthors}. Prioritise these mentions.`;
    }

    const userPrompt = `Summarise what happened in this channel while the user was away. ${messages.length} messages:

${formattedMessages}
${mentionNote}

RULES:
- Maximum 600 characters
- Start with any mentions of the user if applicable
- State who discussed what, with key points
- Include important quotes where relevant: username said "quote"
- Be neutral and factual - no casual language
- No markdown formatting`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(summary.trim(), userMap);
  }

  /**
   * Generate a topic-focused summary
   * @param {Array} messages - Array of message objects about the topic
   * @param {string} keyword - The topic keyword
   * @returns {Promise<string>} - Topic summary
   */
  async summariseTopic(messages, keyword, searchTerms = null) {
    const userMap = this.buildUserMap(messages);

    const systemPrompt = `You are a neutral, concise summariser. Write in clear British English. Be factual and objective. No slang, no casual language, no emojis. Use quotes for important statements.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    let searchContext = '';
    if (searchTerms && searchTerms.length > 0) {
      searchContext = `\nThe user searched for: "${keyword}"
Related terms used to find messages: ${searchTerms.join(', ')}
Some messages may be loosely related - focus on what is genuinely about "${keyword}".`;
    }

    const userPrompt = `Summarise discussions about "${keyword}". ${messages.length} messages found:
${searchContext}

${formattedMessages}

RULES:
- Maximum 600 characters
- Focus only on content genuinely related to "${keyword}"
- State who said what with key points
- Include important quotes: username said "quote"
- Note any disagreements or decisions
- Be neutral and factual
- No markdown formatting`;

    const summary = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(summary.trim(), userMap);
  }

  /**
   * Generate an explanation to help understand a topic
   * @param {Array} messages - Array of message objects about the topic
   * @param {string} topic - The topic to explain
   * @param {Array} searchTerms - Related terms used to find messages
   * @returns {Promise<string>} - Explanation text
   */
  async generateExplanation(messages, topic, searchTerms = null) {
    const userMap = this.buildUserMap(messages);

    const systemPrompt = `You are a neutral, concise summariser. Write in clear British English. Be factual and objective. No slang, no casual language, no emojis.`;

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    let searchContext = '';
    if (searchTerms && searchTerms.length > 0) {
      searchContext = `\nThe user asked about: "${topic}"
Related terms used to find messages: ${searchTerms.join(', ')}
Some messages may be loosely related - focus on explaining "${topic}" specifically.`;
    }

    const userPrompt = `Explain what "${topic}" means based on these discussions. ${messages.length} messages:
${searchContext}

${formattedMessages}

RULES:
- Maximum 500 characters
- Explain what "${topic}" is and the key points discussed
- Attribute viewpoints to usernames
- Include a key quote if relevant
- Be neutral and factual
- No markdown formatting`;

    const explanation = await this.generateCompletion(systemPrompt, userPrompt);
    return this.replaceUsernamesWithMentions(explanation.trim(), userMap);
  }

  /**
   * Analyze messages to find when people are free
   * @param {Array} messages - Array of message objects
   * @returns {Promise<string>} - Analysis text
   */
  async analyzeAvailability(messages) {
    const userMap = this.buildUserMap(messages);
    const now = new Date();
    const dateContext = `${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;

    // Use Pro model if available, otherwise default
    const originalModel = this.model;
    if (process.env.LLM_MODEL_PRO) {
      this.model = process.env.LLM_MODEL_PRO;
    }

    const formattedMessages = messages
      .map(msg => `[${msg.timestamp}] ${msg.author}: ${msg.content}`)
      .join('\n');

    const systemPrompt = `You are a helpful assistant analyzing a group chat to find when people are free.
Current Date: ${dateContext}

Your goal is to identify:
1. Who expressed availability for specific days/times.
2. Who expressed unavailability.
3. Common overlaps where multiple people are free.

Output format:
**Potential Times:**
- **[Day/Time]**: User A, User B, User C (Note: "User D can't")
- ...

**Details:**
- [User]: Said "Quote about time"
- ...

Keep it concise. If no one mentioned availability, say "No availability discussions found."`;

    const userPrompt = `Analyze these messages for availability:\n\n${formattedMessages}`;

    try {
      const result = await this.generateCompletion(systemPrompt, userPrompt);
      // Restore model
      this.model = originalModel;
      return this.replaceUsernamesWithMentions(result, userMap);
    } catch (e) {
      this.model = originalModel;
      throw e;
    }
  }

  /**
   * Generate a secret word and category for the Imposter game
   * @returns {Promise<{word: string, category: string}>}
   */
  async generateImposterGame() {
    const systemPrompt = `You are a Game Master for the party game "Imposter" (Word Chameleon).
Your job is to pick a random, safe, family-friendly secret word and its broad category.

Rules:
1. Category should be broad (e.g. "Food", "Animal", "Place", "Household Item", "Job", "Vehicle").
2. Word should be specific but common enough for general knowledge.
3. AVOID repeating common examples (e.g. NO Pizza, Dog, Apple, Car). Be creative!
4. Output ONLY valid JSON: {"category": "...", "word": "..."}`;

    // Add randomness to prompt to prevent caching and encourage variety
    const seed = Math.floor(Math.random() * 100000);
    const userPrompt = `Generate a new, unique word for the game. Random seed: ${seed}`;

    // Use a strict JSON parser if possible, or just parse text
    const result = await this.generateCompletion(systemPrompt, userPrompt);
    try {
      // Clean up potential markdown code blocks
      const jsonStr = result.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (e) {
      logger.error('Failed to parse Imposter game JSON:', result);
      return { category: 'Food', word: 'Pizza' }; // Fallback
    }
  }

  * Generate a clue for the Imposter game
    * @param { string } word - The secret word(or null if imposter)
   * @param { string } category - The category
  * @param { Array < string >} history - Previous clues
    * @param { boolean } isImposter - Whether the generator is the imposter
      * @param { Array < string >} forbiddenWords - List of words already used
        * @returns { Promise < string >} - Single word clue
          */
  async generateImposterClue(word, category, history, isImposter, forbiddenWords = []) {
  const historyStr = history.length > 0 ? history.map(h => `- ${h}`).join('\n') : "None yet.";
  const forbiddenStr = forbiddenWords.length > 0 ? forbiddenWords.join(', ') : "None";

  let prompt = "";
  if (isImposter) {
    prompt = `You are playing the party game "Imposter" (Word Chameleon).
Role: IMPOSTOR
Category: ${category}
Secret Word: UNKNOWN (You must blend in!)

Previous Clues from others:
${historyStr}

FORBIDDEN WORDS (Already used or taboo):
${forbiddenStr}

Your Goal:
1. Output ONE single word (or very short phrase) that fits the Category "${category}" and blends in with previous clues.
2. DO NOT use any Forbidden Word.
3. Do not reveal you don't know the word.
4. Output ONLY the word.`;
  } else {
    prompt = `You are playing the party game "Imposter" (Word Chameleon).
Role: CIVILIAN
Category: ${category}
Secret Word: ${word}

Previous Clues from others:
${historyStr}

FORBIDDEN WORDS (Already used or taboo):
${forbiddenStr}

Your Goal:
1. Output ONE single word (or very short phrase) that hints at "${word}" BUT IS NOT TOO OBVIOUS (don't give it away to the imposter).
2. DO NOT use any Forbidden Word.
3. Output ONLY the word.`;
  }

  const userPrompt = "Your clue:";

  const response = await this.generateCompletion(prompt, userPrompt);
  // Clean up response (remove punctuation, extra spaces)
  return response.trim().replace(/^['"]|['"]$/g, '').split('\n')[0];
}

  /**
   * Parse a natural language date/time string into an ISO timestamp
   * @param {string} input - The natural language input (e.g., "tomorrow at 5pm", "in 2 hours")
   * @returns {Promise<string|null>} - ISO 8601 timestamp or null if invalid
   */
  async parseTime(input) {
  const now = new Date();
  // Weekday, Month Day, Year format (e.g., "Friday, December 8, 2023")
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const dateString = now.toLocaleDateString('en-US', dateOptions);
  const timeString = now.toLocaleTimeString('en-US', { hour12: false }); // 24hr format

  const systemPrompt = `You are a strict date/time parser. Your job is to convert natural language time expressions into a specific ISO 8601 timestamp.
    
Rules:
1. Return ONLY the ISO 8601 string (e.g., "2023-12-25T15:00:00.000Z").
2. No JSON, no markdown, no explanation. Just the string.
3. If the input is relative (e.g., "in 5 mins"), calculate the time from the "Current Reference Time".
4. If the input assumes a timezone but doesn't specify it, assume the same timezone as the reference time.
5. If the date is missing (e.g., "at 5pm"), assume the next occurrence of that time (today or tomorrow).
6. BE CAREFUL WITH DAYS: If today is Friday and input is "Sunday", that is 2 days from now.
7. If the input is invalid or cannot be parsed as a time, return the string "null".`;

  const userPrompt = `Current Reference Time: ${dateString} ${timeString}
ISO Format: ${now.toISOString()}
Input to parse: "${input}"

Target ISO Timestamp:`;

  try {
    let result = await this.generateCompletion(systemPrompt, userPrompt);
    result = result.trim().replace(/['"`]/g, ''); // Clean up quotes

    if (result.toLowerCase() === 'null') {
      return null;
    }

    // Validate it's a real date
    const date = new Date(result);
    if (isNaN(date.getTime())) {
      logger.warn(`LLM returned invalid date: ${result}`);
      return null;
    }

    return result;
  } catch (error) {
    logger.error('Error parsing time with LLM:', error);
    return null;
  }
}

  /**
   * Summarise search results for a quick answer
   * @param {string} query - The search query
   * @param {Array} results - Array of {title, link, snippet}
   * @returns {Promise<string>} - Concise summary with sources
   */
  async summariseSearchResults(query, results) {
  const formattedResults = results.map((r, i) =>
    `[${i + 1}] ${r.title}: ${r.snippet} (Link: ${r.link})`
  ).join('\n\n');

  const systemPrompt = `You are a concise search assistant. 
1. Answer the query based ONLY on the provided results.
2. Be accurate and direct.
3. Keep the answer under 200 characters if possible.
4. Always cite sources using the format: [Source Name](URL).
5. If the results are irrelevant, say so.`;

  const userPrompt = `Query: ${query}

Results:
${formattedResults}

Summarise the answer:`;

  return this.generateCompletion(systemPrompt, userPrompt);
}
}

export default new LLMService();
