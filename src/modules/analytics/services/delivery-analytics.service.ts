import { prisma } from '../../../database/prisma';
import { DateRange } from '../types/analytics.types';

export interface DeliveryAnalyticsReport {
  totalDeliveries: number;
  deliveryCompletionRate: number;
  totalDeliveryFees: number;
  averageDeliveryFee: number;
  byMethod: {
    method: string;
    labelAr: string;
    ordersCount: number;
    totalFee: number;
    percentage: number;
  }[];
}

export class DeliveryAnalyticsService {
  /**
   * Analyzes delivery methods, fees, and fulfillment performance using authoritative order data.
   */
  public static async getDeliveryAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<DeliveryAnalyticsReport> {
    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: range.startDate, lte: range.endDate },
        ...(sellerId ? { sellerOrders: { some: { sellerId } } } : {}),
      },
      select: {
        deliveryFee: true,
        deliveryMethodId: true,
        status: true,
      },
    });

    const totalDeliveries = orders.length;
    let completedCount = 0;
    let totalDeliveryFees = 0;

    const methodMap = new Map<string, { count: number; fee: number }>();

    for (const o of orders) {
      const fee = o.deliveryFee || 0;
      totalDeliveryFees += fee;
      if (o.status === 'DELIVERED') completedCount++;

      const methodKey = o.deliveryMethodId || 'STANDARD';
      const cur = methodMap.get(methodKey) || { count: 0, fee: 0 };
      cur.count++;
      cur.fee += fee;
      methodMap.set(methodKey, cur);
    }

    const deliveryCompletionRate =
      totalDeliveries > 0 ? Number(((completedCount / totalDeliveries) * 100).toFixed(1)) : 0;
    const averageDeliveryFee =
      totalDeliveries > 0 ? Number((totalDeliveryFees / totalDeliveries).toFixed(2)) : 0;

    const methodNamesAr: Record<string, string> = {
      STANDARD: 'توصيل قياسي موثوق',
      EXPRESS: 'توصيل سريع فوري',
      SCHEDULED: 'توصيل مجدول بوقت محدد',
      FREE_CAMPAIGN: 'توصيل مجاني ضمن حملة',
    };

    const byMethod = Array.from(methodMap.entries()).map(([method, d]) => ({
      method,
      labelAr: methodNamesAr[method] || method,
      ordersCount: d.count,
      totalFee: Number(d.fee.toFixed(2)),
      percentage: totalDeliveries > 0 ? Number(((d.count / totalDeliveries) * 100).toFixed(1)) : 0,
    })).sort((a, b) => b.ordersCount - a.ordersCount);

    return {
      totalDeliveries,
      deliveryCompletionRate,
      totalDeliveryFees: Number(totalDeliveryFees.toFixed(2)),
      averageDeliveryFee,
      byMethod,
    };
  }
}
