import { CooldownModel } from '../database/models.js';
import { config } from '../utils/config.js';

class RateLimitService {
  /**
   * Check if a user can use the summary command
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @returns {Object} - {allowed: boolean, remainingSeconds: number}
   */
  checkRateLimit(userId, guildId) {
    const isOnCooldown = CooldownModel.isOnCooldown(
      userId, 
      guildId, 
      config.cooldownMinutes
    );

    if (isOnCooldown) {
      const remainingSeconds = CooldownModel.getRemainingCooldown(
        userId,
        guildId,
        config.cooldownMinutes
      );
      return {
        allowed: false,
        remainingSeconds
      };
    }

    return {
      allowed: true,
      remainingSeconds: 0
    };
  }

  /**
   * Update the cooldown for a user after they use the command
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   */
  updateCooldown(userId, guildId) {
    CooldownModel.updateCooldown(userId, guildId);
  }

  /**
   * Format remaining time as human-readable string
   * @param {number} seconds - Remaining seconds
   * @returns {string} - Formatted time string
   */
  formatRemainingTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''} and ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
    }
    return `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
  }
}

export default new RateLimitService();
