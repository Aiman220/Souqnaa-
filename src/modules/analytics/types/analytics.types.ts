/**
 * SOUQNAA — Analysis & Business Intelligence Engine Types
 * Unified analytical data contracts for Seller and Admin dashboards.
 * Strictly adheres to: ONE APP, ONE COUNTRY, ONE MARKETPLACE, ONE CURRENCY (YER).
 */

export type AnalyticsPeriod =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | '90d'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom';

export type FreshnessType = 'REAL_TIME' | 'NEAR_REAL_TIME' | 'DAILY_AGGREGATED' | 'HISTORICAL';

export type TrendDirection = 'UP' | 'DOWN' | 'STABLE';

export type TrendState = 'RISING' | 'STABLE' | 'DECLINING' | 'VOLATILE';

export type AlertSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

export type CustomerSegmentType =
  | 'NEW_CUSTOMER'
  | 'RETURNING_CUSTOMER'
  | 'HIGH_VALUE'
  | 'FREQUENT_BUYER'
  | 'INACTIVE'
  | 'AT_RISK'
  | 'ONE_TIME_BUYER';

export interface DateRange {
  startDate: Date;
  endDate: Date;
  previousStartDate: Date;
  previousEndDate: Date;
  periodLabel: string;
}

export interface MetricComparison {
  currentValue: number;
  previousValue: number;
  absoluteChange: number;
  percentageChange: number;
  trend: TrendDirection;
  trendState?: TrendState;
  sampleSize?: number;
  confidence?: number;
  freshness: FreshnessType;
}

export interface TimeSeriesPoint {
  date: string;
  timestamp: string;
  grossSales: number;
  netSales: number;
  ordersCount: number;
  unitsSold: number;
  aov: number;
  commission: number;
  tax: number;
  refunds: number;
}

export interface SalesBreakdownItem {
  key: string;
  nameAr: string;
  nameEn: string;
  grossSales: number;
  discount: number;
  refund: number;
  tax: number;
  commission: number;
  fees: number;
  netSellerAmount: number;
  ordersCount: number;
  unitsSold: number;
  percentageOfTotal: number;
}

export interface ProductPerformanceScorecard {
  productId: string;
  productName: string;
  productNameAr: string;
  sku?: string;
  categoryNameAr?: string;
  currentStock: number;
  unitsSold: number;
  grossRevenue: number;
  ordersCount: number;
  aov: number;
  viewsCount: number;
  wishlistAdds: number;
  cartAdds: number;
  salesVelocity: number; // units sold / day
  revenueContributionRate: number; // % of seller/marketplace total
  orderContributionRate: number;
  conversionRate: number; // orders / views (or % where views > 0)
  refundRate: number; // refunds / orders
  stockVelocity: number; // days until out of stock
  customerRating: number;
  reviewCount: number;
  scorecardNotes: string[];
}

export interface InventoryHealthItem {
  productId: string;
  productNameAr: string;
  productNameEn: string;
  currentStock: number;
  unitsSold: number;
  averageDailySales: number;
  estimatedDaysRemaining: number;
  stockTurnover: number;
  status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'FAST_MOVING' | 'SLOW_MOVING' | 'DEAD_STOCK';
  lastSaleDate: Date | null;
  lastRestockDate: Date | null;
  warnings: string[];
}

export interface OrderLifecycleAnalytics {
  totalOrders: number;
  pendingCount: number;
  confirmedCount: number;
  processingCount: number;
  readyToShipCount: number;
  shippedCount: number;
  deliveredCount: number;
  cancelledCount: number;
  returnedCount: number;
  refundedCount: number;
  completionRate: number;
  cancellationRate: number;
  refundRate: number;
  aov: number;
  averageFulfillmentHours: number; // confirmed to shipped
  averageDeliveryHours: number; // shipped to delivered
}

