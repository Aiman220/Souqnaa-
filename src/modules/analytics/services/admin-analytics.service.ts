import { ComparisonService } from './comparison.service';
import { KPIService } from './kpi.service';
import { SalesAnalyticsService } from './sales-analytics.service';
import { OrderAnalyticsService } from './order-analytics.service';
import { ProductAnalyticsService } from './product-analytics.service';
import { InventoryAnalyticsService } from './inventory-analytics.service';
import { CustomerAnalyticsService } from './customer-analytics.service';
import { PromotionAnalyticsService } from './promotion-analytics.service';
import { CommissionAnalyticsService } from './commission-analytics.service';
import { SettlementAnalyticsService } from './settlement-analytics.service';
import { TaxAnalyticsService } from './tax-analytics.service';
import { DeliveryAnalyticsService } from './delivery-analytics.service';
import { PerformanceAnalyticsService } from './performance-analytics.service';
import { AnomalyDetectionService } from './anomaly-detection.service';
import { TrendAnalysisService } from './trend-analysis.service';
import { InsightEngine } from './insight-engine.service';
import { ForecastService } from './forecast.service';
import { AnalyticsCacheService } from './analytics-cache.service';
import { AnalyticsExportService } from './analytics-export.service';
import { AnalyticsPeriod } from '../types/analytics.types';

export class AdminAnalyticsService {
  /**
   * Main unified Admin Marketplace BI Dashboard with caching and multi-period comparisons.
   */
  public static async getOverview(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const cacheKey = `admin_overview_${period}_${customStart || ''}_${customEnd || ''}`;
    const cached = AnalyticsCacheService.get(cacheKey);
    if (cached) return cached.data;

    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);

    const [
      kpis,
      timeSeries,
      topProducts,
      sellerLeaderboard,
      categoryBreakdown,
      statusBreakdown,
      paymentBreakdown,
      deliveryBreakdown,
      deliveryAnalytics,
      inventoryOverview,
      orderAnalytics,
      customerAnalytics,
      promotionAnalytics,
      commissionAnalytics,
      settlementAnalytics,
      taxAnalytics,
    ] = await Promise.all([
      KPIService.getAdminKPIOverview(range),
      SalesAnalyticsService.getTimeSeries(range),
      ProductAnalyticsService.getTopProducts(range, undefined, 'revenue', 10),
      PerformanceAnalyticsService.getSellerLeaderboard(range, 'sales', 15),
      SalesAnalyticsService.getSalesBreakdown('category', range),
      SalesAnalyticsService.getSalesBreakdown('orderStatus', range),
      SalesAnalyticsService.getSalesBreakdown('paymentMethod', range),
      SalesAnalyticsService.getSalesBreakdown('deliveryMethod', range),
      DeliveryAnalyticsService.getDeliveryAnalytics(range),
      InventoryAnalyticsService.getInventoryAnalytics(range),
      OrderAnalyticsService.getOrderLifecycleAnalytics(range),
      CustomerAnalyticsService.getCustomerAnalytics(range),
      PromotionAnalyticsService.getPromotionAnalytics(range),
      CommissionAnalyticsService.getCommissionAnalytics(range),
      SettlementAnalyticsService.getSettlementAnalytics(range),
      TaxAnalyticsService.getTaxAnalytics(range),
    ]);

    // Trend analysis on marketplace sales
    const salesValues = timeSeries.map((t) => t.grossSales);
    const marketplaceTrend = TrendAnalysisService.analyzeTrend(salesValues);

    // Anomaly Detection
    const anomalies = AnomalyDetectionService.detectAnomalies(
      {
        grossSales: kpis.gmv.currentValue,
        totalOrders: kpis.totalOrders.currentValue,
        cancelledOrders: kpis.cancelledOrders.currentValue,
        refundedOrders: kpis.refundAmount.currentValue > 0 ? 2 : 0,
      },
      {
        grossSales: kpis.gmv.previousValue,
        totalOrders: kpis.totalOrders.previousValue,
        cancelledOrders: kpis.cancelledOrders.previousValue,
        refundedOrders: kpis.refundAmount.previousValue > 0 ? 1 : 0,
      },
      range
    );

    // Marketplace explainable insights
    const insights = await InsightEngine.getInsights(
      {
        grossSalesCurrent: kpis.gmv.currentValue,
        grossSalesPrevious: kpis.gmv.previousValue,
        ordersCurrent: kpis.totalOrders.currentValue,
        ordersPrevious: kpis.totalOrders.previousValue,
        aovCurrent: kpis.aov.currentValue,
        aovPrevious: kpis.aov.previousValue,
      },
      range
    );

    // Demand Forecast for the next 14 days
    const forecast = ForecastService.forecast(salesValues, 'إجمالي مبيعات المنصة (GMV)', 14);

