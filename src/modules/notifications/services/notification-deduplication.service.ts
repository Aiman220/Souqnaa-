import { prisma } from '../../../database/prisma';
import { DomainNotificationEvent } from '../notification.types';

export class NotificationDeduplicationService {
  private static instance: NotificationDeduplicationService;
  private memoryCache = new Map<string, number>(); // idempotencyKey -> timestamp
  private CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes deduplication window

  static get(): NotificationDeduplicationService {
    if (!NotificationDeduplicationService.instance) {
      NotificationDeduplicationService.instance = new NotificationDeduplicationService();
    }
    return NotificationDeduplicationService.instance;
  }

  /**
   * Cleans up expired cache entries periodically.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.memoryCache.entries()) {
      if (now - ts > this.CACHE_TTL_MS) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Checks whether the event is duplicate.
   * Returns true if DUPLICATE (should be dropped/ignored), false if unique (can proceed).
   */
  async isDuplicate(event: DomainNotificationEvent): Promise<boolean> {
    this.cleanup();

    const key = event.idempotencyKey || `${event.recipientId}_${event.eventType}_${event.entityId || ''}`;

    // 1. Fast in-memory check
    if (this.memoryCache.has(key)) {
      return true;
    }

    // 2. Database check for recent notifications with same idempotency key or eventId
    try {
      const recentMinutesAgo = new Date(Date.now() - 30 * 60 * 1000); // 30 min window
      const existing = await prisma.notification.findFirst({
        where: {
          userId: event.recipientId,
          createdAt: { gte: recentMinutesAgo },
          OR: [
            { idempotencyKey: key },
            ...(event.eventId ? [{ eventId: event.eventId }] : []),
          ],
        },
        select: { id: true },
      });

      if (existing) {
        this.memoryCache.set(key, Date.now());
        return true;
      }
    } catch (_) {
      // Continue safely on error
    }

    // Mark as seen
    this.memoryCache.set(key, Date.now());
    return false;
  }
}

export const notificationDeduplicationService = NotificationDeduplicationService.get();
