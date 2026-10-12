import { prisma } from '../../../database/prisma';
import { DateRange } from '../types/analytics.types';

export interface SellerPerformanceRow {
  sellerId: string;
  storeName: string;
  ownerName: string;
  grossSales: number;
  totalOrders: number;
  unitsSold: number;
  aov: number;
  cancellationRate: number;
  refundRate: number;
  customerRating: number;
  fulfillmentRate: number;
  commissionGenerated: number;
  settlementVolume: number;
}

export class PerformanceAnalyticsService {
  /**
   * Generates a fully transparent, explainable seller performance leaderboard for Admin.
   */
  public static async getSellerLeaderboard(
    range: DateRange,
    sortBy:
      | 'sales'
      | 'orders'
      | 'units'
      | 'aov'
      | 'cancellationRate'
      | 'refundRate'
      | 'rating'
      | 'commission'
      | 'settlement' = 'sales',
    limit: number = 50
  ): Promise<SellerPerformanceRow[]> {
    const sellers = await prisma.seller.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        user: { select: { firstName: true, lastName: true } },
        stores: { select: { name: true, rating: true } },
      },
    });

    const sellerOrders = await prisma.sellerOrder.findMany({
      where: {
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      select: {
        sellerId: true,
        status: true,
        subtotal: true,
        commissionAmount: true,
        items: { select: { quantity: true } },
      },
    });

    const settlements = await prisma.settlement.findMany({
      where: {
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      select: { sellerId: true, netSettlementAmount: true },
    });

    const refunds = await prisma.refundRequest.findMany({
      where: {
        status: 'REFUNDED' as any,
        resolvedAt: { gte: range.startDate, lte: range.endDate },
      },
      select: { sellerId: true },
    });

    const refundCounts = new Map<string, number>();
    for (const r of refunds) {
      if (r.sellerId) refundCounts.set(r.sellerId, (refundCounts.get(r.sellerId) || 0) + 1);
    }

    const settlementVolumeMap = new Map<string, number>();
    for (const s of settlements) {
      settlementVolumeMap.set(s.sellerId, (settlementVolumeMap.get(s.sellerId) || 0) + (s.netSettlementAmount || 0));
    }

    const sellerAggMap = new Map<string, {
      grossSales: number;
      orders: number;
      units: number;
      commission: number;
      delivered: number;
      cancelled: number;
    }>();

    for (const so of sellerOrders) {
      const cur = sellerAggMap.get(so.sellerId) || {
        grossSales: 0,
        orders: 0,
        units: 0,
        commission: 0,
        delivered: 0,
        cancelled: 0,
      };

      cur.grossSales += so.subtotal || 0;
      cur.orders += 1;
      cur.commission += so.commissionAmount || 0;
      cur.units += so.items.reduce((s, it) => s + (it.quantity || 0), 0);

      const st = String(so.status);
      if (st === 'DELIVERED') cur.delivered++;
      if (st.includes('CANCEL') || st.includes('REJECT')) cur.cancelled++;

      sellerAggMap.set(so.sellerId, cur);
    }

    const rows: SellerPerformanceRow[] = [];

    for (const s of sellers) {
      const stats = sellerAggMap.get(s.id) || {
        grossSales: 0,
        orders: 0,
        units: 0,
        commission: 0,
        delivered: 0,
        cancelled: 0,
      };

      const grossSales = stats.grossSales;
      const totalOrders = stats.orders;
      const unitsSold = stats.units;
      const aov = totalOrders > 0 ? grossSales / totalOrders : 0;
      const cancellationRate = totalOrders > 0 ? Number(((stats.cancelled / totalOrders) * 100).toFixed(1)) : 0;
      const refundCount = refundCounts.get(s.id) || 0;
      const refundRate = totalOrders > 0 ? Number(((refundCount / totalOrders) * 100).toFixed(1)) : 0;
      const fulfillmentRate = totalOrders > 0 ? Number(((stats.delivered / totalOrders) * 100).toFixed(1)) : 0;
      const customerRating = s.stores?.[0]?.rating || 5.0;
      const settlementVolume = settlementVolumeMap.get(s.id) || 0;

      const storeName = s.stores?.[0]?.name || 'متجر غير معنون';
      const ownerName = `${s.user?.firstName || ''} ${s.user?.lastName || ''}`.trim() || 'تاجر';

      rows.push({
        sellerId: s.id,
        storeName,
        ownerName,
        grossSales: Number(grossSales.toFixed(2)),
        totalOrders,
        unitsSold,
        aov: Number(aov.toFixed(2)),
        cancellationRate,
        refundRate,
        customerRating,
        fulfillmentRate,
        commissionGenerated: Number(stats.commission.toFixed(2)),
        settlementVolume: Number(settlementVolume.toFixed(2)),
      });
    }

    rows.sort((a, b) => {
      switch (sortBy) {
        case 'orders':
          return b.totalOrders - a.totalOrders;
        case 'units':
          return b.unitsSold - a.unitsSold;
        case 'aov':
          return b.aov - a.aov;
        case 'cancellationRate':
          return b.cancellationRate - a.cancellationRate;
        case 'refundRate':
          return b.refundRate - a.refundRate;
        case 'rating':
          return b.customerRating - a.customerRating;
        case 'commission':
          return b.commissionGenerated - a.commissionGenerated;
        case 'settlement':
          return b.settlementVolume - a.settlementVolume;
        case 'sales':
        default:
          return b.grossSales - a.grossSales;
      }
    });

    return rows.slice(0, limit);
  }
}
