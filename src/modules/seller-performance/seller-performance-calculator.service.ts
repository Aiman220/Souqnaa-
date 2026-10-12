import {
  ComponentScores,
  PerformanceEngineConfig,
  PerformanceGrade,
  PerformanceDataStatus,
  RawPerformanceMetrics,
  SellerImprovementGuidance,
  CalculatedPerformanceResult,
} from './seller-performance.types';

export class SellerPerformanceCalculator {
  /**
   * 1. Customer Satisfaction Score (0–100, 35% weight)
   * Converts 1.0 - 5.0 star average rating into 0 - 100 score, factoring confirmed dispute penalties.
   */
  public static calculateCustomerSatisfactionScore(params: {
    ratingAverage: number;
    reviewCount: number;
    confirmedDisputesCount: number;
  }): number {
    const { ratingAverage, reviewCount, confirmedDisputesCount } = params;

    if (reviewCount === 0 && confirmedDisputesCount === 0) {
      return 100.0; // Baseline when no negative customer signal exists
    }

    let baseScore = 100.0;
    if (reviewCount > 0) {
      // 5.0 -> 100, 4.0 -> 80, 3.0 -> 60, 2.0 -> 40, 1.0 -> 20
      baseScore = (Math.max(1.0, Math.min(5.0, ratingAverage)) / 5.0) * 100.0;
    }

    // Subtract 5 points per confirmed seller-fault dispute
    const disputePenalty = Math.min(40.0, confirmedDisputesCount * 5.0);
    const finalScore = Math.max(0.0, Math.min(100.0, baseScore - disputePenalty));

    return Math.round(finalScore * 10) / 10;
  }

  /**
   * 2. Response Time Score (0–100, 20% weight)
   * Evaluates speed (median response time) and completeness (response rate).
   */
  public static calculateResponseTimeScore(params: {
    medianResponseMinutes: number;
    totalConversations: number;
    answeredConversations: number;
    thresholds: {
      excellentMinutes: number;
      veryGoodMinutes: number;
      goodMinutes: number;
      fairMinutes: number;
      poorMinutes: number;
    };
  }): { score: number; responseRate: number } {
    const { medianResponseMinutes, totalConversations, answeredConversations, thresholds } = params;

    if (totalConversations === 0) {
      return { score: 100.0, responseRate: 100.0 }; // No chats received yet
    }

    const responseRate = Math.min(100.0, Math.max(0.0, (answeredConversations / totalConversations) * 100.0));

    // Time speed score
    let timeScore: number;
    if (medianResponseMinutes <= thresholds.excellentMinutes) {
      timeScore = 100.0;
    } else if (medianResponseMinutes <= thresholds.veryGoodMinutes) {
      timeScore = 85.0 + ((thresholds.veryGoodMinutes - medianResponseMinutes) / (thresholds.veryGoodMinutes - thresholds.excellentMinutes)) * 15.0;
    } else if (medianResponseMinutes <= thresholds.goodMinutes) {
      timeScore = 70.0 + ((thresholds.goodMinutes - medianResponseMinutes) / (thresholds.goodMinutes - thresholds.veryGoodMinutes)) * 15.0;
    } else if (medianResponseMinutes <= thresholds.fairMinutes) {
      timeScore = 50.0 + ((thresholds.fairMinutes - medianResponseMinutes) / (thresholds.fairMinutes - thresholds.goodMinutes)) * 20.0;
    } else {
      timeScore = 20.0; // > 6 hours is Poor band
    }

    // Weighted composite: 70% speed SLA + 30% answer rate
    const composite = (timeScore * 0.70) + (responseRate * 0.30);
    const score = Math.max(0.0, Math.min(100.0, Math.round(composite * 10) / 10));

    return { score, responseRate: Math.round(responseRate * 10) / 10 };
  }

  /**
   * 3. Order Completion Score (0–100, 20% weight)
   * Completed orders / Eligible orders.
   * Customer-caused cancellations DO NOT penalize seller!
   */
  public static calculateOrderCompletionScore(params: {
    deliveredCount: number;
    sellerCancelledCount: number;
  }): { score: number; rate: number } {
    const { deliveredCount, sellerCancelledCount } = params;
    const denominator = deliveredCount + sellerCancelledCount;

    if (denominator === 0) {
      return { score: 100.0, rate: 100.0 };
    }

    const rate = Math.max(0.0, Math.min(100.0, (deliveredCount / denominator) * 100.0));
    return {
      score: Math.round(rate * 10) / 10,
      rate: Math.round(rate * 10) / 10,
    };
  }

