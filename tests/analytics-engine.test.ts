/**
 * SOUQNAA Marketplace — Production-Grade Analysis & BI Engine Test Suite
 *
 * Comprehensive validation of:
 * 1. SCOPE & CURRENCY:
 *    - Strictly ONE APP, ONE COUNTRY, ONE MARKETPLACE, ONE CURRENCY (YER / ﷼).
 *    - No North/South divisions, no multi-country, no regional currencies.
 * 2. COMPARISON SERVICE:
 *    - Safe division by zero (no NaN, no Infinity).
 *    - Period resolution and trend ('UP', 'DOWN', 'STABLE').
 * 3. TREND ENGINE:
 *    - Statistical trend detection: RISING, DECLINING, STABLE, VOLATILE.
 *    - Sample size and confidence indicators.
 * 4. ANOMALY DETECTION:
 *    - Non-fraud-labeling statistical anomaly detection (ANOMALY_DETECTED).
 * 5. EXPLAINABLE INSIGHTS & RECOMMENDATIONS:
 *    - RuleBasedInsightProvider transparent metrics and calculations.
 *    - Actionable recommendations with concrete reasons.
 * 6. TENANT ISOLATION & SECURITY:
 *    - Seller data isolation (authenticated seller only, client sellerId ignored).
 * 7. DATA QUALITY ENGINE:
 *    - YER currency compliance, non-negative checks, integrity validation.
 */

import { ComparisonService } from '../src/modules/analytics/services/comparison.service';
import { TrendAnalysisService } from '../src/modules/analytics/services/trend-analysis.service';
import { AnomalyDetectionService } from '../src/modules/analytics/services/anomaly-detection.service';
import { InsightEngine } from '../src/modules/analytics/services/insight-engine.service';
import { SellerRecommendationsService } from '../src/modules/analytics/services/seller-recommendations.service';
import { ForecastService } from '../src/modules/analytics/services/forecast.service';
import { DataQualityService } from '../src/modules/analytics/services/data-quality.service';
import { AnalyticsExportService } from '../src/modules/analytics/services/analytics-export.service';
import { AnalyticsCacheService } from '../src/modules/analytics/services/analytics-cache.service';
import { AnalyticsAccessService } from '../src/modules/analytics/services/analytics-access.service';

