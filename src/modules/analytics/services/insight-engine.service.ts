import { DateRange, ExplainableInsight } from '../types/analytics.types';

export interface InsightContext {
  sellerId?: string;
  grossSalesCurrent: number;
  grossSalesPrevious: number;
  ordersCurrent: number;
  ordersPrevious: number;
  aovCurrent: number;
  aovPrevious: number;
  topProductShare?: { productName: string; sharePercentage: number };
  lowStockItemsCount?: number;
  fastMovingProduct?: { productName: string; daysRemaining: number };
  repeatCustomerRate?: number;
  refundRate?: number;
}

export interface InsightProvider {
  generateInsights(context: InsightContext, range: DateRange): Promise<ExplainableInsight[]>;
}

export class RuleBasedInsightProvider implements InsightProvider {
  public async generateInsights(
    context: InsightContext,
    range: DateRange
  ): Promise<ExplainableInsight[]> {
    const insights: ExplainableInsight[] = [];
    const nowStr = new Date().toISOString();

    // 1. Sales Growth / Decline Insight
    if (context.grossSalesPrevious > 0) {
      const salesDiffPct = Number(
        (((context.grossSalesCurrent - context.grossSalesPrevious) / context.grossSalesPrevious) * 100).toFixed(1)
      );

      if (salesDiffPct >= 10) {
        insights.push({
          id: `insight-sales-growth-${Date.now()}`,
          titleAr: `نمو المبيعات بنسبة +${salesDiffPct}%`,
          titleEn: `Sales Increased by +${salesDiffPct}%`,
          descriptionAr: `ارتفعت المبيعات لتصل إلى ${context.grossSalesCurrent.toLocaleString()} ر.ي مقارنة بـ ${context.grossSalesPrevious.toLocaleString()} ر.ي في الفترة السابقة المماثلة.`,
          descriptionEn: `Sales grew to ${context.grossSalesCurrent.toLocaleString()} YER compared to ${context.grossSalesPrevious.toLocaleString()} YER in the previous period.`,
          category: 'SALES',
          metric: 'grossSales',
          source: 'سجلات طلبات البيع المعتمدة',
          calculation: '((المبيعات الحالية - المبيعات السابقة) / المبيعات السابقة) * 100',
          comparisonPeriod: range.periodLabel,
          confidenceScore: 1.0,
          actionableRecommendationAr: 'الحفاظ على توفر المنتجات الأكثر طلباً لضمان استمرارية زخم المبيعات.',
          actionableRecommendationEn: 'Maintain stock on top items to sustain sales momentum.',
          generatedAt: nowStr,
        });
      } else if (salesDiffPct <= -10) {
        insights.push({
          id: `insight-sales-drop-${Date.now()}`,
          titleAr: `انخفاض المبيعات بنسبة ${salesDiffPct}%`,
          titleEn: `Sales Decreased by ${salesDiffPct}%`,
          descriptionAr: `تراجعت المبيعات إلى ${context.grossSalesCurrent.toLocaleString()} ر.ي مقارنة بـ ${context.grossSalesPrevious.toLocaleString()} ر.ي للفترة السابقة.`,
          descriptionEn: `Sales decreased to ${context.grossSalesCurrent.toLocaleString()} YER compared to ${context.grossSalesPrevious.toLocaleString()} YER in the preceding period.`,
          category: 'SALES',
          metric: 'grossSales',
          source: 'سجلات طلبات البيع المعتمدة',
          calculation: '((المبيعات الحالية - المبيعات السابقة) / المبيعات السابقة) * 100',
          comparisonPeriod: range.periodLabel,
          confidenceScore: 1.0,
          actionableRecommendationAr: 'مراجعة الأسعار التنافسية وإطلاق عروض ترويجية لتنشيط المبيعات.',
          actionableRecommendationEn: 'Review pricing competitiveness and launch promotional vouchers.',
          generatedAt: nowStr,
        });
      }
    }

    // 2. Top Product Revenue Concentration
    if (context.topProductShare && context.topProductShare.sharePercentage >= 25) {
      insights.push({
        id: `insight-top-product-${Date.now()}`,
        titleAr: `تركيز المبيعات في منتج رئيسي (${context.topProductShare.sharePercentage}%)`,
        titleEn: `High Revenue Concentration on Hero Product`,
        descriptionAr: `يساهم منتج "${context.topProductShare.productName}" بنسبة ${context.topProductShare.sharePercentage}% من إجمالي إيرادات المتجر.`,
        descriptionEn: `Product "${context.topProductShare.productName}" generated ${context.topProductShare.sharePercentage}% of total store revenue.`,
        category: 'PERFORMANCE',
        metric: 'revenueContributionRate',
        source: 'تحليل بنود الطلبات (Order Items)',
        calculation: '(إيراد المنتج / إجمالي إيرادات المتجر) * 100',
        comparisonPeriod: range.periodLabel,
        confidenceScore: 1.0,
        actionableRecommendationAr: 'تأمين توريد مستمر لهذا المنتج وتوسيع باقة المنتجات المماثلة لتقليل مخاطر الاعتماد على منتج وحيد.',
        actionableRecommendationEn: 'Secure restock pipeline and diversify catalog to reduce single-product dependency.',
        generatedAt: nowStr,
      });
    }

    // 3. Fast Moving Product Stock Depletion
    if (context.fastMovingProduct && context.fastMovingProduct.daysRemaining <= 7) {
      insights.push({
        id: `insight-restock-urgency-${Date.now()}`,
        titleAr: `تنبيه نفاد مخزون سريع الحركة`,
        titleEn: `Fast-Moving Product Stock Depletion Risk`,
        descriptionAr: `المنتج "${context.fastMovingProduct.productName}" يباع بمعدل أسرع من المتوسط والمخزون الحالي يكفي قرابة ${context.fastMovingProduct.daysRemaining} أيام فقط.`,
        descriptionEn: `Product "${context.fastMovingProduct.productName}" has sold faster than average with only ~${context.fastMovingProduct.daysRemaining} days of stock remaining.`,
        category: 'INVENTORY',
        metric: 'stockVelocity',
        source: 'مخزون المنتجات ومعدل البيع اليومي',
        calculation: 'المخزون الحالي / معدل البيع اليومي',
        comparisonPeriod: range.periodLabel,
        confidenceScore: 0.95,
        actionableRecommendationAr: 'المبادرة بطلب كميات إعادة تعبئة فورية لتفادي ضياع فرص البيع.',
        actionableRecommendationEn: 'Initiate restock order immediately to prevent lost sales opportunities.',
        generatedAt: nowStr,
      });
    }

    // 4. Repeat Customer Loyalty Insight
    if (context.repeatCustomerRate !== undefined && context.repeatCustomerRate >= 20) {
      insights.push({
        id: `insight-loyalty-${Date.now()}`,
        titleAr: `قاعدة عملاء مخلصين بنسبة تكرار شراء ${context.repeatCustomerRate}%`,
        titleEn: `Loyal Customer Base with ${context.repeatCustomerRate}% Repeat Purchase`,
        descriptionAr: `أكثر من ${context.repeatCustomerRate}% من العملاء أجروا أكثر من عملية شراء، مما يعكس جودة ورضا مرتفعين.`,
        descriptionEn: `Over ${context.repeatCustomerRate}% of customers made repeated purchases, indicating high buyer satisfaction.`,
        category: 'CUSTOMER',
        metric: 'repeatPurchaseRate',
        source: 'سجلات تكرار الشراء للعملاء المستقلين',
        calculation: '(عدد العملاء العائدين / إجمالي العملاء الفريدين) * 100',
        comparisonPeriod: range.periodLabel,
        confidenceScore: 0.95,
        actionableRecommendationAr: 'إطلاق مكافآت وكوبونات خاصة للعملاء المخلصين لزيادة متوسط قيمة الطلب (AOV).',
        actionableRecommendationEn: 'Reward returning customers with exclusive loyalty vouchers to boost basket size.',
        generatedAt: nowStr,
      });
    }

    return insights;
  }
}

/**
 * Future-ready AI Insights Provider interface.
 * When enabled, receives sanitized analytical totals with zero PII.
 */
export class AIInsightProvider implements InsightProvider {
  public async generateInsights(
    context: InsightContext,
    range: DateRange
  ): Promise<ExplainableInsight[]> {
    // Sanitized fallback to rule-based engine when external AI provider is disabled
    const fallback = new RuleBasedInsightProvider();
    return fallback.generateInsights(context, range);
  }
}

export class InsightEngine {
  private static provider: InsightProvider = new RuleBasedInsightProvider();

  public static setProvider(newProvider: InsightProvider): void {
    this.provider = newProvider;
  }

  public static async getInsights(
    context: InsightContext,
    range: DateRange
  ): Promise<ExplainableInsight[]> {
    return this.provider.generateInsights(context, range);
  }
}
