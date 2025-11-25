import { CooldownModel } from '../database/models.js';
import { config } from '../utils/config.js';

class RateLimitService {
  /**
   * Check if a user can use the summary command
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {string} channelId - Discord channel ID
   * @returns {Object} - {allowed: boolean, remainingUses: number, timeUntilNextUse: number}
   */
  checkRateLimit(userId, guildId, channelId) {
    const canUse = CooldownModel.canUseCommand(
      userId, 
      guildId,
      channelId,
      config.cooldownMinutes,
      config.maxUsesPerWindow
    );

    if (!canUse) {
      const timeUntilNextUse = CooldownModel.getTimeUntilNextUse(
        userId,
        guildId,
        channelId,
        config.cooldownMinutes,
        config.maxUsesPerWindow
      );
      return {
        allowed: false,
        remainingUses: 0,
        timeUntilNextUse
      };
    }

    const remainingUses = CooldownModel.getRemainingUses(
      userId,
      guildId,
      channelId,
      config.cooldownMinutes,
      config.maxUsesPerWindow
    );

    return {
      allowed: true,
      remainingUses,
      timeUntilNextUse: 0
    };
  }

  /**
   * Update the cooldown for a user after they use the command
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {string} channelId - Discord channel ID
   */
  updateCooldown(userId, guildId, channelId) {
    CooldownModel.recordUse(userId, guildId, channelId);
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