export interface CustomerAnalyticsSummary {
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  repeatPurchaseRate: number;
  averageCustomerSpend: number;
  ordersPerCustomer: number;
  clvProxy: number;
  segments: {
    segment: CustomerSegmentType;
    labelAr: string;
    labelEn: string;
    customerCount: number;
    totalSpend: number;
    percentage: number;
  }[];
  cohortRetentionProxy: {
    cohortMonth: string;
    cohortSize: number;
    month1Retention: number;
    month2Retention: number;
    month3Retention: number;
  }[];
}

export interface PromotionAnalyticsItem {
  id: string;
  name: string;
  type: 'COUPON' | 'FLASH_SALE' | 'CAMPAIGN' | 'SELLER_PROMOTION' | 'FREE_DELIVERY';
  status: string;
  usageCount: number;
  ordersGenerated: number;
  revenueGenerated: number;
  discountCost: number;
  commissionImpact: number;
  aov: number;
  conversionRate: number;
  refundRate: number;
  observedChangePercentage: number;
  comparisonNote: string;
}

export interface ExplainableInsight {
  id: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  category: 'SALES' | 'INVENTORY' | 'CUSTOMER' | 'PROMOTION' | 'PERFORMANCE';
  metric: string;
  source: string;
  calculation: string;
  comparisonPeriod: string;
  confidenceScore: number;
  actionableRecommendationAr?: string;
  actionableRecommendationEn?: string;
  generatedAt: string;
}

export interface AnomalyReport {
  id: string;
  alertType: string;
  metric: string;
  severity: AlertSeverity;
  threshold: number;
  observedValue: number;
  comparisonValue: number;
  differencePercentage: number;
  titleAr: string;
  titleEn: string;
  explanationAr: string;
  explanationEn: string;
  detectedAt: string;
  status: AlertStatus;
}

export interface AnalyticalRecommendation {
  type:
    | 'RESTOCK_RECOMMENDATION'
    | 'PRICE_REVIEW_RECOMMENDATION'
    | 'PROMOTION_REVIEW'
    | 'LOW_CONVERSION_PRODUCT'
    | 'HIGH_REFUND_PRODUCT'
    | 'CUSTOMER_RETENTION_OPPORTUNITY';
  titleAr: string;
  titleEn: string;
  reasonAr: string;
  reasonEn: string;
  actionAr: string;
  actionEn: string;
  targetId?: string;
  targetName?: string;
  metrics: Record<string, number | string>;
}

export interface ForecastResult {
  metric: string;
  forecastPeriod: string;
  historicalPeriod: string;
  method: 'MOVING_AVERAGE' | 'LINEAR_TREND_EXTRAPOLATION';
  predictedValue: number;
  lowerBound: number;
  upperBound: number;
  confidenceScore: number;
  disclaimerAr: string;
  disclaimerEn: string;
  generatedAt: string;
}

export interface SellerOverviewKPIs {
  grossSales: MetricComparison;
  netSales: MetricComparison;
  totalOrders: MetricComparison;
  completedOrders: MetricComparison;
  cancelledOrders: MetricComparison;
  refundedOrders: MetricComparison;
  averageOrderValue: MetricComparison;
  unitsSold: MetricComparison;
  uniqueCustomers: MetricComparison;
  repeatCustomers: MetricComparison;
  commissionAmount: MetricComparison;
  netEarnings: MetricComparison;
  pendingSettlement: MetricComparison;
  completedSettlement: MetricComparison;
  refundAmount: MetricComparison;
  taxAmount: MetricComparison;
  currency: string;
  freshness: FreshnessType;
  generatedAt: string;
}

export interface AdminOverviewKPIs {
  gmv: MetricComparison;
  netSales: MetricComparison;
  totalOrders: MetricComparison;
  completedOrders: MetricComparison;
  cancelledOrders: MetricComparison;
  refundAmount: MetricComparison;
  activeSellersCount: MetricComparison;
  activeProductsCount: MetricComparison;
  activeCustomersCount: MetricComparison;
  aov: MetricComparison;
  marketplaceCommission: MetricComparison;
  settlementVolume: MetricComparison;
  taxVolume: MetricComparison;
  currency: string;
  freshness: FreshnessType;
  generatedAt: string;
}
