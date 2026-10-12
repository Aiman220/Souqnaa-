import { prisma } from '../../../database/prisma';
import { DateRange, OrderLifecycleAnalytics } from '../types/analytics.types';
import { SellerOrderStatus } from '@prisma/client';

export class OrderAnalyticsService {
  /**
   * Calculates comprehensive order lifecycle analytics and fulfillment performance.
   */
  public static async getOrderLifecycleAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<OrderLifecycleAnalytics> {
    const where: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    const orders = await prisma.sellerOrder.findMany({
      where,
      select: {
        id: true,
        status: true,
        subtotal: true,
        createdAt: true,
        orderId: true,
        order: {
          select: {
            statusHistory: {
              select: { status: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    const totalOrders = orders.length;
    let pendingCount = 0;
    let confirmedCount = 0;
    let processingCount = 0;
    let readyToShipCount = 0;
    let shippedCount = 0;
    let deliveredCount = 0;
    let cancelledCount = 0;
    let returnedCount = 0;
    let refundedCount = 0;

    let totalGross = 0;
    let fulfillmentHoursSum = 0;
    let fulfillmentCount = 0;
    let deliveryHoursSum = 0;
    let deliveryCount = 0;

    for (const o of orders) {
      totalGross += o.subtotal || 0;
      switch (o.status) {
        case SellerOrderStatus.PENDING:
          pendingCount++;
          break;
        case SellerOrderStatus.CONFIRMED:
          confirmedCount++;
          break;
        case SellerOrderStatus.PROCESSING:
          processingCount++;
          break;
        case SellerOrderStatus.READY_TO_SHIP:
          readyToShipCount++;
          break;
        case SellerOrderStatus.SHIPPED:
          shippedCount++;
          break;
        case SellerOrderStatus.DELIVERED:
          deliveredCount++;
          break;
        case SellerOrderStatus.CANCELLED_BY_CUSTOMER:
        case SellerOrderStatus.CANCELLED_BY_SELLER:
        case SellerOrderStatus.REJECTED_BY_SELLER:
        case SellerOrderStatus.CANCELLED_BY_ADMIN:
          cancelledCount++;
          break;
        case SellerOrderStatus.RETURNED:
          returnedCount++;
          break;
        case SellerOrderStatus.REFUNDED:
          refundedCount++;
          break;
        default:
          break;
      }

      // Calculate fulfillment time (CONFIRMED -> SHIPPED) and delivery time (SHIPPED -> DELIVERED)
      const history = o.order?.statusHistory || [];
      const confirmedEv = history.find((h) => h.status === 'CONFIRMED');
      const shippedEv = history.find((h) => h.status === 'SHIPPED');
      const deliveredEv = history.find((h) => h.status === 'DELIVERED');

      if (confirmedEv && shippedEv) {
        const diffHours = (shippedEv.createdAt.getTime() - confirmedEv.createdAt.getTime()) / (1000 * 3600);
        if (diffHours >= 0 && diffHours < 720) {
          fulfillmentHoursSum += diffHours;
          fulfillmentCount++;
        }
      }

      if (shippedEv && deliveredEv) {
        const diffHours = (deliveredEv.createdAt.getTime() - shippedEv.createdAt.getTime()) / (1000 * 3600);
        if (diffHours >= 0 && diffHours < 720) {
          deliveryHoursSum += diffHours;
          deliveryCount++;
        }
      }
    }

    const completionRate = totalOrders > 0 ? Number(((deliveredCount / totalOrders) * 100).toFixed(2)) : 0;
    const cancellationRate = totalOrders > 0 ? Number(((cancelledCount / totalOrders) * 100).toFixed(2)) : 0;
    const refundRate = totalOrders > 0 ? Number((((refundedCount + returnedCount) / totalOrders) * 100).toFixed(2)) : 0;
    const aov = totalOrders > 0 ? Number((totalGross / totalOrders).toFixed(2)) : 0;
    const averageFulfillmentHours = fulfillmentCount > 0 ? Number((fulfillmentHoursSum / fulfillmentCount).toFixed(1)) : 0;
    const averageDeliveryHours = deliveryCount > 0 ? Number((deliveryHoursSum / deliveryCount).toFixed(1)) : 0;

    return {
      totalOrders,
      pendingCount,
      confirmedCount,
      processingCount,
      readyToShipCount,
      shippedCount,
      deliveredCount,
      cancelledCount,
      returnedCount,
      refundedCount,
      completionRate,
      cancellationRate,
      refundRate,
      aov,
      averageFulfillmentHours,
      averageDeliveryHours,
    };
  }
}
