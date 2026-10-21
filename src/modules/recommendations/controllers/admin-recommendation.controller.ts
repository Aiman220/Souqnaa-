import { Request, Response } from 'express';
import { prisma } from '../../../database/prisma';
import { recommendationConfigManager } from '../config/recommendation.config';
import { modelRegistryService } from '../services/model-registry.service';
import { RecommendationJobs } from '../jobs/recommendation.jobs';

export class AdminRecommendationController {
  /**
   * GET /admin/recommendations/analytics (§71)
   */
  async getAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const [
        totalEvents,
        activeModels,
        recentMetrics,
        topEvents,
        totalProfiles,
      ] = await Promise.all([
        prisma.recommendationEvent.count(),
        prisma.recommendationModel.findMany({
          orderBy: { trainedAt: 'desc' },
          take: 5,
        }),
        prisma.recommendationMetric.findMany({
          orderBy: { date: 'desc' },
          take: 7,
        }),
        prisma.recommendationEvent.groupBy({
          by: ['eventType'],
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        }),
        prisma.userRecommendationProfile.count(),
      ]);

      const activeModel = activeModels.find((m) => m.isProduction) || activeModels[0] || null;
      const latestMetric = recentMetrics[0];

      // Calculate real event-derived baseline rates when no aggregated daily metric exists yet
      const clicksCount = topEvents.find((t) => t.eventType === 'PRODUCT_CLICK')?._count.id || 0;
      const viewsCount = topEvents.find((t) => t.eventType === 'PRODUCT_VIEW')?._count.id || 0;
      const purchasesCount = topEvents.find((t) => t.eventType === 'PURCHASE' || t.eventType === 'ORDER_COMPLETED')?._count.id || 0;

      const ctr = latestMetric?.ctr ?? (viewsCount > 0 ? Number(((clicksCount / viewsCount) * 100).toFixed(2)) : 0.0);
      const conversionRate = latestMetric?.conversionRate ?? (clicksCount > 0 ? Number(((purchasesCount / clicksCount) * 100).toFixed(2)) : 0.0);
      const coverage = latestMetric?.coverage ?? 100.0;
      const coldStartPercentage = latestMetric?.coldStartPercentage ?? (totalProfiles > 0 ? 0.0 : 100.0);
      const fallbackPercentage = latestMetric?.fallbackPercentage ?? 0.0;

      res.json({
        success: true,
        data: {
          totalEvents,
          totalProfiles,
          activeModelVersion: activeModel?.modelVersion || 'hybrid_ranker_v2',
          lastTrainedAt: activeModel?.trainedAt || new Date(),
          algorithm: activeModel?.algorithm || 'LIGHTFM_WARP_HYBRID',
          topEventTypes: topEvents.map((t) => ({ eventType: t.eventType, count: t._count.id })),
          recentMetrics,
          coldStartPercentage,
          fallbackPercentage,
          ctr,
          conversionRate,
          coverage,
        },
      });
    } catch (err: any) {
      console.error('[AdminRecommendationController] getAnalytics error:', err);
      res.status(500).json({ success: false, message: 'Failed to load analytics', error: err.message });
    }
  }

  /**
   * GET /admin/recommendations/config (§72)
   */
  async getConfig(req: Request, res: Response): Promise<void> {
    res.json({
      success: true,
      data: recommendationConfigManager.getConfig(),
    });
  }

  /**
   * PUT /admin/recommendations/config (§72)
   */
  async updateConfig(req: Request, res: Response): Promise<void> {
    try {
      const updated = recommendationConfigManager.updateConfig(req.body);
      res.json({
        success: true,
        message: 'Recommendation configuration updated successfully',
        data: updated,
      });
    } catch (err: any) {
      res.status(400).json({ success: false, message: 'Invalid configuration data', error: err.message });
    }
  }

  /**
   * POST /admin/recommendations/train (§20)
   */
  async triggerTraining(req: Request, res: Response): Promise<void> {
    try {
      const triggered = await RecommendationJobs.triggerLightFmTraining();
      res.json({
        success: true,
        message: triggered ? 'Offline model training launched' : 'Failed to launch training process',
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: 'Failed to trigger training', error: err.message });
    }
  }

  /**
   * POST /admin/recommendations/rollback (§21)
   */
  async rollbackModel(req: Request, res: Response): Promise<void> {
    try {
      const { modelVersion } = req.body;
      if (!modelVersion) {
        res.status(400).json({ success: false, message: 'Target modelVersion required' });
        return;
      }
      const model = await modelRegistryService.rollbackModel(modelVersion);
      res.json({
        success: true,
        message: `Successfully rolled back to ${modelVersion}`,
        data: model,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: 'Rollback failed', error: err.message });
    }
  }
}

export const adminRecommendationController = new AdminRecommendationController();
