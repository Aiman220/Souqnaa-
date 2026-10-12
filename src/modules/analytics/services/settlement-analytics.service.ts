import { prisma } from '../../../database/prisma';
import { DateRange } from '../types/analytics.types';

export interface SettlementAnalyticsReport {
  pendingCount: number;
  pendingVolume: number;
  processingCount: number;
  processingVolume: number;
  completedCount: number;
  completedVolume: number;
  failedCount: number;
  failedVolume: number;
  totalSettlementValue: number;
  recentSettlements: {
    id: string;
    settlementNumber: string;
    sellerId: string;
    sellerName?: string;
    status: string;
    netPayout: number;
    periodStart: Date;
    periodEnd: Date;
    createdAt: Date;
  }[];
  authoritativeSource: 'SETTLEMENT_ENGINE';
}

export class SettlementAnalyticsService {
  /**
   * Consumes authoritative Settlement Engine records without modifying status.
   */
  public static async getSettlementAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<SettlementAnalyticsReport> {
    const where: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    const settlements = await prisma.settlement.findMany({
      where,
      include: {
        seller: {
          select: {
            stores: { select: { name: true } },
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let pendingCount = 0;
    let pendingVolume = 0;
    let processingCount = 0;
    let processingVolume = 0;
    let completedCount = 0;
    let completedVolume = 0;
    let failedCount = 0;
    let failedVolume = 0;
    let totalSettlementValue = 0;

    for (const s of settlements) {
      const payout = s.netSettlementAmount || 0;
      totalSettlementValue += payout;
      const st = String(s.status);

      if (st === 'PENDING') {
        pendingCount++;
        pendingVolume += payout;
      } else if (st === 'PROCESSING') {
        processingCount++;
        processingVolume += payout;
      } else if (st === 'COMPLETED' || st === 'PAID') {
        completedCount++;
        completedVolume += payout;
      } else if (st === 'FAILED' || st === 'REJECTED') {
        failedCount++;
        failedVolume += payout;
      }
    }

    const recentSettlements = settlements.slice(0, 15).map((s) => ({
      id: s.id,
      settlementNumber: s.settlementNumber,
      sellerId: s.sellerId,
      sellerName:
        s.seller?.stores?.[0]?.name ||
        `${s.seller?.user?.firstName || ''} ${s.seller?.user?.lastName || ''}`.trim() ||
        'تاجر',
      status: s.status,
      netPayout: Number((s.netSettlementAmount || 0).toFixed(2)),
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      createdAt: s.createdAt,
    }));

    return {
      pendingCount,
      pendingVolume: Number(pendingVolume.toFixed(2)),
      processingCount,
      processingVolume: Number(processingVolume.toFixed(2)),
      completedCount,
      completedVolume: Number(completedVolume.toFixed(2)),
      failedCount,
      failedVolume: Number(failedVolume.toFixed(2)),
      totalSettlementValue: Number(totalSettlementValue.toFixed(2)),
      recentSettlements,
      authoritativeSource: 'SETTLEMENT_ENGINE',
    };
  }
}
