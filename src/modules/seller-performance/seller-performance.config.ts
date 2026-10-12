import { prisma } from '../../database/prisma';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { PerformanceEngineConfig } from './seller-performance.types';

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceEngineConfig = {
  enabled: true,
  customerVisible: true,
  sellerVisible: true,
  recalculationEnabled: true,
  minOrders: 5,
  minReviews: 3,
  windowDays: 30,
  fulfillmentSlaHours: 48,
  weights: {
    satisfaction: 0.35,
    response: 0.20,
    completion: 0.20,
    fulfillment: 0.15,
    issueRate: 0.10,
  },
  gradeThresholds: {
    excellent: 90,
    veryGood: 80,
    good: 70,
    fair: 60,
  },
  responseTimeThresholds: {
    excellentMinutes: 5,   // <= 5 min -> 100
    veryGoodMinutes: 15,   // <= 15 min -> 85
    goodMinutes: 60,       // <= 1 hour -> 70
    fairMinutes: 360,      // <= 6 hours -> 50
    poorMinutes: 1440,     // > 6 hours -> 20
  },
  algorithmVersion: '1.0.0',
  configVersion: 1,
};

export class SellerPerformanceConfigService {
  private static cachedConfig: PerformanceEngineConfig | null = null;
  private static lastLoadedAt = 0;
  private static readonly TTL_MS = 15000; // 15s cache

  /**
   * Resolves authoritative backend configuration with validation.
   */
  public static async getConfig(): Promise<PerformanceEngineConfig> {
    const now = Date.now();
    if (this.cachedConfig && now - this.lastLoadedAt < this.TTL_MS) {
      return this.cachedConfig;
    }

    try {
      // 1. Check feature flags from RemoteConfigService
      const enabled = await remoteConfigService.isFeatureActive('seller_performance_enabled').catch(() => DEFAULT_PERFORMANCE_CONFIG.enabled);
      const customerVisible = await remoteConfigService.isFeatureActive('seller_performance_customer_visible').catch(() => DEFAULT_PERFORMANCE_CONFIG.customerVisible);
      const sellerVisible = await remoteConfigService.isFeatureActive('seller_performance_seller_visible').catch(() => DEFAULT_PERFORMANCE_CONFIG.sellerVisible);
      const recalculationEnabled = await remoteConfigService.isFeatureActive('seller_performance_recalculation_enabled').catch(() => DEFAULT_PERFORMANCE_CONFIG.recalculationEnabled);

      // 2. Query SystemSetting for granular overrides
      const settings = await prisma.systemSetting.findMany({
        where: { group: 'seller_performance' },
      });
      const settingMap = new Map<string, string>(settings.map((s) => [s.key, s.value]));

      const numVal = (key: string, def: number): number => {
        const v = settingMap.get(key);
        if (v === undefined) return def;
        const parsed = parseFloat(v);
        return isNaN(parsed) ? def : parsed;
      };

      const intVal = (key: string, def: number): number => {
        const v = settingMap.get(key);
        if (v === undefined) return def;
        const parsed = parseInt(v, 10);
        return isNaN(parsed) ? def : parsed;
      };

      const rawSatisfaction = numVal('weight_satisfaction', DEFAULT_PERFORMANCE_CONFIG.weights.satisfaction);
      const rawResponse = numVal('weight_response', DEFAULT_PERFORMANCE_CONFIG.weights.response);
      const rawCompletion = numVal('weight_completion', DEFAULT_PERFORMANCE_CONFIG.weights.completion);
      const rawFulfillment = numVal('weight_fulfillment', DEFAULT_PERFORMANCE_CONFIG.weights.fulfillment);
      const rawIssueRate = numVal('weight_issue_rate', DEFAULT_PERFORMANCE_CONFIG.weights.issueRate);

      // Validate & normalize weights so they strictly sum to 1.0 (100%)
      const totalWeight = rawSatisfaction + rawResponse + rawCompletion + rawFulfillment + rawIssueRate;
      const weights = totalWeight > 0
        ? {
            satisfaction: rawSatisfaction / totalWeight,
            response: rawResponse / totalWeight,
            completion: rawCompletion / totalWeight,
            fulfillment: rawFulfillment / totalWeight,
            issueRate: rawIssueRate / totalWeight,
          }
        : DEFAULT_PERFORMANCE_CONFIG.weights;

      const minOrders = Math.max(1, intVal('min_orders', DEFAULT_PERFORMANCE_CONFIG.minOrders));
      const minReviews = Math.max(1, intVal('min_reviews', DEFAULT_PERFORMANCE_CONFIG.minReviews));
      const windowDays = Math.max(7, intVal('window_days', DEFAULT_PERFORMANCE_CONFIG.windowDays));
      const fulfillmentSlaHours = Math.max(1, intVal('fulfillment_sla_hours', DEFAULT_PERFORMANCE_CONFIG.fulfillmentSlaHours));

      const gradeThresholds = {
        excellent: numVal('grade_excellent', DEFAULT_PERFORMANCE_CONFIG.gradeThresholds.excellent),
        veryGood: numVal('grade_very_good', DEFAULT_PERFORMANCE_CONFIG.gradeThresholds.veryGood),
        good: numVal('grade_good', DEFAULT_PERFORMANCE_CONFIG.gradeThresholds.good),
        fair: numVal('grade_fair', DEFAULT_PERFORMANCE_CONFIG.gradeThresholds.fair),
      };

      const responseTimeThresholds = {
        excellentMinutes: numVal('response_excellent_min', DEFAULT_PERFORMANCE_CONFIG.responseTimeThresholds.excellentMinutes),
        veryGoodMinutes: numVal('response_very_good_min', DEFAULT_PERFORMANCE_CONFIG.responseTimeThresholds.veryGoodMinutes),
        goodMinutes: numVal('response_good_min', DEFAULT_PERFORMANCE_CONFIG.responseTimeThresholds.goodMinutes),
        fairMinutes: numVal('response_fair_min', DEFAULT_PERFORMANCE_CONFIG.responseTimeThresholds.fairMinutes),
        poorMinutes: numVal('response_poor_min', DEFAULT_PERFORMANCE_CONFIG.responseTimeThresholds.poorMinutes),
      };

      const configVersion = intVal('config_version', DEFAULT_PERFORMANCE_CONFIG.configVersion);

      this.cachedConfig = {
        enabled,
        customerVisible,
        sellerVisible,
        recalculationEnabled,
        minOrders,
        minReviews,
        windowDays,
        fulfillmentSlaHours,
        weights,
        gradeThresholds,
        responseTimeThresholds,
        algorithmVersion: DEFAULT_PERFORMANCE_CONFIG.algorithmVersion,
        configVersion,
      };
      this.lastLoadedAt = now;
      return this.cachedConfig;
    } catch (err) {
      console.warn('[SellerPerformanceConfig] Error resolving config, falling back to defaults:', err);
      return DEFAULT_PERFORMANCE_CONFIG;
    }
  }

