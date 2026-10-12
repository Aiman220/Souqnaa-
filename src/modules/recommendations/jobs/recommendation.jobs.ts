import { QueueService } from '../../../services/jobs/queue.service';
import { featureStoreService } from '../services/feature-store.service';
import { associationRulesService } from '../services/association-rules.service';
import { pythonBridgeService } from '../services/python-bridge.service';
import { prisma } from '../../../database/prisma';

export class RecommendationJobs {
  private static readonly QUEUE_NAME = 'recommendation-tasks';

  /**
   * Schedule recurring recommendation aggregation and training tasks.
   */
  static initJobs(): void {
    console.log('[RecommendationJobs] Initializing recommendation background jobs...');

    // 1. Hourly Popularity & Trending aggregation
    setInterval(async () => {
      try {
        await RecommendationJobs.recomputeTrendingAndPopularity();
      } catch (err) {
        console.error('[RecommendationJobs] Trending sync error:', err);
      }
    }, 60 * 60 * 1000); // 1 hour

    // 2. Daily Frequently Bought Together (FBT) co-occurrence recomputation
    setInterval(async () => {
      try {
        await associationRulesService.computeMarketplaceAssociations();
      } catch (err) {
        console.error('[RecommendationJobs] FBT calculation error:', err);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    // Run initial sync after a short delay on server boot
    setTimeout(() => {
      RecommendationJobs.recomputeTrendingAndPopularity().catch((e) =>
        console.warn('[RecommendationJobs] Initial trending sync error:', e)
      );
    }, 10000);
  }

  /**
   * Recomputes trending and popularity scores across active products.
   */
  static async recomputeTrendingAndPopularity(): Promise<void> {
    const products = await prisma.product.findMany({
      where: { isActive: true, isSuspended: false },
      select: { id: true },
      take: 500,
    });

    for (const p of products) {
      await featureStoreService.syncProductFeatures(p.id);
    }
    console.log(`[RecommendationJobs] Synced features for ${products.length} products.`);
  }

  /**
   * Triggers offline model training pipeline.
   */
  static async triggerLightFmTraining(): Promise<boolean> {
    return await pythonBridgeService.runOfflineTrainingScript('train_lightfm.py');
  }
}