  /**
   * 4. On-Time Fulfillment Score (0–100, 15% weight)
   * Fulfilled on-time within SLA / Total fulfilled orders.
   */
  public static calculateOnTimeFulfillmentScore(params: {
    onTimeCount: number;
    totalFulfilledCount: number;
  }): { score: number; rate: number } {
    const { onTimeCount, totalFulfilledCount } = params;

    if (totalFulfilledCount === 0) {
      return { score: 100.0, rate: 100.0 };
    }

    const rate = Math.max(0.0, Math.min(100.0, (onTimeCount / totalFulfilledCount) * 100.0));
    return {
      score: Math.round(rate * 10) / 10,
      rate: Math.round(rate * 10) / 10,
    };
  }

  /**
   * 5. Cancellation / Issue Rate Score (0–100, 10% weight)
   * Seller-caused issues (seller cancellations + confirmed disputes) / Total eligible orders.
   */
  public static calculateIssueRateScore(params: {
    sellerIssuesCount: number;
    totalEligibleOrders: number;
  }): { score: number; rate: number } {
    const { sellerIssuesCount, totalEligibleOrders } = params;

    if (totalEligibleOrders === 0) {
      return { score: 100.0, rate: 0.0 };
    }

    const rate = Math.max(0.0, Math.min(100.0, (sellerIssuesCount / totalEligibleOrders) * 100.0));

    // Linear curve: 0% issues -> 100 score; 10% issues -> 0 score
    const score = Math.max(0.0, Math.min(100.0, 100.0 - (rate * 10.0)));
    return {
      score: Math.round(score * 10) / 10,
      rate: Math.round(rate * 10) / 10,
    };
  }

  /**
   * Computes the weighted final score normalized to 0–100.
   */
  public static computeWeightedScore(components: ComponentScores, weights: PerformanceEngineConfig['weights']): number {
    const raw =
      components.customerSatisfactionScore * weights.satisfaction +
      components.responseTimeScore * weights.response +
      components.orderCompletionScore * weights.completion +
      components.onTimeFulfillmentScore * weights.fulfillment +
      components.issueRateScore * weights.issueRate;

    return Math.round(Math.max(0.0, Math.min(100.0, raw)) * 10) / 10;
  }

  /**
   * Resolves the Data Sufficiency Status (Protection for new sellers).
   */
  public static resolveDataStatus(params: {
    eligibleOrderCount: number;
    eligibleReviewCount: number;
    minOrders: number;
    minReviews: number;
  }): PerformanceDataStatus {
    const { eligibleOrderCount, eligibleReviewCount, minOrders, minReviews } = params;

    if (eligibleOrderCount < minOrders && eligibleReviewCount < minReviews) {
      return PerformanceDataStatus.INSUFFICIENT_DATA;
    }

    if (eligibleOrderCount < minOrders * 2 || eligibleReviewCount < minReviews) {
      return PerformanceDataStatus.PROVISIONAL;
    }

    return PerformanceDataStatus.ESTABLISHED;
  }

  /**
   * Resolves the Performance Grade from final score and thresholds.
   */
  public static resolveGrade(
    score: number,
    dataStatus: PerformanceDataStatus,
    thresholds: PerformanceEngineConfig['gradeThresholds']
  ): PerformanceGrade {
    if (dataStatus === PerformanceDataStatus.INSUFFICIENT_DATA) {
      return PerformanceGrade.INSUFFICIENT_DATA;
    }

    if (score >= thresholds.excellent) return PerformanceGrade.EXCELLENT;
    if (score >= thresholds.veryGood) return PerformanceGrade.VERY_GOOD;
    if (score >= thresholds.good) return PerformanceGrade.GOOD;
    if (score >= thresholds.fair) return PerformanceGrade.FAIR;
    return PerformanceGrade.NEEDS_IMPROVEMENT;
  }

