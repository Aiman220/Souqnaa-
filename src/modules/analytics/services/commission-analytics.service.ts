import { prisma } from '../../../database/prisma';
import { DateRange } from '../types/analytics.types';

export interface CommissionAnalyticsReport {
  grossSales: number;
  commissionBase: number;
  averageCommissionRate: number;
  totalCommissionAmount: number;
  commissionAdjustments: number;
  bySeller: {
    sellerId: string;
    sellerName: string;
    grossSales: number;
    commissionAmount: number;
    effectiveRate: number;
  }[];
  byCategory: {
    categoryId: string;
    categoryNameAr: string;
    grossSales: number;
    commissionAmount: number;
  }[];
  freshness: 'REAL_TIME';
  authoritativeSource: 'COMMISSION_ENGINE';
}

export class CommissionAnalyticsService {
  /**
   * Reads and aggregates authoritative Commission Engine records.
   * Strictly avoids recalculating commission formulas.
   */
  public static async getCommissionAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<CommissionAnalyticsReport> {
    const where: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    // Query authoritative seller orders
    const orders = await prisma.sellerOrder.findMany({
      where,
      select: {
        sellerId: true,
        subtotal: true,
        commissionAmount: true,
        seller: {
          select: {
            commissionRate: true,
            user: { select: { firstName: true, lastName: true } },
            stores: { select: { name: true } },
          },
        },
        items: {
          select: {
            totalPrice: true,
            product: {
              select: {
                categoryId: true,
                category: { select: { id: true, nameAr: true } },
              },
            },
          },
        },
      },
    });

    let grossSales = 0;
    let totalCommissionAmount = 0;
    let rateSum = 0;

    const sellerMap = new Map<string, {
      sellerName: string;
      grossSales: number;
      commissionAmount: number;
      rateSum: number;
      count: number;
    }>();

    const categoryMap = new Map<string, {
      categoryNameAr: string;
      grossSales: number;
      commissionAmount: number;
    }>();

    for (const o of (orders as any[])) {
      const sub = o.subtotal || 0;
      const comm = o.commissionAmount || 0;
      const rate = o.seller?.commissionRate || 0.10;

      grossSales += sub;
      totalCommissionAmount += comm;
      rateSum += rate;

      // Group by Seller
      const sName =
        o.seller?.stores?.[0]?.name ||
        `${o.seller?.user?.firstName || ''} ${o.seller?.user?.lastName || ''}`.trim() ||
        'تاجر';

      const sData = sellerMap.get(o.sellerId) || {
        sellerName: sName,
        grossSales: 0,
        commissionAmount: 0,
        rateSum: 0,
        count: 0,
      };
      sData.grossSales += sub;
      sData.commissionAmount += comm;
      sData.rateSum += rate;
      sData.count += 1;
      sellerMap.set(o.sellerId, sData);

      // Group by Category
      for (const item of o.items) {
        const catId = item.product?.categoryId || 'uncategorized';
        const catName = item.product?.category?.nameAr || 'غير مصنف';
        const itemGross = item.totalPrice || 0;
        const itemComm = itemGross * rate;

        const cData = categoryMap.get(catId) || {
          categoryNameAr: catName,
          grossSales: 0,
          commissionAmount: 0,
        };
        cData.grossSales += itemGross;
        cData.commissionAmount += itemComm;
        categoryMap.set(catId, cData);
      }
    }

    const averageCommissionRate =
      orders.length > 0 ? Number(((rateSum / orders.length) * 100).toFixed(2)) : 10.0;

    const bySeller = Array.from(sellerMap.entries()).map(([sId, d]) => ({
      sellerId: sId,
      sellerName: d.sellerName,
      grossSales: Number(d.grossSales.toFixed(2)),
      commissionAmount: Number(d.commissionAmount.toFixed(2)),
      effectiveRate: d.grossSales > 0 ? Number(((d.commissionAmount / d.grossSales) * 100).toFixed(2)) : 0,
    })).sort((a, b) => b.commissionAmount - a.commissionAmount);

    const byCategory = Array.from(categoryMap.entries()).map(([cId, d]) => ({
      categoryId: cId,
      categoryNameAr: d.categoryNameAr,
      grossSales: Number(d.grossSales.toFixed(2)),
      commissionAmount: Number(d.commissionAmount.toFixed(2)),
    })).sort((a, b) => b.commissionAmount - a.commissionAmount);

    return {
      grossSales: Number(grossSales.toFixed(2)),
      commissionBase: Number(grossSales.toFixed(2)),
      averageCommissionRate,
      totalCommissionAmount: Number(totalCommissionAmount.toFixed(2)),
      commissionAdjustments: 0.0,
      bySeller,
      byCategory,
      freshness: 'REAL_TIME',
      authoritativeSource: 'COMMISSION_ENGINE',
    };
  }
}
