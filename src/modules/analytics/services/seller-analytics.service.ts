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
import { TrendAnalysisService } from './trend-analysis.service';
import { InsightEngine } from './insight-engine.service';
import { SellerRecommendationsService } from './seller-recommendations.service';
import { ForecastService } from './forecast.service';
import { AnalyticsCacheService } from './analytics-cache.service';
import { AnalyticsExportService } from './analytics-export.service';
import { DeliveryAnalyticsService } from './delivery-analytics.service';
import { AnalyticsPeriod } from '../types/analytics.types';

export class SellerAnalyticsService {
  /**
   * Main unified Seller Dashboard payload with caching and period comparison.
   */
  public static async getOverview(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const cacheKey = `seller_overview_${sellerId}_${period}_${customStart || ''}_${customEnd || ''}`;
    const cached = AnalyticsCacheService.get(cacheKey);
    if (cached) return cached.data;

    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);

    const [
      kpis,
      timeSeries,
      topProducts,
      productScorecards,
      inventoryOverview,
      customerAnalytics,
      orderAnalytics,
      breakdownCategory,
      breakdownStatus,
      breakdownPayment,
      breakdownDelivery,
      promotionAnalytics,
      deliveryAnalytics,
    ] = await Promise.all([
      KPIService.getSellerKPIOverview(sellerId, range),
      SalesAnalyticsService.getTimeSeries(range, sellerId),
      ProductAnalyticsService.getTopProducts(range, sellerId, 'revenue', 10),
      ProductAnalyticsService.getProductScorecards(range, sellerId),
      InventoryAnalyticsService.getInventoryAnalytics(range, sellerId),
      CustomerAnalyticsService.getCustomerAnalytics(range, sellerId),
      OrderAnalyticsService.getOrderLifecycleAnalytics(range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('category', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('orderStatus', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('paymentMethod', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('deliveryMethod', range, sellerId),
      PromotionAnalyticsService.getPromotionAnalytics(range, sellerId),
      DeliveryAnalyticsService.getDeliveryAnalytics(range, sellerId),
    ]);

    // Trend analysis on sales sequence
    const salesValues = timeSeries.map((t: { grossSales: number }) => t.grossSales);
    const salesTrend = TrendAnalysisService.analyzeTrend(salesValues);

    // Explainable Insights
    const topHero = topProducts[0];
    const fastHero = inventoryOverview.items.find((i: { status: string }) => i.status === 'FAST_MOVING');
    const insights = await InsightEngine.getInsights(
      {
        sellerId,
        grossSalesCurrent: kpis.grossSales.currentValue,
        grossSalesPrevious: kpis.grossSales.previousValue,
        ordersCurrent: kpis.totalOrders.currentValue,
        ordersPrevious: kpis.totalOrders.previousValue,
        aovCurrent: kpis.averageOrderValue.currentValue,
        aovPrevious: kpis.averageOrderValue.previousValue,
        topProductShare: topHero
          ? { productName: topHero.productNameAr, sharePercentage: topHero.revenueContributionRate }
          : undefined,
        fastMovingProduct: fastHero
          ? { productName: fastHero.productNameAr, daysRemaining: fastHero.estimatedDaysRemaining }
          : undefined,
        repeatCustomerRate: customerAnalytics.repeatPurchaseRate,
      },
      range
    );

    // Recommendations
    const recommendations = SellerRecommendationsService.generateRecommendations(
      productScorecards.length > 0 ? productScorecards : topProducts as any,
      inventoryOverview.items,
      customerAnalytics.repeatPurchaseRate
    );

    // Sales Forecast for the next 7 days
    const forecast = ForecastService.forecast(salesValues, 'المبيعات الإجمالية', 7);

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
      productScorecards,
      orderAnalytics,
      breakdowns: {
        byCategory: breakdownCategory,
        byStatus: breakdownStatus,
        byPayment: breakdownPayment,
        byDelivery: breakdownDelivery,
      },
      promotionAnalytics,
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
      salesTrend,
      insights,
      recommendations,
      forecast,
      freshness: 'REAL_TIME',
      generatedAt: new Date().toISOString(),
    };

    AnalyticsCacheService.set(cacheKey, result, 60, 'REAL_TIME');
    return result;
  }

  public static async getSales(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    const [timeSeries, byCategory, byStatus, byPayment, byStore] = await Promise.all([
      SalesAnalyticsService.getTimeSeries(range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('category', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('orderStatus', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('paymentMethod', range, sellerId),
      SalesAnalyticsService.getSalesBreakdown('store', range, sellerId),
    ]);

    return {
      period,
      range: { startDate: range.startDate, endDate: range.endDate, label: range.periodLabel },
      timeSeries,
      breakdown: {
        byCategory,
        byStatus,
        byPayment,
        byStore,
      },
    };
  }

  public static async getOrders(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return OrderAnalyticsService.getOrderLifecycleAnalytics(range, sellerId);
  }

  public static async getProducts(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string,
    sortBy: any = 'revenue',
    limit: number = 50
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return ProductAnalyticsService.getTopProducts(range, sellerId, sortBy, limit);
  }

  public static async getInventory(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return InventoryAnalyticsService.getInventoryAnalytics(range, sellerId);
  }

  public static async getCustomers(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return CustomerAnalyticsService.getCustomerAnalytics(range, sellerId);
  }

  public static async getPromotions(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return PromotionAnalyticsService.getPromotionAnalytics(range, sellerId);
  }

  public static async getCommission(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return CommissionAnalyticsService.getCommissionAnalytics(range, sellerId);
  }

  public static async getSettlements(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return SettlementAnalyticsService.getSettlementAnalytics(range, sellerId);
  }

  public static async getTax(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const range = ComparisonService.resolveDateRange(period, customStart, customEnd);
    return TaxAnalyticsService.getTaxAnalytics(range, sellerId);
  }

  public static async getInsights(
    sellerId: string,
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string
  ) {
    const overview: any = await this.getOverview(sellerId, period, customStart, customEnd);
    return {
      insights: overview.insights,
      recommendations: overview.recommendations,
      salesTrend: overview.salesTrend,
      forecast: overview.forecast,
    };
  }

  public static async exportReport(
    sellerId: string,
    format: 'csv' | 'html' = 'csv',
    period: AnalyticsPeriod = '30d',
    customStart?: string,
    customEnd?: string,
    type: 'sales' | 'products' | 'inventory' | 'financials' = 'sales'
  ) {
    const overview: any = await this.getOverview(sellerId, period, customStart, customEnd);

    if (format === 'html') {
      const titleMap = {
        sales: 'تقرير المبيعات والطلبات - سوقناا',
        products: 'تقرير أداء ومساهمة المنتجات - سوقناا',
        inventory: 'تقرير صحة وحركة المخزون - سوقناا',
        financials: 'تقرير الأداء المالي وصافي الأرباح - سوقناا',
      };

      let tableHeaders: string[] = [];
      let tableRows: (string | number)[][] = [];

      if (type === 'products') {
        tableHeaders = ['المنتج', 'الوحدات المباعة', 'الإيراد الإجمالي (ر.ي)', 'عدد الطلبات', 'معدل التحويل', 'المخزون الحالي'];
        tableRows = overview.topProducts.map((p: any) => [
          p.productNameAr,
          p.unitsSold,
          `${p.grossRevenue} ر.ي`,
          p.ordersCount,
          `${p.conversionRate}%`,
          p.currentStock,
        ]);
      } else if (type === 'inventory') {
        tableHeaders = ['المنتج', 'المخزون الحالي', 'الاستهلاك اليومي', 'أيام المخزون المتبقية', 'حالة المخزون', 'قيمة المخزون'];
        tableRows = (overview.inventoryOverview?.items || []).map((i: any) => {
          const statusLabel = i.status === 'OUT_OF_STOCK'
            ? 'نفد المخزون'
            : i.status === 'LOW_STOCK'
            ? 'مخزون منخفض'
            : i.status === 'FAST_MOVING'
            ? 'سريع الحركة'
            : i.status === 'DEAD_STOCK'
            ? 'مخزون راكد'
            : 'طبيعي';
          return [
            i.productNameAr,
            i.currentStock,
            i.burnRateDaily || 0,
            i.estimatedDaysRemaining !== null ? `${i.estimatedDaysRemaining} يوم` : 'غير محدد',
            statusLabel,
            `${i.inventoryValue || 0} ر.ي`,
          ];
        });
      } else if (type === 'financials') {
        tableHeaders = ['البند المالي', 'القيمة الحالية (ر.ي)', 'القيمة السابقة (ر.ي)', 'نسبة التغير'];
        const commCurrent = Math.max(0, overview.kpis.grossSales.currentValue - overview.kpis.netEarnings.currentValue);
        const commPrevious = Math.max(0, overview.kpis.grossSales.previousValue - overview.kpis.netEarnings.previousValue);
        tableRows = [
          ['إجمالي مبيعات البضائع (Gross Sales)', `${overview.kpis.grossSales.currentValue} ر.ي`, `${overview.kpis.grossSales.previousValue} ر.ي`, `${overview.kpis.grossSales.percentageChange}%`],
          ['صافي أرباح المتجر (Net Earnings)', `${overview.kpis.netEarnings.currentValue} ر.ي`, `${overview.kpis.netEarnings.previousValue} ر.ي`, `${overview.kpis.netEarnings.percentageChange}%`],
          ['عمولات المنصة المستقطعة المقدرة', `${commCurrent.toFixed(2)} ر.ي`, `${commPrevious.toFixed(2)} ر.ي`, `${overview.kpis.grossSales.percentageChange}%`],
          ['متوسط قيمة الطلب (AOV)', `${overview.kpis.averageOrderValue.currentValue} ر.ي`, `${overview.kpis.averageOrderValue.previousValue} ر.ي`, `${overview.kpis.averageOrderValue.percentageChange}%`],
          ['إجمالي عدد الطلبات', overview.kpis.totalOrders.currentValue, overview.kpis.totalOrders.previousValue, `${overview.kpis.totalOrders.percentageChange}%`],
          ['إجمالي الوحدات المباعة', overview.kpis.unitsSold.currentValue, overview.kpis.unitsSold.previousValue, `${overview.kpis.unitsSold.percentageChange}%`],
        ];
      } else {
        // Sales
        tableHeaders = ['التاريخ', 'إجمالي المبيعات (ر.ي)', 'صافي الأرباح (ر.ي)', 'عدد الطلبات', 'الوحدات المباعة'];
        tableRows = (overview.timeSeries || []).map((t: any) => [
          t.date,
          `${t.grossSales} ر.ي`,
          `${t.netSales || (t.grossSales * 0.95)} ر.ي`,
          t.ordersCount || t.orders || 0,
          t.unitsSold || 0,
        ]);
      }

      return AnalyticsExportService.generateHtmlReport({
        title: titleMap[type] || 'تقرير مبيعات المتجر التحليلي',
        periodLabel: overview.range.label,
        generatedAt: new Date().toLocaleDateString('ar-YE'),
        currency: 'YER',
        kpis: [
          { label: 'إجمالي المبيعات', value: `${overview.kpis.grossSales.currentValue} ر.ي`, change: `${overview.kpis.grossSales.percentageChange}%` },
          { label: 'صافي أرباح البائع', value: `${overview.kpis.netEarnings.currentValue} ر.ي`, change: `${overview.kpis.netEarnings.percentageChange}%` },
          { label: 'عدد الطلبات', value: `${overview.kpis.totalOrders.currentValue}`, change: `${overview.kpis.totalOrders.percentageChange}%` },
          { label: 'العملاء الفريدون', value: `${overview.kpis.uniqueCustomers.currentValue}` },
        ],
        tableHeaders,
        tableRows,
      });
    }

    // CSV format
    if (type === 'products') {
      const headers = ['المنتج', 'الوحدات المباعة', 'الإيراد الإجمالي (ر.ي)', 'عدد الطلبات', 'معدل التحويل %', 'المخزون الحالي', 'العملة'];
      const rows = overview.topProducts.map((p: any) => [
        p.productNameAr,
        p.unitsSold,
        p.grossRevenue,
        p.ordersCount,
        `${p.conversionRate}%`,
        p.currentStock,
        'YER',
      ]);
      return AnalyticsExportService.generateCsv(headers, rows);
    }

    if (type === 'inventory') {
      const headers = ['المنتج', 'المخزون الحالي', 'معدل الاستهلاك اليومي', 'أيام المخزون المتبقية', 'حالة المخزون', 'قيمة المخزون المقدرة (ر.ي)', 'العملة'];
      const rows = (overview.inventoryOverview?.items || []).map((i: any) => {
        const statusLabel = i.status === 'OUT_OF_STOCK'
          ? 'نفد المخزون'
          : i.status === 'LOW_STOCK'
          ? 'مخزون منخفض'
          : i.status === 'FAST_MOVING'
          ? 'سريع الحركة'
          : i.status === 'DEAD_STOCK'
          ? 'مخزون راكد'
          : 'طبيعي';
        return [
          i.productNameAr,
          i.currentStock,
          i.burnRateDaily || 0,
          i.estimatedDaysRemaining !== null ? i.estimatedDaysRemaining : 'غير محدد',
          statusLabel,
          i.inventoryValue || 0,
          'YER',
        ];
      });
      return AnalyticsExportService.generateCsv(headers, rows);
    }

    if (type === 'financials') {
      const commCurrent = Math.max(0, overview.kpis.grossSales.currentValue - overview.kpis.netEarnings.currentValue);
      const commPrevious = Math.max(0, overview.kpis.grossSales.previousValue - overview.kpis.netEarnings.previousValue);
      const headers = ['البند المالي', 'القيمة الحالية (ر.ي)', 'القيمة السابقة (ر.ي)', 'نسبة التغير %', 'العملة'];
      const rows = [
        ['إجمالي مبيعات البضائع (Gross Sales)', overview.kpis.grossSales.currentValue, overview.kpis.grossSales.previousValue, `${overview.kpis.grossSales.percentageChange}%`, 'YER'],
        ['صافي أرباح المتجر (Net Earnings)', overview.kpis.netEarnings.currentValue, overview.kpis.netEarnings.previousValue, `${overview.kpis.netEarnings.percentageChange}%`, 'YER'],
        ['عمولات المنصة المستقطعة المقدرة', commCurrent.toFixed(2), commPrevious.toFixed(2), `${overview.kpis.grossSales.percentageChange}%`, 'YER'],
        ['متوسط قيمة الطلب (AOV)', overview.kpis.averageOrderValue.currentValue, overview.kpis.averageOrderValue.previousValue, `${overview.kpis.averageOrderValue.percentageChange}%`, 'YER'],
        ['إجمالي عدد الطلبات', overview.kpis.totalOrders.currentValue, overview.kpis.totalOrders.previousValue, `${overview.kpis.totalOrders.percentageChange}%`, 'YER'],
        ['إجمالي الوحدات المباعة', overview.kpis.unitsSold.currentValue, overview.kpis.unitsSold.previousValue, `${overview.kpis.unitsSold.percentageChange}%`, 'YER'],
      ];
      return AnalyticsExportService.generateCsv(headers, rows);
    }

    // Default: 'sales'
    const headers = ['التاريخ', 'إجمالي المبيعات (ر.ي)', 'صافي أرباح البائع (ر.ي)', 'عدد الطلبات', 'الوحدات المباعة', 'متوسط قيمة الطلب (AOV)', 'العملة'];
    const rows = (overview.timeSeries || []).map((t: any) => [
      t.date,
      t.grossSales,
      t.netSales || Number((t.grossSales * 0.95).toFixed(2)),
      t.ordersCount || t.orders || 0,
      t.unitsSold || 0,
      t.aov || (t.ordersCount > 0 ? Number((t.grossSales / t.ordersCount).toFixed(2)) : 0),
      'YER',
    ]);

    return AnalyticsExportService.generateCsv(headers, rows);
  }
}
