import { prisma } from '../../../database/prisma';
import { ComparisonService } from './comparison.service';
import { TrendAnalysisService } from './trend-analysis.service';
import {
  DateRange,
  SellerOverviewKPIs,
  AdminOverviewKPIs,
} from '../types/analytics.types';
import { OrderStatus, SellerOrderStatus } from '@prisma/client';

export class KPIService {
  /**
   * Builds the comprehensive Seller KPI Overview with authoritative data and period comparison.
   */
  public static async getSellerKPIOverview(
    sellerId: string,
    range: DateRange
  ): Promise<SellerOverviewKPIs> {
    // Current period aggregations
    const [currentOrders, prevOrders, currentItems, prevItems, pendingSettlements, completedSettlements] =
      await Promise.all([
        prisma.sellerOrder.findMany({
          where: {
            sellerId,
            createdAt: { gte: range.startDate, lte: range.endDate },
          },
          select: {
            id: true,
            status: true,
            subtotal: true,
            commissionAmount: true,
            taxAmount: true,
            sellerPayout: true,
            order: { select: { userId: true } },
          },
        }),
        prisma.sellerOrder.findMany({
          where: {
            sellerId,
            createdAt: { gte: range.previousStartDate, lte: range.previousEndDate },
          },
          select: {
            id: true,
            status: true,
            subtotal: true,
            commissionAmount: true,
            taxAmount: true,
            sellerPayout: true,
            order: { select: { userId: true } },
          },
        }),
        prisma.orderItem.aggregate({
          where: {
            sellerOrder: {
              sellerId,
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
          },
          _sum: { quantity: true },
        }),
        prisma.orderItem.aggregate({
          where: {
            sellerOrder: {
              sellerId,
              createdAt: { gte: range.previousStartDate, lte: range.previousEndDate },
            },
          },
          _sum: { quantity: true },
        }),
        prisma.settlement.aggregate({
          where: {
            sellerId,
            status: { in: ['PENDING' as any, 'PROCESSING' as any] },
          },
          _sum: { netSettlementAmount: true },
        }),
        prisma.settlement.aggregate({
          where: {
            sellerId,
            status: 'COMPLETED' as any,
          },
          _sum: { netSettlementAmount: true },
        }),
      ]);

    // Current metrics computation
    const curTotalOrders = currentOrders.length;
    const curGrossSales = currentOrders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
    const curNetEarnings = currentOrders.reduce((sum, o) => sum + (o.sellerPayout || 0), 0);
    const curCommission = currentOrders.reduce((sum, o) => sum + (o.commissionAmount || 0), 0);
    const curTax = currentOrders.reduce((sum, o) => sum + (o.taxAmount || 0), 0);
    const curCompleted = currentOrders.filter((o) => o.status === SellerOrderStatus.DELIVERED).length;
    const curCancelled = currentOrders.filter(
      (o) =>
        o.status === SellerOrderStatus.CANCELLED_BY_CUSTOMER ||
        o.status === SellerOrderStatus.CANCELLED_BY_SELLER ||
        o.status === SellerOrderStatus.REJECTED_BY_SELLER ||
        o.status === SellerOrderStatus.CANCELLED_BY_ADMIN
    ).length;
    const curRefunded = currentOrders.filter(
      (o) => o.status === SellerOrderStatus.REFUNDED || o.status === SellerOrderStatus.RETURNED
    ).length;
    const curAov = curTotalOrders > 0 ? curGrossSales / curTotalOrders : 0;
    const curUnits = currentItems._sum.quantity || 0;

    // Distinct customer counts
    const curCustomerMap = new Map<string, number>();
    for (const o of currentOrders) {
      const cId = (o as any).order?.userId;
      if (cId) curCustomerMap.set(cId, (curCustomerMap.get(cId) || 0) + 1);
    }
    const curUniqueCustomers = curCustomerMap.size;
    const curRepeatCustomers = Array.from(curCustomerMap.values()).filter((c) => c > 1).length;

    // Previous metrics computation
    const prevTotalOrders = prevOrders.length;
    const prevGrossSales = prevOrders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
    const prevNetEarnings = prevOrders.reduce((sum, o) => sum + (o.sellerPayout || 0), 0);
    const prevCommission = prevOrders.reduce((sum, o) => sum + (o.commissionAmount || 0), 0);
    const prevTax = prevOrders.reduce((sum, o) => sum + (o.taxAmount || 0), 0);
    const prevCompleted = prevOrders.filter((o) => o.status === SellerOrderStatus.DELIVERED).length;
    const prevCancelled = prevOrders.filter(
      (o) =>
        o.status === SellerOrderStatus.CANCELLED_BY_CUSTOMER ||
        o.status === SellerOrderStatus.CANCELLED_BY_SELLER ||
        o.status === SellerOrderStatus.REJECTED_BY_SELLER ||
        o.status === SellerOrderStatus.CANCELLED_BY_ADMIN
    ).length;
    const prevRefunded = prevOrders.filter(
      (o) => o.status === SellerOrderStatus.REFUNDED || o.status === SellerOrderStatus.RETURNED
    ).length;
    const prevAov = prevTotalOrders > 0 ? prevGrossSales / prevTotalOrders : 0;
    const prevUnits = prevItems._sum.quantity || 0;

    const prevCustomerMap = new Map<string, number>();
    for (const o of prevOrders) {
      const cId = (o as any).order?.userId;
      if (cId) prevCustomerMap.set(cId, (prevCustomerMap.get(cId) || 0) + 1);
    }
    const prevUniqueCustomers = prevCustomerMap.size;
    const prevRepeatCustomers = Array.from(prevCustomerMap.values()).filter((c) => c > 1).length;

    // Authoritative refund amount from RefundRequest
    const [curRefundAgg, prevRefundAgg] = await Promise.all([
      prisma.refundRequest.aggregate({
        where: {
          sellerId,
          status: 'REFUNDED' as any,
          resolvedAt: { gte: range.startDate, lte: range.endDate },
        },
        _sum: { approvedAmount: true },
      }),
      prisma.refundRequest.aggregate({
        where: {
          sellerId,
          status: 'REFUNDED' as any,
          resolvedAt: { gte: range.previousStartDate, lte: range.previousEndDate },
        },
        _sum: { approvedAmount: true },
      }),
    ]);

    const curRefundAmount = curRefundAgg._sum.approvedAmount || 0;
    const prevRefundAmount = prevRefundAgg._sum.approvedAmount || 0;
    const curNetSales = Math.max(0, curGrossSales - curRefundAmount);
    const prevNetSales = Math.max(0, prevGrossSales - prevRefundAmount);

    return {
      grossSales: ComparisonService.compare(curGrossSales, prevGrossSales, 'REAL_TIME', curTotalOrders),
      netSales: ComparisonService.compare(curNetSales, prevNetSales, 'REAL_TIME', curTotalOrders),
      totalOrders: ComparisonService.compare(curTotalOrders, prevTotalOrders, 'REAL_TIME', curTotalOrders),
      completedOrders: ComparisonService.compare(curCompleted, prevCompleted, 'REAL_TIME', curCompleted),
      cancelledOrders: ComparisonService.compare(curCancelled, prevCancelled, 'REAL_TIME', curCancelled),
      refundedOrders: ComparisonService.compare(curRefunded, prevRefunded, 'REAL_TIME', curRefunded),
      averageOrderValue: ComparisonService.compare(curAov, prevAov, 'REAL_TIME', curTotalOrders),
      unitsSold: ComparisonService.compare(curUnits, prevUnits, 'REAL_TIME', curUnits),
      uniqueCustomers: ComparisonService.compare(curUniqueCustomers, prevUniqueCustomers, 'REAL_TIME', curUniqueCustomers),
      repeatCustomers: ComparisonService.compare(curRepeatCustomers, prevRepeatCustomers, 'REAL_TIME', curRepeatCustomers),
      commissionAmount: ComparisonService.compare(curCommission, prevCommission, 'REAL_TIME', curTotalOrders),
      netEarnings: ComparisonService.compare(curNetEarnings, prevNetEarnings, 'REAL_TIME', curTotalOrders),
      pendingSettlement: ComparisonService.compare(
        pendingSettlements._sum.netSettlementAmount || 0,
        pendingSettlements._sum.netSettlementAmount || 0,
        'REAL_TIME'
      ),
      completedSettlement: ComparisonService.compare(
        completedSettlements._sum.netSettlementAmount || 0,
        completedSettlements._sum.netSettlementAmount || 0,
        'REAL_TIME'
      ),
      refundAmount: ComparisonService.compare(curRefundAmount, prevRefundAmount, 'REAL_TIME', curRefunded),
      taxAmount: ComparisonService.compare(curTax, prevTax, 'REAL_TIME', curTotalOrders),
      currency: 'YER',
      freshness: 'REAL_TIME',
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Builds the Marketplace Admin KPI Overview consuming authoritative records across the platform.
   */
  public static async getAdminKPIOverview(range: DateRange): Promise<AdminOverviewKPIs> {
    const [
      curOrdersAgg,
      prevOrdersAgg,
      curCompletedOrders,
      prevCompletedOrders,
      curCancelledOrders,
      prevCancelledOrders,
      curRefundAgg,
      prevRefundAgg,
      curSellersCount,
      prevSellersCount,
      activeProductsCount,
      curCustomersCount,
      prevCustomersCount,
      curCommissionAgg,
      prevCommissionAgg,
      curSettlementAgg,
      prevSettlementAgg,
      curTaxAgg,
      prevTaxAgg,
    ] = await Promise.all([
      prisma.order.aggregate({
        where: { createdAt: { gte: range.startDate, lte: range.endDate } },
        _sum: { total: true, subtotal: true, taxAmount: true },
        _count: { id: true },
        _avg: { total: true },
      }),
      prisma.order.aggregate({
        where: { createdAt: { gte: range.previousStartDate, lte: range.previousEndDate } },
        _sum: { total: true, subtotal: true, taxAmount: true },
        _count: { id: true },
        _avg: { total: true },
      }),
      prisma.order.count({
        where: {
          status: OrderStatus.DELIVERED,
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
      }),
      prisma.order.count({
        where: {
          status: OrderStatus.DELIVERED,
          createdAt: { gte: range.previousStartDate, lte: range.previousEndDate },
        },
      }),
      prisma.order.count({
        where: {
          status: {
            in: [
              OrderStatus.CANCELLED_BY_CUSTOMER,
              OrderStatus.CANCELLED_BY_SELLER,
              OrderStatus.REJECTED_BY_SELLER,
              OrderStatus.CANCELLED_BY_ADMIN,
            ],
          },
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
      }),
      prisma.order.count({
        where: {
          status: {
            in: [
              OrderStatus.CANCELLED_BY_CUSTOMER,
              OrderStatus.CANCELLED_BY_SELLER,
              OrderStatus.REJECTED_BY_SELLER,
              OrderStatus.CANCELLED_BY_ADMIN,
            ],
          },
          createdAt: { gte: range.previousStartDate, lte: range.previousEndDate },
        },
      }),
      prisma.refundRequest.aggregate({
        where: {
          status: 'REFUNDED' as any,
          resolvedAt: { gte: range.startDate, lte: range.endDate },
        },
        _sum: { approvedAmount: true },
      }),
      prisma.refundRequest.aggregate({
        where: {
          status: 'REFUNDED' as any,
          resolvedAt: { gte: range.previousStartDate, lte: range.previousEndDate },
        },
        _sum: { approvedAmount: true },
      }),
      prisma.seller.count({ where: { status: 'ACTIVE' } }),
      prisma.seller.count({ where: { status: 'ACTIVE', createdAt: { lte: range.previousEndDate } } }),
      prisma.product.count({ where: { isActive: true } }),
      prisma.customer.count({ where: { createdAt: { gte: range.startDate, lte: range.endDate } } }),
      prisma.customer.count({ where: { createdAt: { gte: range.previousStartDate, lte: range.previousEndDate } } }),
      prisma.sellerOrder.aggregate({
        where: { createdAt: { gte: range.startDate, lte: range.endDate } },
        _sum: { commissionAmount: true },
      }),
      prisma.sellerOrder.aggregate({
        where: { createdAt: { gte: range.previousStartDate, lte: range.previousEndDate } },
        _sum: { commissionAmount: true },
      }),
      prisma.settlement.aggregate({
        where: { createdAt: { gte: range.startDate, lte: range.endDate } },
        _sum: { netSettlementAmount: true },
      }),
      prisma.settlement.aggregate({
        where: { createdAt: { gte: range.previousStartDate, lte: range.previousEndDate } },
        _sum: { netSettlementAmount: true },
      }),
      prisma.order.aggregate({
        where: { createdAt: { gte: range.startDate, lte: range.endDate } },
        _sum: { taxAmount: true },
      }),
      prisma.order.aggregate({
        where: { createdAt: { gte: range.previousStartDate, lte: range.previousEndDate } },
        _sum: { taxAmount: true },
      }),
    ]);

    const curGmv = curOrdersAgg._sum.total || 0;
    const prevGmv = prevOrdersAgg._sum.total || 0;
    const curRefund = curRefundAgg._sum.approvedAmount || 0;
    const prevRefund = prevRefundAgg._sum.approvedAmount || 0;
    const curNetSales = Math.max(0, curGmv - curRefund);
    const prevNetSales = Math.max(0, prevGmv - prevRefund);

    const curOrdersCount = curOrdersAgg._count.id || 0;
    const prevOrdersCount = prevOrdersAgg._count.id || 0;
    const curAov = curOrdersAgg._avg.total || 0;
    const prevAov = prevOrdersAgg._avg.total || 0;

    return {
      gmv: ComparisonService.compare(curGmv, prevGmv, 'REAL_TIME', curOrdersCount),
      netSales: ComparisonService.compare(curNetSales, prevNetSales, 'REAL_TIME', curOrdersCount),
      totalOrders: ComparisonService.compare(curOrdersCount, prevOrdersCount, 'REAL_TIME', curOrdersCount),
      completedOrders: ComparisonService.compare(curCompletedOrders, prevCompletedOrders, 'REAL_TIME', curCompletedOrders),
      cancelledOrders: ComparisonService.compare(curCancelledOrders, prevCancelledOrders, 'REAL_TIME', curCancelledOrders),
      refundAmount: ComparisonService.compare(curRefund, prevRefund, 'REAL_TIME'),
      activeSellersCount: ComparisonService.compare(curSellersCount, prevSellersCount, 'NEAR_REAL_TIME', curSellersCount),
      activeProductsCount: ComparisonService.compare(activeProductsCount, activeProductsCount, 'NEAR_REAL_TIME', activeProductsCount),
      activeCustomersCount: ComparisonService.compare(curCustomersCount, prevCustomersCount, 'NEAR_REAL_TIME', curCustomersCount),
      aov: ComparisonService.compare(curAov, prevAov, 'REAL_TIME', curOrdersCount),
      marketplaceCommission: ComparisonService.compare(
        curCommissionAgg._sum.commissionAmount || 0,
        prevCommissionAgg._sum.commissionAmount || 0,
        'REAL_TIME',
        curOrdersCount
      ),
      settlementVolume: ComparisonService.compare(
        curSettlementAgg._sum.netSettlementAmount || 0,
        prevSettlementAgg._sum.netSettlementAmount || 0,
        'REAL_TIME'
      ),
      taxVolume: ComparisonService.compare(
        curTaxAgg._sum.taxAmount || 0,
        prevTaxAgg._sum.taxAmount || 0,
        'REAL_TIME',
        curOrdersCount
      ),
      currency: 'YER',
      freshness: 'REAL_TIME',
      generatedAt: new Date().toISOString(),
    };
  }
}