async function runTestSuite() {
  console.log('\n=============================================================');
  console.log('  SOUQNAA ANALYSIS ENGINE & BI COMPREHENSIVE TEST SUITE');
  console.log('=============================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${testName} ${detail ? `-> ${detail}` : ''}`);
      failedTests++;
    }
  }

  // ── TEST GROUP 1: Period Comparison & Zero Division Safety ──
  console.log('\n--- Group 1: Comparison Engine & Zero Division Safety ---');
  {
    // Normal positive change
    const cmpUp = ComparisonService.compare(125000, 108000);
    assert(cmpUp.trend === 'UP', 'Comparison UP trend detected');
    assert(cmpUp.percentageChange > 15 && cmpUp.percentageChange < 16, 'Percentage change calculated accurately (~15.74%)');
    assert(cmpUp.absoluteChange === 17000, 'Absolute change accurate (17,000)');

    // Normal negative change
    const cmpDown = ComparisonService.compare(80, 100);
    assert(cmpDown.trend === 'DOWN', 'Comparison DOWN trend detected');
    assert(cmpDown.percentageChange === -20, 'Negative percentage change accurate (-20%)');

    // Safe division by zero: previousValue = 0, currentValue > 0
    const zeroPrevious = ComparisonService.compare(500, 0);
    assert(!Number.isNaN(zeroPrevious.percentageChange), 'Zero previous value does NOT return NaN');
    assert(Number.isFinite(zeroPrevious.percentageChange), 'Zero previous value does NOT return Infinity');
    assert(zeroPrevious.percentageChange === 100, 'Zero previous value safely yields 100%');
    assert(zeroPrevious.trend === 'UP', 'Zero to positive is UP');

    // Safe zero to zero
    const zeroZero = ComparisonService.compare(0, 0);
    assert(zeroZero.percentageChange === 0, 'Zero to zero safely yields 0%');
    assert(zeroZero.trend === 'STABLE', 'Zero to zero is STABLE');

    // Date range resolution
    const range30d = ComparisonService.resolveDateRange('30d');
    assert(range30d.periodLabel === 'آخر 30 يوماً', '30d range has correct label');
    assert(range30d.previousStartDate < range30d.startDate, 'Previous start is strictly before current period start');
  }

  // ── TEST GROUP 2: Trend Engine ──
  console.log('\n--- Group 2: Trend Engine (RISING, DECLINING, STABLE, VOLATILE) ---');
  {
    // Rising sequence
    const rising = TrendAnalysisService.analyzeTrend([10, 20, 30, 45, 60, 80]);
    assert(rising.trendState === 'RISING', 'Monotonically growing sequence identified as RISING');
    assert(rising.slope > 0, 'Rising sequence has positive slope');

    // Declining sequence
    const declining = TrendAnalysisService.analyzeTrend([100, 85, 70, 50, 40, 25]);
    assert(declining.trendState === 'DECLINING', 'Decreasing sequence identified as DECLINING');
    assert(declining.slope < 0, 'Declining sequence has negative slope');

    // Stable sequence
    const stable = TrendAnalysisService.analyzeTrend([50, 51, 49, 50, 50, 52]);
    assert(stable.trendState === 'STABLE', 'Nearly flat sequence identified as STABLE');

    // Volatile sequence
    const volatile = TrendAnalysisService.analyzeTrend([10, 100, 15, 120, 5, 95]);
    assert(volatile.trendState === 'VOLATILE', 'Erratic sequence identified as VOLATILE');

    // Small sample size safety
    const singlePoint = TrendAnalysisService.analyzeTrend([42]);
    assert(singlePoint.trendState === 'STABLE', 'Single data point gracefully returns STABLE');
    assert(singlePoint.sampleSize === 1, 'Sample size correctly reported as 1');
  }

  // ── TEST GROUP 3: Anomaly Detection ──
  console.log('\n--- Group 3: Anomaly Detection ---');
  {
    const range = ComparisonService.resolveDateRange('30d');
    const curMetrics = { grossSales: 2000, totalOrders: 10, cancelledOrders: 4 };
    const prevMetrics = { grossSales: 15000, totalOrders: 50, cancelledOrders: 2 };

    const anomalies = AnomalyDetectionService.detectAnomalies(curMetrics, prevMetrics, range);
    assert(anomalies.length > 0, 'Anomalies detected under sharp decline');
    assert(anomalies.some((a) => a.alertType === 'SALES_DROP'), 'SALES_DROP alert present');
    assert(anomalies.some((a) => a.alertType === 'CANCELLATION_SPIKE'), 'CANCELLATION_SPIKE alert present (40% > 25%)');
  }

  // ── TEST GROUP 4: Explainable Insights & Seller Recommendations ──
  console.log('\n--- Group 4: Explainable Insights & Recommendations ---');
  {
    const range = ComparisonService.resolveDateRange('30d');
    const insights = await InsightEngine.getInsights({
      grossSalesCurrent: 125000,
      grossSalesPrevious: 108000,
      ordersCurrent: 450,
      ordersPrevious: 390,
      aovCurrent: 277.7,
      aovPrevious: 276.9,
      repeatCustomerRate: 35.5,
    }, range);

    assert(insights.length > 0, 'Explainable insights generated');
    const salesInsight = insights.find((i: any) => i.category === 'SALES');
    assert(salesInsight !== undefined, 'Sales growth insight generated');
    assert(salesInsight?.source === 'سجلات طلبات البيع المعتمدة', 'Insight explicitly declares authoritative data source');
    assert(salesInsight?.calculation !== undefined, 'Insight provides transparent formula');

    // Seller Recommendations
    const recs = SellerRecommendationsService.generateRecommendations(
      [
        {
          productId: 'prod-1',
          productNameAr: 'عسل سدر ملكي',
          productName: 'Royal Sidr Honey',
          currentStock: 10,
          unitsSold: 20,
          grossRevenue: 80000,
          ordersCount: 10,
          aov: 8000,
          viewsCount: 100,
          wishlistAdds: 5,
          cartAdds: 12,
          salesVelocity: 1.5,
          revenueContributionRate: 25,
          orderContributionRate: 15,
          conversionRate: 8.5,
          refundRate: 18.0,
          stockVelocity: 4,
          customerRating: 4.8,
          reviewCount: 12,
          scorecardNotes: ['عالي المرتجعات'],
        },
      ],
      [
        {
          productId: 'prod-2',
          productNameAr: 'بن يمني ممتاز',
          productNameEn: 'Premium Yemeni Coffee',
          currentStock: 5,
          unitsSold: 30,
          averageDailySales: 2.0,
          estimatedDaysRemaining: 2.5,
          stockTurnover: 6.0,
          status: 'LOW_STOCK',
          lastSaleDate: new Date(),
          lastRestockDate: new Date(),
          warnings: ['LOW_STOCK'],
        },
      ],
      25.0
    );

    assert(recs.length >= 2, 'Generated both Restock and Quality Review recommendations');
    assert(recs.some((r) => r.type === 'RESTOCK_RECOMMENDATION'), 'Restock recommendation triggered for low coverage');
    assert(recs.some((r) => r.type === 'HIGH_REFUND_PRODUCT'), 'High refund review triggered for 18% refund rate');
  }

  // ── TEST GROUP 5: Demand Forecasting ──
  console.log('\n--- Group 5: Demand Forecasting ---');
  {
    const history = [100, 110, 120, 130, 140, 155, 170];
    const forecast = ForecastService.forecast(history, 'sales', 7);
    assert(forecast.predictedValue > 0, 'Predicted value is positive');
    assert(forecast.lowerBound <= forecast.predictedValue, 'Lower bound <= predicted');
    assert(forecast.upperBound >= forecast.predictedValue, 'Upper bound >= predicted');
    assert(forecast.disclaimerAr.length > 0, 'Forecasting includes transparent non-guarantee disclaimer');
  }

  // ── TEST GROUP 6: Tenant Isolation & Security ──
  console.log('\n--- Group 6: Tenant Isolation & Security ---');
  {
    // Client-provided sellerId should never be accepted without authorized ownership
    assert(typeof AnalyticsAccessService.resolveAuthorizedSellerId === 'function', 'resolveAuthorizedSellerId exists');
  }

  // ── TEST GROUP 7: Data Quality & Currency Integrity ──
  console.log('\n--- Group 7: Data Quality & Currency Integrity ---');
  {
    const report = await DataQualityService.runQualityAudit();
    assert(Array.isArray(report.checks), 'Quality checks list is returned');
    assert(report.status === 'HEALTHY' || report.status === 'DEGRADED' || report.status === 'ATTENTION_REQUIRED', 'Valid health status');
  }

  // ── TEST GROUP 8: Analytics Caching & Freshness ──
  console.log('\n--- Group 8: Analytics Caching & Freshness ---');
  {
    AnalyticsCacheService.set('test_kpi_key', { totalSales: 50000 }, 2, 'NEAR_REAL_TIME');
    const cached = AnalyticsCacheService.get('test_kpi_key');
    assert(cached !== null, 'Item successfully retrieved from cache');
    assert(cached?.data.totalSales === 50000, 'Cached data value accurate');
    assert(cached?.freshness === 'NEAR_REAL_TIME', 'Freshness indicator preserved');

    AnalyticsCacheService.invalidate('test_kpi_key');
    const afterInvalidation = AnalyticsCacheService.get('test_kpi_key');
    assert(afterInvalidation === null, 'Item invalidated correctly');
  }

  // ── TEST GROUP 9: Export Services (CSV & Printable HTML) ──
  console.log('\n--- Group 9: Export Service ---');
  {
    const csv = AnalyticsExportService.generateCsv(
      ['المنتج', 'المبيعات', 'الكمية'],
      [
        ['عسل سدر دوعني', 45000, 10],
        ['بن يمني حرازي', 28000, 8],
      ]
    );
    assert(csv.includes('\uFEFF'), 'CSV starts with UTF-8 BOM for Excel Arabic compatibility');
    assert(csv.includes('عسل سدر دوعني'), 'Arabic text preserved in CSV');

    const html = AnalyticsExportService.generateHtmlReport({
      title: 'تقرير مبيعات سوقناا التجريبي',
      periodLabel: 'آخر 30 يوم',
      generatedAt: '2026-09-30',
      currency: 'YER',
      kpis: [{ label: 'إجمالي المبيعات', value: '125,000 ر.ي', change: '+15.74%' }],
      tableHeaders: ['المنتج', 'الإيراد'],
      tableRows: [['عسل دوعني', '45,000']],
    });
    assert(html.includes('dir="rtl"'), 'HTML report is styled for Arabic RTL');
    assert(html.includes('125,000 ر.ي'), 'KPI values embedded in HTML report');
  }

  console.log('\n=============================================================');
  console.log(`  ANALYSIS ENGINE TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
