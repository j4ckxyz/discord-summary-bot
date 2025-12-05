import llmService from '../services/llm.js';

/**
 * Intelligent time parser with LLM + Regex fallback
 * @param {string} input - The natural language input
 * @returns {Promise<number|null>} - Unix timestamp (seconds) or null
 */
export async function parseTime(input) {
    if (!input) return null;
    const now = Date.now();
    const str = input.toLowerCase();

    // 1. FAST PATH: Simple Regex for common cases (to save LLM tokens/time)

    // "10m", "1h"
    const simpleRegex = /^(\d+)(m|h|d|s)$/;
    const simpleMatch = str.match(simpleRegex);
    if (simpleMatch) {
        const amount = parseInt(simpleMatch[1]);
        const unit = simpleMatch[2];
        let ms = 0;
        if (unit === 's') ms = amount * 1000;
        else if (unit === 'm') ms = amount * 60 * 1000;
        else if (unit === 'h') ms = amount * 60 * 60 * 1000;
        else if (unit === 'd') ms = amount * 24 * 60 * 60 * 1000;
        return Math.floor((now + ms) / 1000);
    }

    // "in X m/h/d"
    const regex = /^in\s+(\d+)\s*(m|h|d|min|mins|hour|hours|day|days)$/;
    const match = str.match(regex);
    if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        let ms = 0;
        if (unit.startsWith('m')) ms = amount * 60 * 1000;
        else if (unit.startsWith('h')) ms = amount * 60 * 60 * 1000;
        else if (unit.startsWith('d')) ms = amount * 24 * 60 * 60 * 1000;

        return Math.floor((now + ms) / 1000);
    }

    // "tomorrow" (simple case)
    if (str === 'tomorrow') {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0); // Default 9am
        return Math.floor(d.getTime() / 1000);
    }

    // 2. INTELLIGENT PATH: Use LLM for everything else ("next friday", "sunday at 5pm")
    try {
        const isoString = await llmService.parseTime(input);
        if (isoString) {
            return Math.floor(new Date(isoString).getTime() / 1000);
        }
    } catch (e) {
        console.error("LLM time parse failed, falling back", e);
    }

    // Fallback: if LLM fails, return null
    return null;
}
