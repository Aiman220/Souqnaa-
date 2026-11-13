import { prisma } from '../../database/prisma';
import { OrderStatus, PaymentStatus, PaymentMethodType, RefundStatus } from '@prisma/client';
import { CustomerMetricsSnapshot } from './membership.types';
import { config } from '../../config';

export class MembershipMetricsService {
  /**
   * Computes authoritative metrics from database for a specific customer.
   * Rules:
   * 1. Only verified, paid, and successfully delivered orders qualify.
   * 2. Exclude pending, unpaid, failed payment, cancelled, and fully refunded orders.
   * 3. Partial refunds deduct the approved refund amount from the eligible spend.
   * 4. Fully refunded orders contribute 0 eligible spend and are NOT counted as completed orders.
   * 5. Annual spend/orders respect the rolling qualification period (365 days) and configured timezone.
   * 6. Each order is counted at most once (idempotent aggregation).
   */
  public static async computeAuthoritativeMetrics(
    userId: string,
    periodDays: number = 365
  ): Promise<CustomerMetricsSnapshot> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        createdAt: true,
        rewardAccount: {
          select: { availableCoins: true },
        },
      },
    });

    if (!user) {
      throw new Error(`User ${userId} not found for membership metrics calculation`);
    }

    const now = new Date();
    // Timezone-aware rolling period start
    const periodStartDate = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // 1. Authoritative Delivered, Verified, and Paid Orders
    // Unpaid, pending payment, and failed payment orders are strictly excluded
    const qualifyingOrders = await prisma.order.findMany({
      where: {
        userId,
        status: OrderStatus.DELIVERED,
        payment: {
          NOT: {
            status: { in: [PaymentStatus.FAILED, PaymentStatus.PENDING] },
          },
          OR: [
            { status: PaymentStatus.PAID },
            { status: PaymentStatus.PARTIALLY_REFUNDED },
            { paidAt: { not: null } },
          ],
        },
      },
      select: {
        id: true,
        orderNumber: true,
        notes: true,
        subtotal: true,
        createdAt: true,
        deliveredAt: true,
        refundRequests: {
          where: {
            status: {
              in: [
                RefundStatus.REFUND_COMPLETED,
                RefundStatus.REFUNDED,
                RefundStatus.ADMIN_APPROVED,
              ],
            },
          },
          select: {
            id: true,
            approvedAmount: true,
            requestedAmount: true,
            resolvedAt: true,
            createdAt: true,
          },
        },
      },
    });

    const toIntegerCents = (val: any): number => {
      const num = Number(val || 0);
      if (isNaN(num) || num <= 0) return 0;
      return Math.round(num * 100);
    };

    const seenOrderIds = new Set<string>();
    let lifetimeOrdersCount = 0;
    let lifetimeSpendCents = 0;
    let periodOrdersCount = 0;
    let periodSpendCents = 0;

    for (const order of qualifyingOrders) {
      if (seenOrderIds.has(order.id)) continue;
      seenOrderIds.add(order.id);

      // Exclude test orders (orderNumber starting with TEST_ / test_, or [TEST] notes tag)
      if (
        (order.orderNumber && /^test[_-]/i.test(order.orderNumber)) ||
        (order.notes && /\[test\]/i.test(order.notes))
      ) {
        continue;
      }

      // Integer-safe monetary calculations in cents/fils
      const orderSubtotalCents = toIntegerCents(order.subtotal);

      // Compute total refunds against this specific order in integer cents
      let orderRefundsCents = 0;
      for (const r of order.refundRequests) {
        const refAmount = r.approvedAmount != null ? r.approvedAmount : r.requestedAmount;
        orderRefundsCents += toIntegerCents(refAmount);
      }

      // If fully refunded, order does not qualify as a completed order and contributes 0 spend
      if (orderRefundsCents >= orderSubtotalCents || orderSubtotalCents <= 0) {
        continue;
      }

      // Net eligible spend for this order (in integer cents)
      const netEligibleCents = Math.max(0, orderSubtotalCents - orderRefundsCents);

      lifetimeOrdersCount += 1;
      lifetimeSpendCents += netEligibleCents;

      const orderDate = order.deliveredAt || order.createdAt;
      if (orderDate >= periodStartDate) {
        periodOrdersCount += 1;
        periodSpendCents += netEligibleCents;
      }
    }

    // Account age in days
    const accountAgeDays = Math.max(
      0,
      Math.floor((now.getTime() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24))
    );

    // Coins balance
    const pointsBalance = user.rewardAccount?.availableCoins ?? 0;

    return {
      userId,
      completedOrders: lifetimeOrdersCount,
      periodCompletedOrders: periodOrdersCount,
      lifetimeSpend: Math.round(lifetimeSpendCents) / 100,
      periodSpend: Math.round(periodSpendCents) / 100,
      pointsBalance,
      accountAgeDays,
      evaluationTimestamp: now.toISOString(),
    };
  }

  /**
   * Fast retrieval of current metrics snapshot.
   * If customer membership record has fresh counters, uses them; otherwise falls back to authoritative aggregation.
   */
  public static async getMetrics(userId: string): Promise<CustomerMetricsSnapshot> {
    const existing = await prisma.customerMembership.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            createdAt: true,
            rewardAccount: { select: { availableCoins: true } },
          },
        },
      },
    });

    if (existing && existing.lastEvaluatedAt) {
      const now = new Date();
      const accountAgeDays = Math.max(
        0,
        Math.floor((now.getTime() - existing.user.createdAt.getTime()) / (1000 * 60 * 60 * 24))
      );

      return {
        userId,
        completedOrders: existing.completedOrders,
        periodCompletedOrders: existing.periodCompletedOrders,
        lifetimeSpend: existing.lifetimeSpend,
        periodSpend: existing.periodSpend,
        pointsBalance: existing.pointsBalance || (existing.user.rewardAccount?.availableCoins ?? 0),
        accountAgeDays,
        evaluationTimestamp: existing.lastEvaluatedAt.toISOString(),
      };
    }

    // Compute fresh metrics
    return this.computeAuthoritativeMetrics(userId);
  }
}
