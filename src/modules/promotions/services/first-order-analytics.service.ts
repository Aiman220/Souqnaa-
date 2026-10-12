/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Analytics & Admin Reporting Service
 * Version: 1.0.0
 */

import { prisma } from '../../../database/prisma';
import { FirstOrderShippingConfigService } from './first-order-shipping-config.service';
import { AdminFirstOrderDashboardMetrics } from '../first-order-shipping.types';
import { TaxMath } from '../../tax/tax.math';

export class FirstOrderAnalyticsService {
  /**
   * Generates high-performance aggregated metrics for the First-Order Free Shipping Admin Dashboard.
   * Utilizes indexed SQL aggregations to ensure low latency.
   */
  public static async getDashboardMetrics(): Promise<AdminFirstOrderDashboardMetrics> {
    const config = await FirstOrderShippingConfigService.getConfig();

    const [
      usagesStats,
      reservationsByStatus,
      abuseEventsCount,
      costBearerStats,
    ] = await Promise.all([
      // 1. Usages financial totals & order averages
      prisma.promotionUsage.aggregate({
        where: {
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status: 'CONSUMED',
        },
        _count: { id: true },
        _sum: {
          discountAmount: true,
          platformSubsidy: true,
          sellerContribution: true,
          sellerDeliveryReimbursement: true,
        },
      }),

      // 2. Reservations counts grouped by status
      prisma.promotionReservation.groupBy({
        by: ['status'],
        where: { promotionType: 'FIRST_ORDER_FREE_SHIPPING' },
        _count: { id: true },
      }),

      // 3. Abuse events count
      prisma.promotionEligibilityAudit.count({
        where: {
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status: 'ACCOUNT_RESTRICTED',
        },
      }),

      // 4. Cost Bearer distribution
      prisma.promotionUsage.groupBy({
        by: ['costBearer'],
        where: {
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status: 'CONSUMED',
        },
        _count: { id: true },
      }),
    ]);

    const totalOrders = usagesStats._count?.id || 0;
    const totalDiscount = usagesStats._sum?.discountAmount || 0;
    const totalSubsidy = usagesStats._sum?.platformSubsidy || 0;
    const totalContribution = usagesStats._sum?.sellerContribution || 0;
    const totalReimbursement = usagesStats._sum?.sellerDeliveryReimbursement || 0;

    // Average order value calculation using Order relation
    let averageOrderValue = 0;
    if (totalOrders > 0) {
      const orderSubtotals = await prisma.order.aggregate({
        where: {
          promotionUsages: {
            some: {
              promotionType: 'FIRST_ORDER_FREE_SHIPPING',
              status: 'CONSUMED',
            },
          },
        },
        _avg: { subtotal: true },
      });
      averageOrderValue = TaxMath.round(orderSubtotals._avg.subtotal || 0);
    }

    const averageShippingDiscount = totalOrders > 0 ? TaxMath.round(totalDiscount / totalOrders) : 0;

    // Reservation counts mapping
    const resMap: Record<string, number> = {};
    let totalReservations = 0;
    for (const r of reservationsByStatus) {
      const cnt = (r._count as any)?.id || 0;
      resMap[r.status] = cnt;
      totalReservations += cnt;
    }

    const consumedRes = resMap['CONSUMED'] || 0;
    const activeRes = resMap['RESERVED'] || 0;
    const releasedRes = resMap['RELEASED'] || 0;
    const expiredRes = resMap['EXPIRED'] || 0;

    const conversionRate = totalReservations > 0
      ? TaxMath.round((consumedRes / totalReservations) * 100)
      : 0;

    // Cancellation & Refund rates for orders using this promotion
    let cancelledOrdersCount = 0;
    let refundedOrdersCount = 0;
    if (totalOrders > 0) {
      const orders = await prisma.order.findMany({
        where: {
          promotionUsages: {
            some: {
              promotionType: 'FIRST_ORDER_FREE_SHIPPING',
              status: 'CONSUMED',
            },
          },
        },
        select: {
          status: true,
          refundRequests: { where: { status: 'REFUND_COMPLETED' }, select: { id: true } },
        },
      });

      cancelledOrdersCount = orders.filter((o) =>
        ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'CANCELLED_BY_ADMIN', 'REJECTED_BY_SELLER'].includes(o.status)
      ).length;

      refundedOrdersCount = orders.filter((o) => o.refundRequests.length > 0).length;
    }

    const cancellationRate = totalOrders > 0
      ? TaxMath.round((cancelledOrdersCount / totalOrders) * 100)
      : 0;
    const refundRate = totalOrders > 0
      ? TaxMath.round((refundedOrdersCount / totalOrders) * 100)
      : 0;

    // Remaining budget calculation
    const remainingBudget = config.platformBudget !== null
      ? Math.max(0, config.platformBudget - config.consumedBudget)
      : null;
    const budgetUtilization = config.platformBudget !== null && config.platformBudget > 0
      ? TaxMath.round((config.consumedBudget / config.platformBudget) * 100)
      : 0;

    // Cost Bearer breakdown
    const cbMap: Record<string, number> = { PLATFORM: 0, SELLER: 0, SHARED: 0 };
    for (const cb of costBearerStats) {
      cbMap[cb.costBearer] = (cb._count as any)?.id || 0;
    }

    return {
      campaignActive: config.enabled,
      campaignBudget: config.platformBudget,
      consumedBudget: config.consumedBudget,
      remainingBudget,
      budgetUtilizationPercentage: budgetUtilization,
      totalOrdersUsingPromotion: totalOrders,
      totalShippingDiscount: TaxMath.round(totalDiscount),
      totalPlatformSubsidy: TaxMath.round(totalSubsidy),
      totalSellerContribution: TaxMath.round(totalContribution),
      totalSellerReimbursement: TaxMath.round(totalReimbursement),
      averageOrderValue,
      averageShippingDiscount,
      conversionRate,
      cancellationRate,
      refundRate,
      totalReservationsCount: totalReservations,
      activeReservationsCount: activeRes,
      consumedReservationsCount: consumedRes,
      releasedReservationsCount: releasedRes,
      expiredReservationsCount: expiredRes,
      abuseEventsDetectedCount: abuseEventsCount,
      costBearerBreakdown: {
        platform: cbMap['PLATFORM'] || 0,
        seller: cbMap['SELLER'] || 0,
        shared: cbMap['SHARED'] || 0,
      },
    };
  }
}
