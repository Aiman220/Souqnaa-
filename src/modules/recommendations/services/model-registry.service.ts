import { prisma } from '../../../database/prisma';

export class ModelRegistryService {
  /**
   * Deterministic experiment assignment for A/B testing (§70).
   * hash(userId || sessionId) % 100
   */
  assignExperimentGroup(userIdOrSessionId: string): 'CONTROL' | 'VARIANT' {
    let hash = 0;
    for (let i = 0; i < userIdOrSessionId.length; i++) {
      const char = userIdOrSessionId.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    const bucket = Math.abs(hash) % 100;
    return bucket < 50 ? 'CONTROL' : 'VARIANT';
  }

  /**
   * Get the active production model metadata.
   */
  async getActiveProductionModel(): Promise<any> {
    return await prisma.recommendationModel.findFirst({
      where: {
        isProduction: true,
        status: 'ACTIVE',
      },
      orderBy: { trainedAt: 'desc' },
    });
  }

  /**
   * Register a newly trained model artifact with metrics.
   */
  async registerModel(data: {
    modelVersion: string;
    algorithm: string;
    artifactPath?: string;
    parameters?: Record<string, any>;
    metrics?: Record<string, any>;
    trainingDataRange?: string;
    isProduction?: boolean;
  }): Promise<any> {
    if (data.isProduction) {
      // Mark all other models as non-production
      await prisma.recommendationModel.updateMany({
        where: { isProduction: true },
        data: { isProduction: false },
      });
    }

    return await prisma.recommendationModel.upsert({
      where: { modelVersion: data.modelVersion },
      create: {
        modelVersion: data.modelVersion,
        algorithm: data.algorithm,
        status: 'ACTIVE',
        artifactPath: data.artifactPath || null,
        parameters: data.parameters ? JSON.stringify(data.parameters) : null,
        metrics: data.metrics ? JSON.stringify(data.metrics) : null,
        trainingDataRange: data.trainingDataRange || null,
        isProduction: data.isProduction ?? false,
      },
      update: {
        status: 'ACTIVE',
        artifactPath: data.artifactPath || null,
        parameters: data.parameters ? JSON.stringify(data.parameters) : null,
        metrics: data.metrics ? JSON.stringify(data.metrics) : null,
        isProduction: data.isProduction ?? false,
      },
    });
  }

  /**
   * Rollback active model to a previous version (§21, §66).
   */
  async rollbackModel(targetVersion: string): Promise<any> {
    const target = await prisma.recommendationModel.findUnique({
      where: { modelVersion: targetVersion },
    });

    if (!target) {
      throw new Error(`Model version ${targetVersion} not found.`);
    }

    await prisma.recommendationModel.updateMany({
      where: { isProduction: true },
      data: { isProduction: false },
    });

    return await prisma.recommendationModel.update({
      where: { modelVersion: targetVersion },
      data: { isProduction: true, status: 'ACTIVE' },
    });
  }

  /**
   * Record recommendation business and evaluation metrics (§67, §68).
   */
  async recordMetrics(metricData: {
    modelVersion?: string;
    experimentId?: string;
    variant?: string;
    impressions?: number;
    clicks?: number;
    cartAdditions?: number;
    purchases?: number;
    revenue?: number;
    coverage?: number;
    coldStartPercentage?: number;
    fallbackPercentage?: number;
  }): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ctr =
      metricData.impressions && metricData.clicks
        ? (metricData.clicks / metricData.impressions) * 100
        : 0;

    const conversionRate =
      metricData.clicks && metricData.purchases
        ? (metricData.purchases / metricData.clicks) * 100
        : 0;

    await prisma.recommendationMetric.create({
      data: {
        date: today,
        modelVersion: metricData.modelVersion || 'rule_v1',
        experimentId: metricData.experimentId || null,
        variant: metricData.variant || 'CONTROL',
        impressions: metricData.impressions || 0,
        clicks: metricData.clicks || 0,
        cartAdditions: metricData.cartAdditions || 0,
        purchases: metricData.purchases || 0,
        revenue: metricData.revenue || 0,
        ctr,
        conversionRate,
        coverage: metricData.coverage || 100.0,
        coldStartPercentage: metricData.coldStartPercentage || 0,
        fallbackPercentage: metricData.fallbackPercentage || 0,
      },
    });
  }
}

export const modelRegistryService = new ModelRegistryService();
