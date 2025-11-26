import logger from '../utils/logger.js';

/**
 * Embedding service for semantic search using OpenRouter API
 */
class EmbeddingService {
  constructor() {
    this.apiKey = process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY;
    this.model = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small';
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  /**
   * Generate embeddings for text using OpenRouter API
   * @param {string|Array<string>} input - Text or array of texts to embed
   * @returns {Promise<Array<Array<number>>>} - Array of embedding vectors
   */
  async generateEmbeddings(input) {
    if (!this.apiKey) {
      logger.embed('No API key configured, skipping embeddings', 'WARN');
      return null;
    }

    const texts = Array.isArray(input) ? input : [input];
    const startTime = Date.now();

    logger.embed(`Generating embeddings | model=${this.model} | texts=${texts.length}`);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/discord-summary-bot',
          'X-Title': 'Discord Summary Bot'
        },
        body: JSON.stringify({
          model: this.model,
          input: texts
        })
      });

      if (!response.ok) {
        const error = await response.text();
        const elapsed = Date.now() - startTime;
        logger.embed(`Embeddings API FAILED | status=${response.status} | time=${elapsed}ms | error=${error}`, 'ERROR');
        return null;
      }

      const data = await response.json();
      const elapsed = Date.now() - startTime;
      const dimensions = data.data[0]?.embedding?.length || 0;
      
      logger.embed(`Embeddings generated | vectors=${data.data.length} | dimensions=${dimensions} | time=${elapsed}ms`);
      
      return data.data.map(item => item.embedding);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.embed(`Embeddings API FAILED | error=${error.message} | time=${elapsed}ms`, 'ERROR');
      return null;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array<number>} a - First vector
   * @param {Array<number>} b - Second vector
   * @returns {number} - Similarity score between -1 and 1
   */
  cosineSimilarity(a, b) {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Generate related search terms for a query using the LLM
   * @param {string} query - The original search query
   * @param {number} count - Number of related terms to generate
   * @returns {Promise<Array<string>>} - Array of related search terms
   */
  async generateRelatedTerms(query, count = 15) {
    if (!this.apiKey) {
      logger.embed('No API key configured, using original query only', 'WARN');
      return [query];
    }

    const startTime = Date.now();
    logger.embed(`Generating related terms | query="${query}" | count=${count}`);

    try {
      // Use OpenRouter chat completion to generate related terms
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/discord-summary-bot',
          'X-Title': 'Discord Summary Bot'
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You generate related search terms. Output ONLY a comma-separated list of terms, nothing else.'
            },
            {
              role: 'user',
              content: `Generate ${count} words/phrases related to "${query}" that someone might use when discussing this topic in a chat. Include synonyms, related concepts, and common variations. Output only the comma-separated list.`
            }
          ],
          max_tokens: 200,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const error = await response.text();
        const elapsed = Date.now() - startTime;
        logger.embed(`Related terms API FAILED | status=${response.status} | time=${elapsed}ms`, 'ERROR');
        return [query];
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || '';
      
      // Parse comma-separated terms and clean them up
      const terms = content
        .split(',')
        .map(term => term.trim().toLowerCase())
        .filter(term => term.length > 0 && term.length < 50);

      // Always include the original query
      const uniqueTerms = [...new Set([query.toLowerCase(), ...terms])];
      const elapsed = Date.now() - startTime;
      
      logger.embed(`Related terms generated | query="${query}" | terms=${uniqueTerms.length} | time=${elapsed}ms`);
      logger.embed(`Terms: ${uniqueTerms.join(', ')}`, 'DEBUG');
      
      return uniqueTerms.slice(0, count + 1);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.embed(`Related terms FAILED | error=${error.message} | time=${elapsed}ms`, 'ERROR');
      return [query];
    }
  }

  /**
   * Search messages using semantic similarity
   * @param {Array<Object>} messages - Array of message objects with content
   * @param {string} query - Search query
   * @param {number} topK - Number of top results to return
   * @returns {Promise<Array<Object>>} - Sorted messages by relevance
   */
  async semanticSearch(messages, query, topK = 100) {
    if (!this.apiKey || messages.length === 0) {
      return messages;
    }

    const startTime = Date.now();
    logger.embed(`Semantic search starting | query="${query}" | messages=${messages.length} | topK=${topK}`);

    try {
      // Generate embeddings for query and all messages
      const texts = [query, ...messages.map(m => m.content || '')];
      const embeddings = await this.generateEmbeddings(texts);

      if (!embeddings) {
        return messages;
      }

      const queryEmbedding = embeddings[0];
      const messageEmbeddings = embeddings.slice(1);

      // Calculate similarity scores
      const scored = messages.map((msg, i) => ({
        ...msg,
        similarity: this.cosineSimilarity(queryEmbedding, messageEmbeddings[i])
      }));

      // Sort by similarity and return top results
      scored.sort((a, b) => b.similarity - a.similarity);
      const results = scored.slice(0, topK);
      const elapsed = Date.now() - startTime;
      
      const topScore = results[0]?.similarity?.toFixed(3) || 0;
      const bottomScore = results[results.length - 1]?.similarity?.toFixed(3) || 0;
      
      logger.embed(`Semantic search complete | results=${results.length} | top_score=${topScore} | bottom_score=${bottomScore} | time=${elapsed}ms`);
      
      return results;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.embed(`Semantic search FAILED | error=${error.message} | time=${elapsed}ms`, 'ERROR');
      return messages;
    }
  }
}

export default new EmbeddingService();
