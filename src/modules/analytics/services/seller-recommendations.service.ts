import { AnalyticalRecommendation } from '../types/analytics.types';
import { ProductPerformanceScorecard } from '../types/analytics.types';
import { InventoryHealthItem } from '../types/analytics.types';

export class SellerRecommendationsService {
  /**
   * Generates actionable seller recommendations with explainable reasons.
   * Recommendations are informational decision-support only; never automatically changes inventory or prices.
   */
  public static generateRecommendations(
    products: ProductPerformanceScorecard[],
    inventory: InventoryHealthItem[],
    repeatCustomerRate: number
  ): AnalyticalRecommendation[] {
    const recommendations: AnalyticalRecommendation[] = [];

    // 1. Restock Recommendation
    const urgentRestock = inventory.find((i) => i.currentStock > 0 && i.estimatedDaysRemaining <= 5);
    if (urgentRestock) {
      recommendations.push({
        type: 'RESTOCK_RECOMMENDATION',
        titleAr: `إعادة توريد عاجلة للمنتج "${urgentRestock.productNameAr}"`,
        titleEn: `Urgent Restock for "${urgentRestock.productNameEn}"`,
        reasonAr: `معدل البيع اليومي = ${urgentRestock.averageDailySales} وحدة. المخزون الحالي = ${urgentRestock.currentStock} وحدة. التغطية المتوقعة = ${urgentRestock.estimatedDaysRemaining} أيام فقط.`,
        reasonEn: `Avg daily sales = ${urgentRestock.averageDailySales} units. Current stock = ${urgentRestock.currentStock}. Stock coverage = ${urgentRestock.estimatedDaysRemaining} days.`,
        actionAr: 'قم بزيادة كمية المخزون لتفادي نفاد المنتج وتوقف المبيعات.',
        actionEn: 'Increase product inventory to prevent out-of-stock downtime.',
        targetId: urgentRestock.productId,
        targetName: urgentRestock.productNameAr,
        metrics: {
          currentStock: urgentRestock.currentStock,
          averageDailySales: urgentRestock.averageDailySales,
          estimatedDaysRemaining: urgentRestock.estimatedDaysRemaining,
        },
      });
    }

    // 2. High Refund Product Quality Review
    const highRefund = products.find((p) => p.ordersCount >= 3 && p.refundRate >= 15);
    if (highRefund) {
      recommendations.push({
        type: 'HIGH_REFUND_PRODUCT',
        titleAr: `فحص جودة ومواصفات المنتج "${highRefund.productNameAr}"`,
        titleEn: `Quality & Spec Review for "${highRefund.productName}"`,
        reasonAr: `معدل الاسترجاع بلغ ${highRefund.refundRate}% من إجمالي الطلبات. قد يشير ذلك إلى عدم دقة الوصف أو الصور أو خلل مصنعي.`,
        reasonEn: `Refund rate reached ${highRefund.refundRate}% of total orders. Indicates possible description mismatch or defect.`,
        actionAr: 'راجع صور المنتج وجدول المقاسات والوصف الفني لتقليل المرتجعات.',
        actionEn: 'Verify accurate product description, images, and sizing to reduce returns.',
        targetId: highRefund.productId,
        targetName: highRefund.productNameAr,
        metrics: {
          refundRate: highRefund.refundRate,
          ordersCount: highRefund.ordersCount,
        },
      });
    }

    // 3. Low Conversion Product Price Review
    const lowConversion = products.find((p) => p.viewsCount >= 40 && p.conversionRate < 1.5);
    if (lowConversion) {
      recommendations.push({
        type: 'LOW_CONVERSION_PRODUCT',
        titleAr: `مراجعة تسعير وعرض المنتج "${lowConversion.productNameAr}"`,
        titleEn: `Price & Positioning Review for "${lowConversion.productName}"`,
        reasonAr: `حقق المنتج ${lowConversion.viewsCount} مشاهدة ولكن معدل الشراء الفعلي ${lowConversion.conversionRate}% فقط.`,
        reasonEn: `Product received ${lowConversion.viewsCount} views with only ${lowConversion.conversionRate}% purchase conversion rate.`,
        actionAr: 'قارن سعر المنتج بالبدائل المتاحة في السوق أو أضف خصماً ترويجياً لتشجيع إتمام الشراء.',
        actionEn: 'Compare pricing with market alternatives or apply a limited-time discount.',
        targetId: lowConversion.productId,
        targetName: lowConversion.productNameAr,
        metrics: {
          viewsCount: lowConversion.viewsCount,
          conversionRate: lowConversion.conversionRate,
        },
      });
    }

    // 4. Customer Retention Opportunity
    if (repeatCustomerRate < 12) {
      recommendations.push({
        type: 'CUSTOMER_RETENTION_OPPORTUNITY',
        titleAr: 'فرصة تحسين ولاء وتكرار شراء العملاء',
        titleEn: 'Customer Retention & Re-engagement Opportunity',
        reasonAr: `نسبة تكرار الشراء الحالية (${repeatCustomerRate}%) أقل من المعدل المرجعي للسوق (15%-25%).`,
        reasonEn: `Repeat purchase rate (${repeatCustomerRate}%) is below marketplace benchmark (15%-25%).`,
        actionAr: 'أرفق بطاقة شكر أو كوبون خصم للطلب القادم مع شحنات المنتجات لتحفيز عودة المشتري.',
        actionEn: 'Include a thank-you note or bounce-back coupon in orders to incentivize repeat purchases.',
        metrics: {
          currentRepeatRate: repeatCustomerRate,
          targetBenchmark: 20,
        },
      });
    }

    return recommendations;
  }
}
