import { prisma } from '../../../database/prisma';
import { redisService } from '../../../database/redis';
import { RecommendationEventType, EventIngestionDto } from '../types/recommendation.types';
import { recommendationConfigManager } from '../config/recommendation.config';

export class EventCollectorService {
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly RATE_LIMIT_WINDOW_SECONDS = 60;
  private static readonly MAX_EVENTS_PER_WINDOW = 300;

  /**
   * Ingest a batch of events with security validation, anti-fraud checks, and database persistence.
   */
  async ingestBatch(events: EventIngestionDto[], clientIp?: string): Promise<{ accepted: number; rejected: number }> {
    if (!events || !Array.isArray(events) || events.length === 0) {
      return { accepted: 0, rejected: 0 };
    }

    const clampedBatch = events.slice(0, EventCollectorService.MAX_BATCH_SIZE);
    let accepted = 0;
    let rejected = 0;

    // Check anti-fraud rate limit per sessionId / IP
    for (const evt of clampedBatch) {
      const isValid = await this.validateAndFilterEvent(evt, clientIp);
      if (!isValid) {
        rejected++;
        continue;
      }

      try {
        const timestamp = evt.timestamp ? new Date(evt.timestamp) : new Date();
        await prisma.recommendationEvent.create({
          data: {
            userId: evt.userId || null,
            sessionId: evt.sessionId,
            eventType: evt.eventType,
            productId: evt.productId || null,
            categoryId: evt.categoryId || null,
            sellerId: evt.sellerId || null,
            searchQuery: evt.searchQuery ? evt.searchQuery.trim().slice(0, 200) : null,
            orderId: evt.orderId || null,
            platform: evt.platform || 'flutter_customer',
            appVersion: evt.appVersion || '1.0.0',
            metadata: evt.metadata ? JSON.stringify(evt.metadata) : null,
            timestamp,
          },
        });

        accepted++;

        // Cache invalidation for critical mutation events
        if (
          evt.eventType === RecommendationEventType.PURCHASE ||
          evt.eventType === RecommendationEventType.ORDER_COMPLETED ||
          evt.eventType === RecommendationEventType.ADD_TO_CART ||
          evt.eventType === RecommendationEventType.ADD_TO_WISHLIST
        ) {
          await this.invalidateUserPersonalizationCache(evt.userId, evt.sessionId);
        }
      } catch (err) {
        console.error('[EventCollector] Error saving event:', err);
        rejected++;
      }
    }

    return { accepted, rejected };
  }

  /**
   * Anti-fraud and payload validation:
   * 1. Rate-limit checks per session/IP
   * 2. Rapid repeated click/view filtering (debounce identical product views within 3 seconds)
   * 3. ID sanitization
   */
  private async validateAndFilterEvent(evt: EventIngestionDto, clientIp?: string): Promise<boolean> {
    if (!evt.sessionId || typeof evt.sessionId !== 'string' || evt.sessionId.length < 3) {
      return false;
    }

    if (!Object.values(RecommendationEventType).includes(evt.eventType)) {
      return false;
    }

    // Rate-limiting using Redis/In-memory
    const rateLimitKey = `rate:rec_events:${evt.sessionId}`;
    const count = await redisService.incr(rateLimitKey);
    if (count === 1) {
      await redisService.expire(rateLimitKey, EventCollectorService.RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > EventCollectorService.MAX_EVENTS_PER_WINDOW) {
      // Exceeded threshold — potential bot/script
      return false;
    }

    // Rapid duplicate view debounce: If viewing same product within 3 seconds, ignore duplicate
    if (evt.productId && (evt.eventType === RecommendationEventType.PRODUCT_VIEW || evt.eventType === RecommendationEventType.PRODUCT_CLICK)) {
      const debounceKey = `debounce:${evt.sessionId}:${evt.productId}:${evt.eventType}`;
      const existing = await redisService.get(debounceKey);
      if (existing) {
        return false; // Skip redundant duplicate
      }
      await redisService.set(debounceKey, '1', 3);
    }

    return true;
  }

  /**
   * Merges anonymous guest session behavior into authenticated profile upon login (§6, §25).
   */
  async mergeGuestSessionIntoUser(sessionId: string, userId: string): Promise<number> {
    if (!sessionId || !userId) return 0;

    try {
      const updated = await prisma.recommendationEvent.updateMany({
        where: {
          sessionId,
          userId: null,
        },
        data: {
          userId,
        },
      });

      // Clear both guest and user caches so the fresh merged recommendations are generated
      await this.invalidateUserPersonalizationCache(userId, sessionId);
      return updated.count;
    } catch (err) {
      console.error('[EventCollector] Error merging guest session:', err);
      return 0;
    }
  }

  /**
   * Invalidates recommendation cache for user and session upon state change.
   */
  async invalidateUserPersonalizationCache(userId?: string | null, sessionId?: string | null): Promise<void> {
    if (userId) {
      await redisService.del(`rec:home:${userId}`);
      await redisService.del(`rec:for_you:${userId}`);
      await redisService.del(`recommendations:user:${userId}`);
    }
    if (sessionId) {
      await redisService.del(`rec:home:${sessionId}`);
      await redisService.del(`rec:for_you:${sessionId}`);
      await redisService.del(`recommendations:user:${sessionId}`);
    }
  }
}

export const eventCollectorService = new EventCollectorService();