    const result = {
      period,
      currency: 'YER',
      range: {
        startDate: range.startDate.toISOString(),
        endDate: range.endDate.toISOString(),
        label: range.periodLabel,
      },
      kpis,
      timeSeries,
      topProducts,
      sellerLeaderboard,
      categoryBreakdown,
      breakdowns: {
        byCategory: categoryBreakdown,
        byStatus: statusBreakdown,
        byPayment: paymentBreakdown,
        byDelivery: deliveryBreakdown,
      },
      deliveryAnalytics,
      inventoryOverview: {
        totalProducts: inventoryOverview.totalProducts,
        activeProducts: inventoryOverview.activeProducts,
        outOfStockCount: inventoryOverview.outOfStockCount,
        lowStockCount: inventoryOverview.lowStockCount,
        fastMovingCount: inventoryOverview.fastMovingCount,
        deadStockCount: inventoryOverview.deadStockCount,
        warningsSummary: inventoryOverview.warningsSummary,
        items: inventoryOverview.items,
      },
      orderAnalytics,
      customerAnalytics: {
        uniqueCustomers: customerAnalytics.uniqueCustomers,
        newCustomers: customerAnalytics.newCustomers,
        returningCustomers: customerAnalytics.returningCustomers,
        repeatPurchaseRate: customerAnalytics.repeatPurchaseRate,
        averageCustomerSpend: customerAnalytics.averageCustomerSpend,
        ordersPerCustomer: customerAnalytics.ordersPerCustomer,
        segments: customerAnalytics.segments,
        cohortRetentionProxy: customerAnalytics.cohortRetentionProxy,
      },
      promotionAnalytics,
      commissionAnalytics,
      settlementAnalytics,
      taxAnalytics,
      marketplaceTrend,
      anomalies,
      insights,
      forecast,
      salesForecast: forecast,
      freshness: 'REAL_TIME',
      generatedAt: new Date().toISOString(),
    };

