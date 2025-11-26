import logger from '../utils/logger.js';

// Maximum concurrent summary requests
const MAX_CONCURRENT = 2;

/**
 * Manages concurrent summary requests with a queue system.
 * Limits to MAX_CONCURRENT active summaries, queuing additional requests.
 */
class RequestQueueService {
  constructor() {
    /** @type {Set<string>} Active request IDs */
    this.activeRequests = new Set();
    
    /** @type {Array<{id: string, resolve: Function, reject: Function, channelId: string, userId: string}>} */
    this.queue = [];
  }

  /**
   * Generate a unique request ID
   * @returns {string}
   */
  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current queue position for display
   * @param {string} requestId - The request ID to find
   * @returns {number} Position in queue (1-indexed), or 0 if not in queue
   */
  getQueuePosition(requestId) {
    const index = this.queue.findIndex(item => item.id === requestId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Get the number of active requests
   * @returns {number}
   */
  getActiveCount() {
    return this.activeRequests.size;
  }

  /**
   * Get the queue length
   * @returns {number}
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * Check if a request can start immediately
   * @returns {boolean}
   */
  canStartImmediately() {
    return this.activeRequests.size < MAX_CONCURRENT;
  }

  /**
   * Request a slot to run a summary. Returns immediately if a slot is available,
   * otherwise queues the request and returns a promise that resolves when a slot opens.
   * @param {string} channelId - Channel ID for logging
   * @param {string} userId - User ID for logging
   * @returns {Promise<{requestId: string, queued: boolean, position: number}>}
   */
  async requestSlot(channelId, userId) {
    const requestId = this.generateRequestId();

    if (this.canStartImmediately()) {
      this.activeRequests.add(requestId);
      logger.debug(`Request ${requestId} started immediately (${this.activeRequests.size}/${MAX_CONCURRENT} active)`);
      return { requestId, queued: false, position: 0 };
    }

    // Need to queue
    return new Promise((resolve, reject) => {
      const queueItem = { id: requestId, resolve, reject, channelId, userId };
      this.queue.push(queueItem);
      const position = this.queue.length;
      
      logger.info(`Request ${requestId} queued at position ${position} (channel: ${channelId}, user: ${userId})`);
      
      // Resolve immediately with queued status so caller can notify user
      // The actual "go ahead" will come via the onReady callback
      resolve({ requestId, queued: true, position });
    });
  }

  /**
   * Wait for a queued request to be ready
   * @param {string} requestId - The request ID to wait for
   * @returns {Promise<void>} Resolves when the request can proceed
   */
  waitForSlot(requestId) {
    return new Promise((resolve, reject) => {
      // Check if already active (wasn't queued)
      if (this.activeRequests.has(requestId)) {
        resolve();
        return;
      }

      // Find in queue and update the resolve function
      const queueItem = this.queue.find(item => item.id === requestId);
      if (!queueItem) {
        // Request might have been processed already or doesn't exist
        reject(new Error('Request not found in queue'));
        return;
      }

      // Store the resolve function to be called when slot opens
      queueItem.onReady = resolve;
      queueItem.onError = reject;
    });
  }

  /**
   * Release a slot after a summary completes or fails
   * @param {string} requestId - The request ID to release
   */
  releaseSlot(requestId) {
    if (!this.activeRequests.has(requestId)) {
      logger.warn(`Attempted to release unknown request: ${requestId}`);
      return;
    }

    this.activeRequests.delete(requestId);
    logger.debug(`Request ${requestId} completed (${this.activeRequests.size}/${MAX_CONCURRENT} active, ${this.queue.length} queued)`);

    // Process next in queue if any
    this.processQueue();
  }

  /**
   * Process the next item in the queue if a slot is available
   */
  processQueue() {
    if (this.queue.length === 0 || !this.canStartImmediately()) {
      return;
    }

    const next = this.queue.shift();
    this.activeRequests.add(next.id);
    
    logger.info(`Request ${next.id} starting from queue (${this.activeRequests.size}/${MAX_CONCURRENT} active, ${this.queue.length} remaining)`);

    // Call the onReady callback if it exists
    if (next.onReady) {
      next.onReady();
    }
  }

  /**
   * Cancel a queued request (e.g., if user leaves or times out)
   * @param {string} requestId - The request ID to cancel
   * @returns {boolean} True if request was found and cancelled
   */
  cancelRequest(requestId) {
    // Check if active
    if (this.activeRequests.has(requestId)) {
      this.activeRequests.delete(requestId);
      this.processQueue();
      return true;
    }

    // Check if in queue
    const index = this.queue.findIndex(item => item.id === requestId);
    if (index !== -1) {
      const removed = this.queue.splice(index, 1)[0];
      if (removed.onError) {
        removed.onError(new Error('Request cancelled'));
      }
      logger.info(`Request ${requestId} cancelled from queue`);
      return true;
    }

    return false;
  }

  /**
   * Get status info for debugging/logging
   * @returns {{active: number, queued: number, maxConcurrent: number}}
   */
  getStatus() {
    return {
      active: this.activeRequests.size,
      queued: this.queue.length,
      maxConcurrent: MAX_CONCURRENT
    };
  }
}

export default new RequestQueueService();
