import { prisma } from '../../database/prisma';
import { OrderStatus, RefundStatus } from '@prisma/client';
import { CustomerMetricsSnapshot } from './membership.types';

export class MembershipMetricsService {
  /**
   * Computes authoritative metrics from database for a specific customer.
   * Based on:
   * 1. Delivered orders (qualifying orders).
   * 2. Net qualifying spend: Total Delivered subtotal - Approved refunds.
   * 3. Account age in days.
   * 4. Current Coins/points balance.
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
    const periodStartDate = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // 1. Authoritative Delivered Orders
    const allDeliveredOrders = await prisma.order.findMany({
      where: {
        userId,
        status: OrderStatus.DELIVERED,
      },
      select: {
        id: true,
        subtotal: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    const lifetimeOrdersCount = allDeliveredOrders.length;
    let lifetimeSpendGross = 0;
    let periodOrdersCount = 0;
    let periodSpendGross = 0;

    for (const order of allDeliveredOrders) {
      const orderSubtotal = Number(order.subtotal || 0);
      lifetimeSpendGross += orderSubtotal;

      const orderDate = order.deliveredAt || order.createdAt;
      if (orderDate >= periodStartDate) {
        periodOrdersCount += 1;
        periodSpendGross += orderSubtotal;
      }
    }

    // 2. Authoritative Completed / Approved Refunds to deduct from spend
    const completedRefunds = await prisma.refundRequest.findMany({
      where: {
        customerId: userId,
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
    });

    let lifetimeRefundsTotal = 0;
    let periodRefundsTotal = 0;

    for (const refund of completedRefunds) {
      const amount = Number(refund.approvedAmount || refund.requestedAmount || 0);
      lifetimeRefundsTotal += amount;

      const refundDate = refund.resolvedAt || refund.createdAt;
      if (refundDate >= periodStartDate) {
        periodRefundsTotal += amount;
      }
    }

    // Net qualifying spend (gross spend minus refunds, floored at 0)
    const lifetimeSpend = Math.max(0, lifetimeSpendGross - lifetimeRefundsTotal);
    const periodSpend = Math.max(0, periodSpendGross - periodRefundsTotal);

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
      lifetimeSpend: Math.round(lifetimeSpend * 100) / 100,
      periodSpend: Math.round(periodSpend * 100) / 100,
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
