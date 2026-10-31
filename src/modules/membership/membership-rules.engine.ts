import {
  CustomerMetricsSnapshot,
  QualificationRuleItem,
  QualificationRulesConfig,
  TierProgressMetricResult,
} from './membership.types';

export class MembershipRulesEngine {
  /**
   * Evaluates a single rule item against customer metrics snapshot.
   */
  public static evaluateRule(
    rule: QualificationRuleItem,
    metrics: CustomerMetricsSnapshot
  ): boolean {
    if (!rule || !rule.metric || !rule.operator) return false;
    const metricValue = this.extractMetricValue(rule.metric, metrics);
    const targetValue = Number(rule.value || 0);

    switch (rule.operator) {
      case 'GTE':
        return metricValue >= targetValue;
      case 'GT':
        return metricValue > targetValue;
      case 'LTE':
        return metricValue <= targetValue;
      case 'LT':
        return metricValue < targetValue;
      case 'EQ':
        return metricValue === targetValue;
      case 'BETWEEN':
        const min = rule.minValue ?? targetValue;
        const max = rule.maxValue ?? Infinity;
        return metricValue >= min && metricValue <= max;
      default:
        return false;
    }
  }

  /**
   * Evaluates the full qualification rules config (ALL / ANY).
   * @param rulesConfig The qualification rules JSON configuration.
   * @param metrics Customer metrics snapshot.
   * @param tierLevel The numeric tier level being evaluated (1 = Basic, 2 = Silver, 3 = Gold, 4 = VIP+ Platinum).
   */
  public static isEligible(
    rulesConfig: QualificationRulesConfig | any,
    metrics: CustomerMetricsSnapshot,
    tierLevel?: number
  ): boolean {
    const isBaselineTier = typeof tierLevel === 'number' ? tierLevel <= 1 : false;

    let config = rulesConfig;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (_) {
        config = null;
      }
    }

    // Normalizing rules array
    if (!config || typeof config !== 'object') {
      return isBaselineTier;
    }

    // Handle legacy schema { minimumSpend, minimumOrders }
    if (!Array.isArray(config.rules)) {
      if (typeof config.minimumSpend === 'number' || typeof config.minimumOrders === 'number') {
        const minSpend = Number(config.minimumSpend || 0);
        const minOrders = Number(config.minimumOrders || 0);

        // If minSpend and minOrders are both 0 or negative, only baseline tier is eligible
        if (minSpend <= 0 && minOrders <= 0) {
          return isBaselineTier;
        }

        const spendOk = minSpend <= 0 || (metrics.periodSpend >= minSpend || metrics.lifetimeSpend >= minSpend);
        const ordersOk = minOrders <= 0 || ((metrics.periodCompletedOrders ?? metrics.completedOrders ?? 0) >= minOrders);
        return spendOk && ordersOk;
      }

      // No rules defined
      return isBaselineTier;
    }

    if (config.rules.length === 0) {
      return isBaselineTier;
    }

    if (config.logic === 'ANY') {
      return config.rules.some((rule: QualificationRuleItem) => this.evaluateRule(rule, metrics));
    }