    AnalyticsCacheService.set(cacheKey, result, 60, 'REAL_TIME');
    return result;
  }

  public static async getSales(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    const [timeSeries, byCategory, byStatus, byPayment, byStore] = await Promise.all([
      SalesAnalyticsService.getTimeSeries(range),
      SalesAnalyticsService.getSalesBreakdown('category', range),
      SalesAnalyticsService.getSalesBreakdown('orderStatus', range),
      SalesAnalyticsService.getSalesBreakdown('paymentMethod', range),
      SalesAnalyticsService.getSalesBreakdown('store', range),
    ]);

    return {
      period,
      range: { startDate: range.startDate, endDate: range.endDate, label: range.periodLabel },
      timeSeries,
      breakdown: { byCategory, byStatus, byPayment, byStore },
    };
  }

  public static async getOrders(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return OrderAnalyticsService.getOrderLifecycleAnalytics(range);
  }

  public static async getSellers(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string,
    sortBy: any = 'sales',
    limit: number = 50
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return PerformanceAnalyticsService.getSellerLeaderboard(range, sortBy, limit);
  }

  public static async getProducts(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string,
    sortBy: any = 'revenue',
    limit: number = 50
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return ProductAnalyticsService.getTopProducts(range, undefined, sortBy, limit);
  }

  public static async getCategories(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return SalesAnalyticsService.getSalesBreakdown('category', range);
  }

  public static async getCustomers(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return CustomerAnalyticsService.getCustomerAnalytics(range);
  }

  public static async getInventory(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return InventoryAnalyticsService.getInventoryAnalytics(range);
  }

  public static async getPromotions(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return PromotionAnalyticsService.getPromotionAnalytics(range);
  }

  public static async getCommission(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return CommissionAnalyticsService.getCommissionAnalytics(range);
  }

  public static async getSettlements(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return SettlementAnalyticsService.getSettlementAnalytics(range);
  }

  public static async getTax(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return TaxAnalyticsService.getTaxAnalytics(range);
  }

  public static async getDelivery(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return DeliveryAnalyticsService.getDeliveryAnalytics(range);
  }

  public static async getAnomalies(
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const overview: any = await this.getOverview(period, customStart, customEnd);
    return overview.anomalies;
  }

  public static async exportReport(
    format: 'csv' | 'html' = 'csv',
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string,
    type: 'sales' | 'commission' | 'leaderboard' = 'sales'
  ) {
    const overview: any = await this.getOverview(period, customStart, customEnd);

    if (format === 'html') {
      return AnalyticsExportService.generateHtmlReport({
        title: type === 'commission'
          ? 'تقرير العمولات والتحصيلات والتسويات - سوقناا'
          : (type === 'leaderboard' ? 'تقرير صدارة وتصنيف المتاجر - سوقناا' : 'تقرير المبيعات والطلبات - سوقناا'),
        periodLabel: overview.range.label,
        generatedAt: new Date().toLocaleDateString('ar-YE'),
        currency: 'YER',
        kpis: [
          { label: 'إجمالي حجم البضائع (GMV)', value: `${overview.kpis.gmv.currentValue} ر.ي`, change: `${overview.kpis.gmv.percentageChange}%` },
          { label: 'إجمالي الطلبات', value: `${overview.kpis.totalOrders.currentValue}`, change: `${overview.kpis.totalOrders.percentageChange}%` },
          { label: 'عمولات المنصة', value: `${overview.kpis.marketplaceCommission.currentValue} ر.ي`, change: `${overview.kpis.marketplaceCommission.percentageChange}%` },
          { label: 'التجار النشطون', value: `${overview.kpis.activeSellersCount.currentValue}` },
        ],
        tableHeaders: type === 'commission'
          ? ['المتجر', 'التاجر', 'إجمالي المبيعات', 'العمولة المستحقة', 'الرصيد المعلق']
          : (type === 'leaderboard'
              ? ['الترتيب', 'المتجر', 'المبيعات', 'الطلبات', 'الوحدات', 'نسبة الإلغاء', 'التقييم']
              : ['التاريخ', 'إجمالي المبيعات', 'صافي المبيعات', 'الطلبات', 'الوحدات المباعة']),
        tableRows: type === 'commission'
          ? overview.sellerLeaderboard.map((s: any) => [
              s.storeName,
              s.ownerName || s.sellerName || '',
              `${s.grossSales} ر.ي`,
              `${s.commissionAmount || s.commissionGenerated || 0} ر.ي`,
              `${s.pendingSettlement || 0} ر.ي`,
            ])
          : (type === 'leaderboard'
              ? overview.sellerLeaderboard.map((s: any, idx: number) => [
                  idx + 1,
                  s.storeName,
                  `${s.grossSales} ر.ي`,
                  s.totalOrders || s.ordersCount,
                  s.unitsSold || 0,
                  `${s.cancellationRate}%`,
                  `★ ${s.averageRating || 5.0}`,
                ])
              : overview.timeSeries.map((t: any) => [
                  t.date,
                  `${t.grossSales} ر.ي`,
                  `${t.netSales || (t.grossSales * 0.95)} ر.ي`,
                  t.ordersCount || t.orders,
                  t.unitsSold || 0,
                ])),
      });
    }

    if (type === 'sales') {
      const headers = ['التاريخ', 'إجمالي المبيعات (GMV)', 'صافي المبيعات', 'عدد الطلبات', 'الوحدات المباعة', 'متوسط قيمة الطلب (AOV)', 'العملة'];
      const rows = overview.timeSeries.map((t: any) => [
        t.date,
        t.grossSales,
        t.netSales || (t.grossSales * 0.95),
        t.ordersCount || t.orders,
        t.unitsSold || 0,
        t.aov || (t.ordersCount > 0 ? Number((t.grossSales / t.ordersCount).toFixed(2)) : 0),
        'YER',
      ]);
      return AnalyticsExportService.generateCsv(headers, rows);
    }

    if (type === 'commission') {
      const headers = ['المتجر', 'التاجر', 'إجمالي المبيعات (ر.ي)', 'نسبة العمولة %', 'عمولة المنصة المحصلة (ر.ي)', 'المستحقات المعلقة (ر.ي)', 'المستحقات المصروفة (ر.ي)', 'العملة'];
      const rows = overview.sellerLeaderboard.map((s: any) => [
        s.storeName,
        s.ownerName || s.sellerName || '',
        s.grossSales,
        s.effectiveRate || '5.0%',
        s.commissionAmount || s.commissionGenerated || 0,
        s.pendingSettlement || 0,
        s.settledAmount || 0,
        'YER',
      ]);
      return AnalyticsExportService.generateCsv(headers, rows);
    }

    // Default: Leaderboard
    const headers = ['الترتيب', 'اسم المتجر', 'التاجر', 'إجمالي المبيعات (ر.ي)', 'عدد الطلبات', 'الوحدات المباعة', 'معدل الإلغاء %', 'معدل الاسترجاع %', 'تقييم المتجر', 'عمولة سوقناا (ر.ي)', 'العملة'];
    const rows = overview.sellerLeaderboard.map((s: any, idx: number) => [
      idx + 1,
      s.storeName,
      s.ownerName || s.sellerName || '',
      s.grossSales,
      s.ordersCount || s.totalOrders,
      s.unitsSold || 0,
      `${s.cancellationRate}%`,
      `${s.refundRate || 0}%`,
      s.averageRating || 5.0,
      s.commissionAmount || s.commissionGenerated || 0,
      'YER',
    ]);
    return AnalyticsExportService.generateCsv(headers, rows);
  }
}
