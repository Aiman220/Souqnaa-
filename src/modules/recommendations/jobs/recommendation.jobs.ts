import { QueueService } from '../../../services/jobs/queue.service';
import { featureStoreService } from '../services/feature-store.service';
import { associationRulesService } from '../services/association-rules.service';
import { pythonBridgeService } from '../services/python-bridge.service';
import { prisma } from '../../../database/prisma';
import { Worker, Job } from 'bullmq';
import { config } from '../../../config';
import { redis } from '../../../database/redis';

export class RecommendationJobs {
  private static readonly QUEUE_NAME = 'recommendation-tasks';
  private static worker: Worker | null = null;

  /**
   * Initialize BullMQ worker if Redis connection is active.
   */
  static initWorker(): void {
    if (this.worker) return;

    try {
      const connectionOptions: any = config.redis.url
        ? { url: config.redis.url, maxRetriesPerRequest: null }
        : {
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            tls: config.redis.tls ? { rejectUnauthorized: false } : undefined,
            maxRetriesPerRequest: null,
          };

      this.worker = new Worker(
        RecommendationJobs.QUEUE_NAME,
        async (job: Job) => {
          if (job.name === 'recompute-trending') {
            await RecommendationJobs.recomputeTrendingAndPopularity();
          } else if (job.name === 'recompute-fbt') {
            await associationRulesService.computeMarketplaceAssociations();
          } else if (job.name === 'sync-product-features' && job.data?.productId) {
            await featureStoreService.syncProductFeatures(job.data.productId);
          }
        },
        { connection: connectionOptions, concurrency: 2 }
      );

      this.worker.on('failed', (job, err) => {
        console.error(`[RecommendationJobs Worker] Job ${job?.name} failed:`, err);
      });

      this.worker.on('error', (err) => {
        console.warn(`[RecommendationJobs Worker] Connection notice:`, err.message);
      });
    } catch (err: any) {
      console.warn(`[RecommendationJobs] Worker init skipped:`, err?.message || err);
    }
  }

  /**
   * Dispatch job to BullMQ queue if Redis is online, or execute directly with event loop safety.
   */
  static async dispatchJob(jobName: string, data: any = {}): Promise<void> {
    if (redis.isHealthy()) {
      try {
        this.initWorker();
        await QueueService.addJob(RecommendationJobs.QUEUE_NAME, jobName, data);
        return;
      } catch (err) {
        console.warn(`[RecommendationJobs] Queue dispatch failed, falling back to direct execution:`, err);
      }
    }

    // Direct in-process fallback
    try {
      if (jobName === 'recompute-trending') {
        await RecommendationJobs.recomputeTrendingAndPopularity();
      } else if (jobName === 'recompute-fbt') {
        await associationRulesService.computeMarketplaceAssociations();
      } else if (jobName === 'sync-product-features' && data?.productId) {
        await featureStoreService.syncProductFeatures(data.productId);
      }
    } catch (err) {
      console.error(`[RecommendationJobs] Direct execution error for ${jobName}:`, err);
    }
  }

  /**
   * Schedule recurring recommendation aggregation and training tasks.
   */
  static initJobs(): void {
    console.log('[RecommendationJobs] Initializing recommendation background jobs...');

    if (redis.isHealthy()) {
      this.initWorker();
    }

    // 1. Hourly Popularity & Trending aggregation
    setInterval(async () => {
      try {
        await RecommendationJobs.dispatchJob('recompute-trending');
      } catch (err) {
        console.error('[RecommendationJobs] Trending sync error:', err);
      }
    }, 60 * 60 * 1000); // 1 hour

    // 2. Daily Frequently Bought Together (FBT) co-occurrence recomputation
    setInterval(async () => {
      try {
        await RecommendationJobs.dispatchJob('recompute-fbt');
      } catch (err) {
        console.error('[RecommendationJobs] FBT calculation error:', err);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    // Run initial sync after a short delay on server boot
    setTimeout(() => {
      RecommendationJobs.dispatchJob('recompute-trending').catch((e) =>
        console.warn('[RecommendationJobs] Initial trending sync error:', e)
      );
    }, 10000);
  }

  /**
   * Recomputes trending and popularity scores across active products,
   * yielding to the event loop every 25 products to prevent blocking Node.js.
   */
  static async recomputeTrendingAndPopularity(): Promise<void> {
    const products = await prisma.product.findMany({
      where: { isActive: true, isSuspended: false },
      select: { id: true },
      take: 500,
    });

    for (let i = 0; i < products.length; i++) {
      await featureStoreService.syncProductFeatures(products[i].id);
      if (i % 25 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
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