  /**
   * Generates actionable, localized improvement recommendations for weak metrics.
   */
  public static generateRecommendations(
    metrics: RawPerformanceMetrics,
    components: ComponentScores
  ): SellerImprovementGuidance[] {
    const list: SellerImprovementGuidance[] = [];

    // Response time guidance
    if (components.responseTimeScore < 70) {
      list.push({
        key: 'RESPONSE_TIME',
        severity: components.responseTimeScore < 50 ? 'CRITICAL' : 'WARNING',
        titleAr: 'تحسين سرعة الرد على المحادثات',
        titleEn: 'Improve Chat Response Speed',
        messageAr: `متوسط وقت الرد الحالي ${Math.round(metrics.medianResponseMinutes)} دقيقة. الرد السريع خلال 15 دقيقة يرفع مبيعاتك ويحسن تقييم متجرك.`,
        messageEn: `Current median response time is ${Math.round(metrics.medianResponseMinutes)} min. Responding within 15 minutes increases sales and score.`,
        currentValueFormatted: `${Math.round(metrics.medianResponseMinutes)} دقيقة`,
        targetFormatted: 'أقل من 15 دقيقة',
        actionRoute: '/seller/chat',
      });
    }

    // Order completion guidance
    if (components.orderCompletionScore < 90) {
      list.push({
        key: 'ORDER_COMPLETION',
        severity: components.orderCompletionScore < 80 ? 'CRITICAL' : 'WARNING',
        titleAr: 'تقليل نسبة إلغاء الطلبات من المتجر',
        titleEn: 'Reduce Seller Cancellations',
        messageAr: `تم تسجيل ${metrics.sellerCancelledOrdersCount} طلب ملغي من قبلك. تأكد من تحديث المخزون لتجنب الإلغاءات بسبب نفاد الكمية.`,
        messageEn: `Recorded ${metrics.sellerCancelledOrdersCount} seller cancellations. Keep inventory updated to avoid stockout cancellations.`,
        currentValueFormatted: `${components.orderCompletionScore}%`,
        targetFormatted: '95% فأعلى',
        actionRoute: '/seller/orders',
      });
    }

    // Fulfillment SLA guidance
    if (components.onTimeFulfillmentScore < 85) {
      list.push({
        key: 'ON_TIME_FULFILLMENT',
        severity: components.onTimeFulfillmentScore < 70 ? 'CRITICAL' : 'WARNING',
        titleAr: 'تجهيز وشحن الطلبات في الموعد المحدد',
        titleEn: 'Ship Orders Within SLA',
        messageAr: 'يرجى تغيير حالة الطلبات إلى "جاهز للشحن" في غضون 24-48 ساعة لضمان وصول الشحنة للعميل في موعدها.',
        messageEn: 'Please mark orders as ready to ship within 24-48 hours to ensure timely courier dispatch.',
        currentValueFormatted: `${components.onTimeFulfillmentScore}%`,
        targetFormatted: '90% فأعلى',
        actionRoute: '/seller/orders',
      });
    }

    // Satisfaction guidance
    if (components.customerSatisfactionScore < 80) {
      list.push({
        key: 'CUSTOMER_SATISFACTION',
        severity: components.customerSatisfactionScore < 60 ? 'CRITICAL' : 'WARNING',
        titleAr: 'رفع رضا العملاء وجودة المنتجات',
        titleEn: 'Improve Customer Satisfaction',
        messageAr: `متوسط التقييم ${metrics.ratingAverage.toFixed(1)} نجوم. احرص على دقة مواصفات المنتج وجودة التغليف وسرعة التجاوب مع استفسارات المشترين.`,
        messageEn: `Average rating is ${metrics.ratingAverage.toFixed(1)} stars. Ensure accurate product details and high-quality packaging.`,
        currentValueFormatted: `${metrics.ratingAverage.toFixed(1)} ★`,
        targetFormatted: '4.5 ★ فأعلى',
        actionRoute: '/seller/reviews',
      });
    }

    // Issue rate guidance
    if (components.issueRateScore < 80) {
      list.push({
        key: 'ISSUE_RATE',
        severity: 'WARNING',
        titleAr: 'معالجة الشكاوى والنزاعات ودياً',
        titleEn: 'Resolve Disputes Amicably',
        messageAr: 'احرص على التواصل مع العميل لحل أي مشكلة متعلقة بالطلب قبل تصعيدها كنزاع رسمي.',
        messageEn: 'Communicate with customers to resolve order issues amicably before escalation.',
        currentValueFormatted: `${Math.round(100 - components.issueRateScore)}% مشاكل`,
        targetFormatted: 'أقل من 2%',
        actionRoute: '/seller/refunds',
      });
    }

    return list;
  }

