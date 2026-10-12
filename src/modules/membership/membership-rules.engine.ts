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
    const metricValue = this.extractMetricValue(rule.metric, metrics);

    switch (rule.operator) {
      case 'GTE':
        return metricValue >= rule.value;
      case 'GT':
        return metricValue > rule.value;
      case 'LTE':
        return metricValue <= rule.value;
      case 'LT':
        return metricValue < rule.value;
      case 'EQ':
        return metricValue === rule.value;
      case 'BETWEEN':
        const min = rule.minValue ?? rule.value;
        const max = rule.maxValue ?? Infinity;
        return metricValue >= min && metricValue <= max;
      default:
        return false;
    }
  }

  /**
   * Evaluates the full qualification rules config (ALL / ANY).
   */
  public static isEligible(
    rulesConfig: QualificationRulesConfig,
    metrics: CustomerMetricsSnapshot
  ): boolean {
    if (!rulesConfig || !Array.isArray(rulesConfig.rules) || rulesConfig.rules.length === 0) {
      return true; // No rules implies baseline eligibility (e.g. Regular tier)
    }

    if (rulesConfig.logic === 'ANY') {
      return rulesConfig.rules.some((rule) => this.evaluateRule(rule, metrics));
    }

    // Default: 'ALL'
    return rulesConfig.rules.every((rule) => this.evaluateRule(rule, metrics));
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
    targetRulesConfig: QualificationRulesConfig,
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
    if (!targetRulesConfig || !Array.isArray(targetRulesConfig.rules) || targetRulesConfig.rules.length === 0) {
      return {
        metric: 'SPEND',
        current: 100,
        target: 100,
        remaining: 0,
        percentage: 100,
        spendProgress: null,
        orderProgress: null,
      };
    }

    let spendProgress: TierProgressMetricResult | null = null;
    let orderProgress: TierProgressMetricResult | null = null;

    for (const rule of targetRulesConfig.rules) {
      if (rule.metric === 'PERIOD_SPEND' || rule.metric === 'LIFETIME_SPEND') {
        const cur = rule.metric === 'PERIOD_SPEND' ? metrics.periodSpend : metrics.lifetimeSpend;
        const target = rule.value;
        const remaining = Math.max(0, target - cur);
        const percentage = Math.min(100, target > 0 ? Math.round((cur / target) * 100) : 100);
        spendProgress = {
          metric: 'SPEND',
          current: cur,
          target,
          remaining,
          percentage,
        };
      } else if (rule.metric === 'COMPLETED_ORDERS') {
        const cur = metrics.periodCompletedOrders ?? metrics.completedOrders;
        const target = rule.value;
        const remaining = Math.max(0, target - cur);
        const percentage = Math.min(100, target > 0 ? Math.round((cur / target) * 100) : 100);
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
    // If logic is ANY, choose the metric that is closest to completion (highest percentage)
    if (targetRulesConfig.logic === 'ANY') {
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
