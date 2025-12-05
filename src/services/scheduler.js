import { ReminderModel, EventModel } from '../database/models.js';
import logger from '../utils/logger.js';

class SchedulerService {
    constructor(client) {
        this.client = client;
        this.interval = null;
        this.checkInterval = 30 * 1000; // Check every 30 seconds
    }

    start() {
        if (this.interval) return;

        logger.info('Starting SchedulerService...');
        this.interval = setInterval(() => this.runChecks(), this.checkInterval);

        // Run immediately on start
        this.runChecks();
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            logger.info('SchedulerService stopped.');
        }
    }

    async runChecks() {
        try {
            await this.checkReminders();
            // Future: checkEvents() for notifications
        } catch (error) {
            logger.error('Error in SchedulerService:', error);
        }
    }

    async checkReminders() {
        const dueReminders = ReminderModel.getDueReminders();

        for (const reminder of dueReminders) {
            try {
                const channel = await this.client.channels.fetch(reminder.channel_id).catch(() => null);

                if (channel) {
                    const message = `⏰ <@${reminder.user_id}> Reminder: ${reminder.message}`;
                    await channel.send(message);
                } else {
                    // If channel not found, try to DM user (fallback)
                    const user = await this.client.users.fetch(reminder.user_id).catch(() => null);
                    if (user) {
                        await user.send(`⏰ Reminder (from unknown channel): ${reminder.message}`).catch(() => { });
                    }
                }

                // Mark as complete even if send failed (to avoid spam loop)
                ReminderModel.markReminderComplete(reminder.id);

            } catch (error) {
                logger.error(`Failed to process reminder ${reminder.id}:`, error);
            }
        }
    }
}

export default SchedulerService;
