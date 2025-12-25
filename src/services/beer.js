import logger from '../utils/logger.js';
import llmService from './llm.js';

class BeerToleranceService {
  constructor() {
    this.isRunning = false;
    this.intervalMs = 24 * 60 * 60 * 1000;
  }

  async updateTolerances(db) {
    try {
      logger.beer('Starting daily tolerance update...');

      const { BeerModel } = await import('../database/models.js');
      const profiles = BeerModel.getProfilesForToleranceUpdate();

      logger.beer(`Updating tolerance for ${profiles.length} user(s)`);

      for (const profile of profiles) {
        await this.updateUserTolerance(profile);
      }

      logger.beer(`Tolerance update complete: ${profiles.length} user(s) processed`);
    } catch (error) {
      logger.beer(`Tolerance update failed: ${error.message}`, 'ERROR');
    }
  }

  async updateUserTolerance(profile) {
    const { BeerModel } = await import('../database/models.js');

    const patterns = BeerModel.getUserDrinkingPatterns(profile.user_id, null, 30);

    if (!patterns || patterns.total_sessions < 2) {
      logger.beer(`Insufficient data for user ${profile.user_id}: ${patterns?.total_sessions || 0} sessions`);
      return;
    }

    const avgSession = patterns.avg_beers_per_session || 1;
    const maxSession = patterns.max_beers || 1;

    const estimatedTolerance = (avgSession * 0.7) + (maxSession * 0.3);
    const confidence = Math.min(0.95, 0.4 + (patterns.total_sessions * 0.03));

    const previousTolerance = profile.tolerance_beers || 0;
    const previousConfidence = profile.tolerance_confidence || 0;

    let newTolerance;
    let newConfidence;

    if (previousConfidence > 0.7) {
      newTolerance = (estimatedTolerance * 0.3) + (previousTolerance * 0.7);
      newConfidence = Math.min(0.95, confidence + (previousConfidence * 0.5));
    } else {
      newTolerance = estimatedTolerance;
      newConfidence = confidence;
    }

    newTolerance = Math.round(newTolerance * 10) / 10;
    newConfidence = Math.round(newConfidence * 100) / 100;

    BeerModel.updateTolerance(profile.user_id, newTolerance, newConfidence);

    logger.beer(`Updated tolerance for ${profile.user_id}: ${previousTolerance} → ${newTolerance} beers (${Math.round(newConfidence * 100)}% confidence)`);
  }

  start(db) {
    if (this.isRunning) {
      logger.beer('Tolerance service already running');
      return;
    }

    this.isRunning = true;
    logger.beer('Starting tolerance update service (daily)');

    this.interval = setInterval(async () => {
      await this.updateTolerances(db);
    }, this.intervalMs);

    setTimeout(async () => {
      await this.updateTolerances(db);
    }, 60000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.beer('Tolerance service stopped');
  }
}

export default new BeerToleranceService();
