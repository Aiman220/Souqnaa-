/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Authoritative Budget & Usage Engine
 * Version: 2.0.0
 */

import { prisma } from '../../../database/prisma';
import { Prisma } from '@prisma/client';

export class ShippingPromotionBudgetService {
  /**
   * Atomically reserves budget for a promotion.
   * Throws if remaining budget is insufficient.
   */
  public static async reserveBudget(
    tx: Prisma.TransactionClient,
    params: {
      promotionId: string;
      amount: number;
      reservationId?: string;
      orderId?: string;
    }
  ): Promise<void> {
    const { promotionId, amount, reservationId, orderId } = params;
    if (amount <= 0) return;

    // Fetch promotion with lock
    const promo = await tx.shippingPromotion.findUnique({
      where: { id: promotionId },
    });

    if (!promo) {
      throw new Error(`Shipping promotion ${promotionId} not found`);
    }

    if (promo.remainingBudget !== null && promo.remainingBudget < amount) {
      throw new Error(
        `Insufficient promotion budget: required ${amount}, remaining ${promo.remainingBudget}`
      );
    }

    const newConsumed = promo.consumedBudget + amount;
    const newRemaining =
      promo.remainingBudget !== null ? Math.max(0, promo.remainingBudget - amount) : null;

    await tx.shippingPromotion.update({
      where: { id: promotionId },
      data: {
        consumedBudget: newConsumed,
        remainingBudget: newRemaining,
        status: newRemaining === 0 ? 'EXHAUSTED' : promo.status,
      },
    });

    // Record budget transaction audit
    await tx.shippingPromotionBudgetTransaction.create({
      data: {
        promotionId,
        orderId,
        reservationId,
        amount,
        type: 'RESERVATION',
        balanceBefore: promo.remainingBudget ?? promo.consumedBudget,
        balanceAfter: newRemaining ?? newConsumed,
        reference: reservationId ? `Res:${reservationId}` : undefined,
      },
    });
  }

  /**
   * Releases previously reserved budget (e.g. on checkout failure or reservation expiration).
   */
  public static async releaseBudget(
    tx: Prisma.TransactionClient,
    params: {
      promotionId: string;
      amount: number;
      reservationId?: string;
      reason?: string;
    }
  ): Promise<void> {
    const { promotionId, amount, reservationId, reason } = params;
    if (amount <= 0) return;

    const promo = await tx.shippingPromotion.findUnique({
      where: { id: promotionId },
    });

    if (!promo) return;

    const newConsumed = Math.max(0, promo.consumedBudget - amount);
    const newRemaining =
      promo.remainingBudget !== null ? promo.remainingBudget + amount : null;

    const newStatus =
      promo.status === 'EXHAUSTED' && (newRemaining === null || newRemaining > 0)
        ? 'ACTIVE'
        : promo.status;

    await tx.shippingPromotion.update({
      where: { id: promotionId },
      data: {
        consumedBudget: newConsumed,
        remainingBudget: newRemaining,
        status: newStatus,
      },
    });

    await tx.shippingPromotionBudgetTransaction.create({
      data: {
        promotionId,
        reservationId,
        amount,
        type: 'RELEASE',
        balanceBefore: promo.remainingBudget ?? promo.consumedBudget,
        balanceAfter: newRemaining ?? newConsumed,
        reference: reason || 'Reservation release',
      },
    });
  }

  /**
   * Increments promotion usage count on consumption.
   */
  public static async incrementUsage(
    tx: Prisma.TransactionClient,
    params: {
      promotionId: string;
      amount: number;
      orderId: string;
      reservationId?: string;
    }
  ): Promise<void> {
    const { promotionId, amount, orderId, reservationId } = params;

    const promo = await tx.shippingPromotion.findUnique({
      where: { id: promotionId },
    });

    if (!promo) return;

    const newCount = promo.currentUsageCount + 1;
    const isExhausted =
      promo.globalUsageLimit !== null && newCount >= promo.globalUsageLimit;

    await tx.shippingPromotion.update({
      where: { id: promotionId },
      data: {
        currentUsageCount: newCount,
        status: isExhausted ? 'EXHAUSTED' : promo.status,
      },
    });

    await tx.shippingPromotionBudgetTransaction.create({
      data: {
        promotionId,
        orderId,
        reservationId,
        amount,
        type: 'CONSUMPTION',
        balanceBefore: promo.remainingBudget ?? promo.consumedBudget,
        balanceAfter: promo.remainingBudget ?? promo.consumedBudget,
        reference: `Order:${orderId}`,
      },
    });
  }

  /**
   * Reverts promotion usage count and returns budget when an order is cancelled or refunded.
   */
  public static async revertUsageAndBudget(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      reason?: string;
    }
  ): Promise<void> {
    const { orderId, reason } = params;

    // Find any promotion reservations for this order
    const reservations = await tx.promotionReservation.findMany({
      where: { orderId },
    });

    for (const res of reservations) {
      if ((res.status === 'CONSUMED' || res.status === 'RESERVED') && res.shippingPromotionId) {
        const promo = await tx.shippingPromotion.findUnique({
          where: { id: res.shippingPromotionId },
        });

        if (promo) {
          const amount = res.discountAmount || 0;
          const newConsumed = Math.max(0, promo.consumedBudget - amount);
          const newRemaining =
            promo.remainingBudget !== null ? promo.remainingBudget + amount : null;
          const newCount = Math.max(0, promo.currentUsageCount - 1);
          const newStatus =
            promo.status === 'EXHAUSTED' && (newRemaining === null || newRemaining > 0)
              ? 'ACTIVE'
              : promo.status;

          await tx.shippingPromotion.update({
            where: { id: promo.id },
            data: {
              consumedBudget: newConsumed,
              remainingBudget: newRemaining,
              currentUsageCount: newCount,
              status: newStatus,
            },
          });

          await tx.shippingPromotionBudgetTransaction.create({
            data: {
              promotionId: promo.id,
              orderId,
              reservationId: res.id,
              amount,
              type: 'REFUND',
              balanceBefore: promo.remainingBudget ?? promo.consumedBudget,
              balanceAfter: newRemaining ?? newConsumed,
              reference: reason || `Order cancelled: ${orderId}`,
            },
          });
        }

        await tx.promotionReservation.update({
          where: { id: res.id },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
          },
        });
      }
    }

    // Delete customer promotion usage records so customer can reuse promotion if applicable
    await tx.promotionUsage.deleteMany({
      where: { orderId },
    });
  }
}

