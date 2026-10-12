import { prisma } from '../../../database/prisma';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
} from '../notification.types';

export class NotificationRateLimiterService {
  private static instance: NotificationRateLimiterService;

  // Limits per category per hour
  private categoryHourlyLimits: Record<string, number> = {
    [NotificationCategory.PROMOTION]: 3,
    [NotificationCategory.FLASH_SALE]: 4,
    [NotificationCategory.MEGA_CAMPAIGN]: 3,
    [NotificationCategory.COUPON]: 3,
    [NotificationCategory.PRICE_ALERT]: 5,
    [NotificationCategory.STOCK_ALERT]: 5,
    [NotificationCategory.REWARDS]: 6,
    [NotificationCategory.CHAT]: 60,
  };

  static get(): NotificationRateLimiterService {
    if (!NotificationRateLimiterService.instance) {
      NotificationRateLimiterService.instance = new NotificationRateLimiterService();
    }
    return NotificationRateLimiterService.instance;
  }

  /**
   * Check if recipient has exceeded the frequency rate limit for this category.
   */
  async isRateLimited(event: DomainNotificationEvent): Promise<boolean> {
    // 1. Transactional & Urgent notifications always bypass rate limits
    if (
      event.bypassRateLimit ||
      event.priority === NotificationPriority.URGENT ||
      event.category === NotificationCategory.SECURITY ||
      event.category === NotificationCategory.ORDER ||
      event.category === NotificationCategory.PAYMENT ||
      event.category === NotificationCategory.REFUND
    ) {
      return false;
    }

    const maxPerHour = this.categoryHourlyLimits[event.category] || 10;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    try {
      const recentCount = await prisma.notification.count({
        where: {
          userId: event.recipientId,
          category: event.category,
          createdAt: { gte: oneHourAgo },
        },
      });

      return recentCount >= maxPerHour;
    } catch (_) {
      return false;
    }
  }
}

export const notificationRateLimiterService = NotificationRateLimiterService.get();
