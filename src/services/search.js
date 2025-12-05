import axios from 'axios';
import logger from '../utils/logger.js';

class SearchService {
    constructor() {
        this.apiKey = process.env.GOOGLE_PSE_API_KEY;
        this.cx = process.env.GOOGLE_PSE_CX;
        this.baseUrl = 'https://www.googleapis.com/customsearch/v1';
    }

    /**
     * Perform a Google Web Search
     * @param {string} query 
     * @returns {Promise<Array>} List of {title, link, snippet}
     */
    async search(query) {
        if (!this.apiKey || !this.cx) {
            logger.warn('SearchService: Missing credentials (GOOGLE_PSE_API_KEY or GOOGLE_PSE_CX)');
            throw new Error('Search configuration missing. Please check .env');
        }

        try {
            logger.debug(`Searching Google for: ${query}`);
            const response = await axios.get(this.baseUrl, {
                params: {
                    key: this.apiKey,
                    cx: this.cx,
                    q: query,
                    num: 5 // We only need top results for a quick summary
                }
            });

            if (!response.data.items) {
                return [];
            }

            return response.data.items.map(item => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet
            }));

        } catch (error) {
            logger.error('SearchService Error:', error.response?.data || error.message);
            throw new Error('Failed to fetch search results.');
        }
    }
}

export default new SearchService();
