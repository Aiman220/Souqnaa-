import { prisma } from '../../database/prisma';
import { QueueService } from '../../services/jobs/queue.service';
import { SellerPerformanceService } from './seller-performance.service';

export class SellerPerformanceEventService {
  private static debouncedRecalculations = new Set<string>();

  /**
   * Idempotently ingests a seller performance event and triggers recalculation.
   */
  public static async recordEvent(params: {
    sellerId: string;
    eventType:
      | 'ORDER_COMPLETED'
      | 'ORDER_CANCELLED'
      | 'ORDER_FULFILLMENT_UPDATED'
      | 'REVIEW_CREATED'
      | 'REVIEW_UPDATED'
      | 'DISPUTE_RESOLVED'
      | 'CHAT_RESPONSE_RECORDED';
    entityId: string;
    payload?: Record<string, any>;
  }): Promise<boolean> {
    const { sellerId, eventType, entityId, payload } = params;
    const idempotencyKey = `${eventType}:${entityId}`;

    try {
      // Check if event was already recorded
      const existing = await prisma.sellerPerformanceEvent.findUnique({
        where: { idempotencyKey },
      });

      if (existing) {
        return false; // Already processed, idempotent early return
      }

      await prisma.sellerPerformanceEvent.create({
        data: {
          sellerId,
          eventType,
          entityId,
          idempotencyKey,
          payload: payload ? JSON.stringify(payload) : null,
          processed: true,
          processedAt: new Date(),
        },
      });

      // Trigger asynchronous debounced recalculation
      this.scheduleRecalculation(sellerId, eventType);
      return true;
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Unique constraint violation (race condition handled safely)
        return false;
      }
      console.warn(`[SellerPerformanceEventService] Failed to record event ${idempotencyKey}:`, err);
      return false;
    }
  }

  /**
   * Debounces recalculation per seller to avoid repeated heavy queries during bursts.
   */
  private static scheduleRecalculation(sellerId: string, eventType: string): void {
    if (this.debouncedRecalculations.has(sellerId)) {
      return; // Recalculation already scheduled for this seller
    }

    this.debouncedRecalculations.add(sellerId);

    // Schedule background execution via QueueService or delayed timer
    setTimeout(async () => {
      this.debouncedRecalculations.delete(sellerId);
      try {
        await SellerPerformanceService.calculateSellerPerformance(sellerId, {
          triggerReason: `EVENT_${eventType}`,
        });
      } catch (err) {
        console.warn(`[SellerPerformanceEventService] Background recalculation failed for seller ${sellerId}:`, err);
      }
    }, 1500); // 1.5s debounce
  }
}