    // Default: 'ALL'
    return config.rules.every((rule: QualificationRuleItem) => this.evaluateRule(rule, metrics));
  }

  /**
   * Helper to extract the numerical value corresponding to a metric.
   */
  public static extractMetricValue(
    metric: string,
    metrics: CustomerMetricsSnapshot
  ): number {
    switch (metric) {
      case 'COMPLETED_ORDERS':
        return metrics.periodCompletedOrders ?? metrics.completedOrders ?? 0;
      case 'PERIOD_SPEND':
        return metrics.periodSpend ?? 0;
      case 'LIFETIME_SPEND':
        return metrics.lifetimeSpend ?? 0;
      case 'POINTS_BALANCE':
        return metrics.pointsBalance ?? 0;
      case 'ACCOUNT_AGE_DAYS':
        return metrics.accountAgeDays ?? 0;
      default:
        return 0;
    }
  }

  /**
   * Calculates progress toward a target tier's requirements.
   * If target tier has multiple rules (ANY or ALL), evaluates both spend and orders progress.
   */
  public static calculateProgress(
    targetRulesConfig: QualificationRulesConfig | any,
    metrics: CustomerMetricsSnapshot
  ): {
    metric: 'SPEND' | 'ORDERS';
    current: number;
    target: number;
    remaining: number;
    percentage: number;
    spendProgress: TierProgressMetricResult | null;
    orderProgress: TierProgressMetricResult | null;
  } {
    // If unqualified or new customer with 0 purchases and orders, guarantee 0% progress
    const totalOrders = metrics.periodCompletedOrders ?? metrics.completedOrders ?? 0;
    const totalSpend = metrics.periodSpend ?? 0;

    let config = targetRulesConfig;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (_) {
        config = null;
      }
    }

    // Handle legacy schema
    if (config && !Array.isArray(config.rules)) {
      if (typeof config.minimumSpend === 'number' || typeof config.minimumOrders === 'number') {
        config = {
          logic: 'ANY',
          rules: [
            ...(typeof config.minimumOrders === 'number' ? [{ metric: 'COMPLETED_ORDERS', operator: 'GTE', value: config.minimumOrders }] : []),
            ...(typeof config.minimumSpend === 'number' ? [{ metric: 'PERIOD_SPEND', operator: 'GTE', value: config.minimumSpend }] : []),
          ],
        };
      }
    }

    if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
      return {
        metric: 'SPEND',
        current: totalSpend,
        target: 0,
        remaining: 0,
        percentage: 0,
        spendProgress: null,
        orderProgress: null,
      };
    }

    let spendProgress: TierProgressMetricResult | null = null;
    let orderProgress: TierProgressMetricResult | null = null;

    for (const rule of config.rules) {
      if (rule.metric === 'PERIOD_SPEND' || rule.metric === 'LIFETIME_SPEND') {
        const cur = rule.metric === 'PERIOD_SPEND' ? (metrics.periodSpend ?? 0) : (metrics.lifetimeSpend ?? 0);
        const target = Math.max(0, Number(rule.value || 0));
        const remaining = Math.max(0, target - cur);
        const percentage = target > 0 ? Math.max(0, Math.min(100, Math.floor((cur / target) * 100))) : 0;
        spendProgress = {
          metric: 'SPEND',
          current: Math.round(cur * 100) / 100,
          target,
          remaining: Math.round(remaining * 100) / 100,
          percentage,
        };
      } else if (rule.metric === 'COMPLETED_ORDERS') {
        const cur = metrics.periodCompletedOrders ?? metrics.completedOrders ?? 0;
        const target = Math.max(0, Number(rule.value || 0));
        const remaining = Math.max(0, target - cur);
        const percentage = target > 0 ? Math.max(0, Math.min(100, Math.floor((cur / target) * 100))) : 0;
        orderProgress = {
          metric: 'ORDERS',
          current: cur,
          target,
          remaining,
          percentage,
        };
      }
    }

    // Determine primary progress metric
    // If logic is ANY, choose the metric closest to completion (highest percentage)
    if (config.logic === 'ANY') {
      if (spendProgress && orderProgress) {
        const primary = spendProgress.percentage >= orderProgress.percentage ? spendProgress : orderProgress;
        return {
          ...primary,
          spendProgress,
          orderProgress,
        };
      }
    }

    // If logic is ALL or only one metric present, prefer spend if available or orders
    const chosen = spendProgress || orderProgress || {
      metric: 'SPEND' as const,
      current: 0,
      target: 0,
      remaining: 0,
      percentage: 0,
    };

    return {
      ...chosen,
      spendProgress,
      orderProgress,
    };
  }
}