  /**
   * Master Pure Calculation Function.
   */
  public static calculate(
    metrics: RawPerformanceMetrics,
    config: PerformanceEngineConfig
  ): CalculatedPerformanceResult {
    // 1. Satisfaction
    const customerSatisfactionScore = this.calculateCustomerSatisfactionScore({
      ratingAverage: metrics.ratingAverage,
      reviewCount: metrics.eligibleReviewsCount,
      confirmedDisputesCount: metrics.confirmedDisputesCount,
    });

    // 2. Response Time
    const responseResult = this.calculateResponseTimeScore({
      medianResponseMinutes: metrics.medianResponseMinutes,
      totalConversations: metrics.totalConversationsCount,
      answeredConversations: metrics.answeredConversationsCount,
      thresholds: config.responseTimeThresholds,
    });

    // 3. Order Completion
    const completionResult = this.calculateOrderCompletionScore({
      deliveredCount: metrics.deliveredOrdersCount,
      sellerCancelledCount: metrics.sellerCancelledOrdersCount,
    });

    // 4. Fulfillment
    const fulfillmentResult = this.calculateOnTimeFulfillmentScore({
      onTimeCount: metrics.onTimeOrdersCount,
      totalFulfilledCount: metrics.deliveredOrdersCount,
    });

    // 5. Issue Rate
    const issueResult = this.calculateIssueRateScore({
      sellerIssuesCount: metrics.sellerIssuesCount,
      totalEligibleOrders: metrics.deliveredOrdersCount + metrics.sellerCancelledOrdersCount,
    });

    const components: ComponentScores = {
      customerSatisfactionScore,
      responseTimeScore: responseResult.score,
      orderCompletionScore: completionResult.score,
      onTimeFulfillmentScore: fulfillmentResult.score,
      issueRateScore: issueResult.score,
    };

    const finalScore = this.computeWeightedScore(components, config.weights);

    const eligibleOrderCount = metrics.deliveredOrdersCount + metrics.sellerCancelledOrdersCount;
    const dataStatus = this.resolveDataStatus({
      eligibleOrderCount,
      eligibleReviewCount: metrics.eligibleReviewsCount,
      minOrders: config.minOrders,
      minReviews: config.minReviews,
    });

    const grade = this.resolveGrade(finalScore, dataStatus, config.gradeThresholds);
    const recommendations = this.generateRecommendations(metrics, components);

    const totalOrders = metrics.deliveredOrdersCount + metrics.sellerCancelledOrdersCount + metrics.customerCancelledOrdersCount;
    const sellerCancellationRate = totalOrders > 0
      ? Math.round((metrics.sellerCancelledOrdersCount / totalOrders) * 1000) / 10
      : 0.0;

    return {
      finalScore,
      grade,
      dataStatus,
      components,
      rates: {
        ratingAverage: Math.round(metrics.ratingAverage * 10) / 10,
        responseRate: responseResult.responseRate,
        medianResponseMinutes: Math.round(metrics.medianResponseMinutes * 10) / 10,
        orderCompletionRate: completionResult.rate,
        onTimeFulfillmentRate: fulfillmentResult.rate,
        sellerCancellationRate,
        issueRate: issueResult.rate,
      },
      counts: {
        eligibleOrderCount,
        eligibleReviewCount: metrics.eligibleReviewsCount,
        totalConversationsCount: metrics.totalConversationsCount,
        answeredConversationsCount: metrics.answeredConversationsCount,
      },
      recommendations,
      calculationWindow: `LAST_${config.windowDays}_DAYS`,
      calculationWindowDays: config.windowDays,
      algorithmVersion: config.algorithmVersion,
      configVersion: config.configVersion,
    };
  }
}
