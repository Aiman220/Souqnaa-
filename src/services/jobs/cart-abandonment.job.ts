import { cartAbandonmentService } from '../../modules/cart/abandonment/cart-abandonment.service';
import { QueueService } from './queue.service';

export class CartAbandonmentJob {
  private static timer: NodeJS.Timeout | null = null;
  private static isRunning = false;

  /**
   * Initialize background job worker / periodic scheduler
   */
  static start(intervalMinutes = 5) {
    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log(`[CartAbandonmentJob] Started periodic cart recovery evaluator (every ${intervalMinutes} minutes).`);

    // Run first evaluation after 15 seconds
    setTimeout(() => {
      this.runEvaluations().catch((err) => {
        console.error('[CartAbandonmentJob] Initial evaluation error:', err);
      });
    }, 15000);

    // Schedule periodic job
    this.timer = setInterval(() => {
      this.runEvaluations().catch((err) => {
        console.error('[CartAbandonmentJob] Periodic evaluation error:', err);
      });
    }, intervalMinutes * 60 * 1000);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[CartAbandonmentJob] Stopped periodic cart recovery evaluator.');
    }
  }

  /**
   * Execute batch evaluations for due abandoned carts
   */
  static async runEvaluations() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const result = await cartAbandonmentService.processDueAbandonedCarts(50);
      if (result.sent > 0 || result.suppressed > 0) {
        console.log(
          `[CartAbandonmentJob] Evaluated ${result.evaluated} carts: ${result.sent} reminders sent, ${result.suppressed} suppressed, ${result.deferred} deferred.`
        );
      }
    } catch (error) {
      console.error('[CartAbandonmentJob] Error running evaluations:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Event hook when a cart is created or modified
   */
  static async onCartUpdated(cartId: string, userId: string) {
    try {
      await QueueService.addJob('cart-abandonment', 'cart-updated', { cartId, userId });
    } catch {
      // Fallback direct run
      cartAbandonmentService.onCartUpdated(cartId, userId).catch(console.error);
    }
  }

  /**
   * Event hook when an order completes checkout
   */
  static async onCheckoutCompleted(userId: string, orderId: string) {
    try {
      await QueueService.addJob('cart-abandonment', 'checkout-completed', { userId, orderId });
    } catch {
      cartAbandonmentService.onCheckoutCompleted(userId, orderId).catch(console.error);
    }
  }
}