  /**
   * Updates configuration settings in SystemSetting table with validation.
   */
  public static async updateConfig(updates: Partial<{
    minOrders: number;
    minReviews: number;
    windowDays: number;
    fulfillmentSlaHours: number;
    weights: Partial<{
      satisfaction: number;
      response: number;
      completion: number;
      fulfillment: number;
      issueRate: number;
    }>;
  }>): Promise<PerformanceEngineConfig> {
    const current = await this.getConfig();

    const newWeights = {
      ...current.weights,
      ...(updates.weights || {}),
    };

    const sum = newWeights.satisfaction + newWeights.response + newWeights.completion + newWeights.fulfillment + newWeights.issueRate;
    if (Math.abs(sum - 1.0) > 0.05) {
      throw new Error(`مجموع الأوزان يجب أن يساوي 1.00 (100%). المجموع الحالي: ${(sum * 100).toFixed(1)}%`);
    }

    const newConfigVersion = current.configVersion + 1;

    const entries: Array<{ key: string; value: string }> = [
      { key: 'config_version', value: String(newConfigVersion) },
    ];

    if (updates.minOrders !== undefined) entries.push({ key: 'min_orders', value: String(updates.minOrders) });
    if (updates.minReviews !== undefined) entries.push({ key: 'min_reviews', value: String(updates.minReviews) });
    if (updates.windowDays !== undefined) entries.push({ key: 'window_days', value: String(updates.windowDays) });
    if (updates.fulfillmentSlaHours !== undefined) entries.push({ key: 'fulfillment_sla_hours', value: String(updates.fulfillmentSlaHours) });
    if (updates.weights?.satisfaction !== undefined) entries.push({ key: 'weight_satisfaction', value: String(updates.weights.satisfaction) });
    if (updates.weights?.response !== undefined) entries.push({ key: 'weight_response', value: String(updates.weights.response) });
    if (updates.weights?.completion !== undefined) entries.push({ key: 'weight_completion', value: String(updates.weights.completion) });
    if (updates.weights?.fulfillment !== undefined) entries.push({ key: 'weight_fulfillment', value: String(updates.weights.fulfillment) });
    if (updates.weights?.issueRate !== undefined) entries.push({ key: 'weight_issue_rate', value: String(updates.weights.issueRate) });

    await prisma.$transaction(
      entries.map((entry) =>
        prisma.systemSetting.upsert({
          where: { key: entry.key },
          update: { value: entry.value, group: 'seller_performance' },
          create: { key: entry.key, value: entry.value, group: 'seller_performance' },
        })
      )
    );

    this.cachedConfig = null;
    this.lastLoadedAt = 0;
    return this.getConfig();
  }
}
