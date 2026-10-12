import { prisma } from '../../../database/prisma';
import { DateRange, CustomerAnalyticsSummary, CustomerSegmentType } from '../types/analytics.types';

export class CustomerAnalyticsService {
  /**
   * Generates privacy-preserving customer metrics, segments, and retention cohort analysis.
   * Strictly enforces seller isolation: only customers who ordered from this seller are counted.
   */
  public static async getCustomerAnalytics(
    range: DateRange,
    sellerId?: string,
    highValueThreshold: number = 50000,
    frequentOrderThreshold: number = 3
  ): Promise<CustomerAnalyticsSummary> {
    const whereSellerOrder: any = {};
    if (sellerId) {
      whereSellerOrder.sellerId = sellerId;
    }

    // Retrieve all historical orders for this seller (to compute lifetime segments & repeat rate)
    const allSellerOrders = await prisma.sellerOrder.findMany({
      where: whereSellerOrder,
      select: {
        id: true,
        subtotal: true,
        createdAt: true,
        order: {
          select: {
            userId: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group customer activity
    const customerLifetimeMap = new Map<string, {
      firstOrderDate: Date;
      lastOrderDate: Date;
      totalSpend: number;
      ordersCount: number;
      periodOrdersCount: number;
      periodSpend: number;
    }>();

    for (const o of (allSellerOrders as any[])) {
      const cId = o.order?.userId;
      if (!cId) continue;

      const orderDate = o.createdAt;
      const spend = o.subtotal || 0;
      const inPeriod = orderDate >= range.startDate && orderDate <= range.endDate;

      const cur = customerLifetimeMap.get(cId) || {
        firstOrderDate: orderDate,
        lastOrderDate: orderDate,
        totalSpend: 0,
        ordersCount: 0,
        periodOrdersCount: 0,
        periodSpend: 0,
      };

      if (orderDate < cur.firstOrderDate) cur.firstOrderDate = orderDate;
      if (orderDate > cur.lastOrderDate) cur.lastOrderDate = orderDate;
      cur.totalSpend += spend;
      cur.ordersCount += 1;

      if (inPeriod) {
        cur.periodOrdersCount += 1;
        cur.periodSpend += spend;
      }

      customerLifetimeMap.set(cId, cur);
    }

    // Active customers in the requested period
    const activeInPeriod = Array.from(customerLifetimeMap.entries()).filter(
      ([, data]) => data.periodOrdersCount > 0
    );

    const uniqueCustomers = activeInPeriod.length;
    let newCustomers = 0;
    let returningCustomers = 0;
    let totalPeriodSpend = 0;
    let totalPeriodOrders = 0;

    for (const [, data] of activeInPeriod) {
      totalPeriodSpend += data.periodSpend;
      totalPeriodOrders += data.periodOrdersCount;

      if (data.firstOrderDate >= range.startDate && data.firstOrderDate <= range.endDate) {
        newCustomers++;
      } else {
        returningCustomers++;
      }
    }

    const repeatPurchaseRate = uniqueCustomers > 0 ? Number(((returningCustomers / uniqueCustomers) * 100).toFixed(2)) : 0;
    const averageCustomerSpend = uniqueCustomers > 0 ? Number((totalPeriodSpend / uniqueCustomers).toFixed(2)) : 0;
    const ordersPerCustomer = uniqueCustomers > 0 ? Number((totalPeriodOrders / uniqueCustomers).toFixed(2)) : 0;

    // Lifetime Value (CLV) proxy
    const allCustomers = Array.from(customerLifetimeMap.values());
    const totalLifetimeSpend = allCustomers.reduce((s, c) => s + c.totalSpend, 0);
    const clvProxy = allCustomers.length > 0 ? Number((totalLifetimeSpend / allCustomers.length).toFixed(2)) : 0;

    // Categorize into segments
    const segmentCounts: Record<CustomerSegmentType, { count: number; spend: number }> = {
      NEW_CUSTOMER: { count: 0, spend: 0 },
      RETURNING_CUSTOMER: { count: 0, spend: 0 },
      HIGH_VALUE: { count: 0, spend: 0 },
      FREQUENT_BUYER: { count: 0, spend: 0 },
      INACTIVE: { count: 0, spend: 0 },
      AT_RISK: { count: 0, spend: 0 },
      ONE_TIME_BUYER: { count: 0, spend: 0 },
    };

    const now = new Date();
    for (const [, data] of customerLifetimeMap.entries()) {
      const daysSinceLast = (now.getTime() - data.lastOrderDate.getTime()) / (1000 * 3600 * 24);

      if (data.totalSpend >= highValueThreshold) {
        segmentCounts.HIGH_VALUE.count++;
        segmentCounts.HIGH_VALUE.spend += data.totalSpend;
      }
      if (data.ordersCount >= frequentOrderThreshold) {
        segmentCounts.FREQUENT_BUYER.count++;
        segmentCounts.FREQUENT_BUYER.spend += data.totalSpend;
      }
      if (data.ordersCount === 1) {
        segmentCounts.ONE_TIME_BUYER.count++;
        segmentCounts.ONE_TIME_BUYER.spend += data.totalSpend;
      }
      if (daysSinceLast > 60) {
        segmentCounts.INACTIVE.count++;
        segmentCounts.INACTIVE.spend += data.totalSpend;
      } else if (daysSinceLast > 35 && data.ordersCount > 1) {
        segmentCounts.AT_RISK.count++;
        segmentCounts.AT_RISK.spend += data.totalSpend;
      }
      if (data.firstOrderDate >= range.startDate) {
        segmentCounts.NEW_CUSTOMER.count++;
        segmentCounts.NEW_CUSTOMER.spend += data.periodSpend;
      } else if (data.periodOrdersCount > 0) {
        segmentCounts.RETURNING_CUSTOMER.count++;
        segmentCounts.RETURNING_CUSTOMER.spend += data.periodSpend;
      }
    }

    const totalTrackedCustomers = Math.max(1, customerLifetimeMap.size);
    const segments = [
      {
        segment: 'NEW_CUSTOMER' as CustomerSegmentType,
        labelAr: 'عملاء جدد',
        labelEn: 'New Customers',
        customerCount: segmentCounts.NEW_CUSTOMER.count,
        totalSpend: Number(segmentCounts.NEW_CUSTOMER.spend.toFixed(2)),
        percentage: Number(((segmentCounts.NEW_CUSTOMER.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'RETURNING_CUSTOMER' as CustomerSegmentType,
        labelAr: 'عملاء عائدون متكررون',
        labelEn: 'Returning Customers',
        customerCount: segmentCounts.RETURNING_CUSTOMER.count,
        totalSpend: Number(segmentCounts.RETURNING_CUSTOMER.spend.toFixed(2)),
        percentage: Number(((segmentCounts.RETURNING_CUSTOMER.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'HIGH_VALUE' as CustomerSegmentType,
        labelAr: 'عملاء كبار القيمة (High Value)',
        labelEn: 'High Value Customers',
        customerCount: segmentCounts.HIGH_VALUE.count,
        totalSpend: Number(segmentCounts.HIGH_VALUE.spend.toFixed(2)),
        percentage: Number(((segmentCounts.HIGH_VALUE.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'FREQUENT_BUYER' as CustomerSegmentType,
        labelAr: 'مشترون متكررون بكثافة',
        labelEn: 'Frequent Buyers',
        customerCount: segmentCounts.FREQUENT_BUYER.count,
        totalSpend: Number(segmentCounts.FREQUENT_BUYER.spend.toFixed(2)),
        percentage: Number(((segmentCounts.FREQUENT_BUYER.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'ONE_TIME_BUYER' as CustomerSegmentType,
        labelAr: 'مشترون لمرة واحدة',
        labelEn: 'One-Time Buyers',
        customerCount: segmentCounts.ONE_TIME_BUYER.count,
        totalSpend: Number(segmentCounts.ONE_TIME_BUYER.spend.toFixed(2)),
        percentage: Number(((segmentCounts.ONE_TIME_BUYER.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'AT_RISK' as CustomerSegmentType,
        labelAr: 'عملاء معرضون للانسحاب (At Risk)',
        labelEn: 'At-Risk Customers',
        customerCount: segmentCounts.AT_RISK.count,
        totalSpend: Number(segmentCounts.AT_RISK.spend.toFixed(2)),
        percentage: Number(((segmentCounts.AT_RISK.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
      {
        segment: 'INACTIVE' as CustomerSegmentType,
        labelAr: 'عملاء غير نشطين (>60 يوماً)',
        labelEn: 'Inactive Customers',
        customerCount: segmentCounts.INACTIVE.count,
        totalSpend: Number(segmentCounts.INACTIVE.spend.toFixed(2)),
        percentage: Number(((segmentCounts.INACTIVE.count / totalTrackedCustomers) * 100).toFixed(1)),
      },
    ];

    // Cohort analysis proxy by first-purchase month
    const cohortMap = new Map<string, { cohortSize: number; m1: number; m2: number; m3: number }>();
    for (const [, c] of customerLifetimeMap.entries()) {
      const cohortMonth = c.firstOrderDate.toISOString().substring(0, 7); // YYYY-MM
      const cur = cohortMap.get(cohortMonth) || { cohortSize: 0, m1: 0, m2: 0, m3: 0 };
      cur.cohortSize++;

      const diffMonths = (c.lastOrderDate.getFullYear() - c.firstOrderDate.getFullYear()) * 12 +
        (c.lastOrderDate.getMonth() - c.firstOrderDate.getMonth());

      if (diffMonths >= 1) cur.m1++;
      if (diffMonths >= 2) cur.m2++;
      if (diffMonths >= 3) cur.m3++;

      cohortMap.set(cohortMonth, cur);
    }

    const cohortRetentionProxy = Array.from(cohortMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6)
      .map(([cohortMonth, d]) => ({
        cohortMonth,
        cohortSize: d.cohortSize,
        month1Retention: d.cohortSize > 0 ? Number(((d.m1 / d.cohortSize) * 100).toFixed(1)) : 0,
        month2Retention: d.cohortSize > 0 ? Number(((d.m2 / d.cohortSize) * 100).toFixed(1)) : 0,
        month3Retention: d.cohortSize > 0 ? Number(((d.m3 / d.cohortSize) * 100).toFixed(1)) : 0,
      }));

    return {
      uniqueCustomers,
      newCustomers,
      returningCustomers,
      repeatPurchaseRate,
      averageCustomerSpend,
      ordersPerCustomer,
      clvProxy,
      segments,
      cohortRetentionProxy,
    };
  }
}
