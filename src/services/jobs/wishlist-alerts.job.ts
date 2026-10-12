import { WishlistService } from '../../modules/wishlist/wishlist.service';
import { QueueService } from './queue.service';

export class WishlistAlertsJob {
  private static timer: NodeJS.Timeout | null = null;

  /**
   * Initialize background job worker / scheduler
   */
  static start(intervalMinutes = 15) {
    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log(`[WishlistAlertsJob] Started periodic alert checker (every ${intervalMinutes} minutes).`);

    // Run first evaluation after 10 seconds
    setTimeout(() => {
      this.runEvaluations().catch((err) => {
        console.error('[WishlistAlertsJob] Initial evaluation error:', err);
      });
    }, 10000);

    // Schedule periodic job
    this.timer = setInterval(() => {
      this.runEvaluations().catch((err) => {
        console.error('[WishlistAlertsJob] Periodic evaluation error:', err);
      });
    }, intervalMinutes * 60 * 1000);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[WishlistAlertsJob] Stopped periodic alert checker.');
    }
  }

  /**
   * Execute price-drop and back-in-stock evaluations
   */
  static async runEvaluations() {
    try {
      const settings = await WishlistService.getWishlistSettings();

      if (settings.wishlistEnabled && settings.priceDropAlertsEnabled) {
        const priceResult = await WishlistService.evaluatePriceDrops({
          defaultThresholdPercent: settings.priceDropThreshold,
          cooldownHours: settings.priceDropCooldownHours,
        });
        if (priceResult.detectedDrops > 0) {
          console.log(`[WishlistAlertsJob] Price drops evaluated: ${priceResult.detectedDrops} detected, ${priceResult.notificationsSent} notifications sent.`);
        }
      }

      if (settings.wishlistEnabled && settings.stockAlertsEnabled) {
        const stockResult = await WishlistService.evaluateStockAlerts();
        if (stockResult.stockNotificationsSent > 0) {
          console.log(`[WishlistAlertsJob] Back-in-stock evaluated: ${stockResult.stockNotificationsSent} notifications sent.`);
        }
      }

      // Flash-sale expiring alert evaluation
      if (settings.wishlistEnabled) {
        const flashSaleResult = await WishlistService.evaluateFlashSaleExpiringAlerts(4);
        if (flashSaleResult.notificationsSent > 0) {
          console.log(`[WishlistAlertsJob] Flash sale expiring alerts evaluated: ${flashSaleResult.notificationsSent} notifications sent.`);
        }
      }
    } catch (error) {
      console.error('[WishlistAlertsJob] Error running evaluations:', error);
    }
  }

  /**
   * Trigger instant check on product price update
   */
  static async onProductPriceUpdated(productId: string) {
    try {
      await QueueService.addJob('wishlist-alerts', 'check-price-drop', { productId });
    } catch {
      // Fallback direct run
      WishlistService.evaluatePriceDrops().catch(console.error);
    }
  }

  /**
   * Trigger instant check on inventory restock
   */
  static async onProductStockRestocked(productId: string, variantId?: string) {
    try {
      await QueueService.addJob('wishlist-alerts', 'check-back-in-stock', { productId, variantId });
    } catch {
      // Fallback direct run
      WishlistService.evaluateStockAlerts(productId, variantId).catch(console.error);
    }
  }
}
