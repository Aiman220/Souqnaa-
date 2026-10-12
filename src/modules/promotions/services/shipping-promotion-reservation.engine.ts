/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Authoritative Promotion Reservation Engine
 * Version: 2.0.0
 */

import { prisma } from '../../../database/prisma';
import { Prisma } from '@prisma/client';
import {
  UniversalReservationResult,
  ShippingFundingBreakdown,
} from '../universal-shipping-promotion.types';
import { ShippingPromotionBudgetService } from './shipping-promotion-budget.service';

export class ShippingPromotionReservationEngine {
  private static readonly DEFAULT_TTL_MINUTES = 15;

  /**
   * Creates an atomic, idempotent shipping promotion reservation.
   */
  public static async reserve(params: {
    customerId: string;
    promotionId: string;
    promotionType: string;
    promotionCode: string;
    calculation: ShippingFundingBreakdown;
    cartId?: string;
    checkoutId?: string;
    idempotencyKey?: string;
    ttlMinutes?: number;
  }): Promise<UniversalReservationResult> {
    const {
      customerId,
      promotionId,
      promotionType,
      promotionCode,
      calculation,
      cartId,
      checkoutId,
      idempotencyKey,
      ttlMinutes = this.DEFAULT_TTL_MINUTES,
    } = params;

    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    return await prisma.$transaction(async (tx) => {
      // 1. Check idempotency
      if (idempotencyKey) {
        const existing = await tx.promotionReservation.findUnique({
          where: { idempotencyKey },
        });

        if (existing && existing.status === 'RESERVED' && existing.expiresAt > new Date()) {
          return {
            reservationId: existing.id,
            promotionId,
            promotionCode,
            status: existing.status,
            expiresAt: existing.expiresAt,
            calculation,
            idempotencyKey,
          };
        }
      }

      // 2. Reserve budget if platform subsidy > 0
      if (calculation.platformShippingSubsidy > 0) {
        await ShippingPromotionBudgetService.reserveBudget(tx, {
          promotionId,
          amount: calculation.platformShippingSubsidy,
        });
      }

      // 3. Create reservation record
      const reservation = await tx.promotionReservation.create({
        data: {
          customerId,
          promotionType,
          shippingPromotionId: promotionId,
          cartId,
          checkoutId,
          status: 'RESERVED',
          originalShippingAmount: calculation.originalShippingAmount,
          discountAmount: calculation.shippingPromotionDiscount,
          platformSubsidy: calculation.platformShippingSubsidy,
          sellerContribution: calculation.sellerShippingContribution,
          costBearer: calculation.fundingType,
          expiresAt,
          idempotencyKey,
        },
      });

      return {
        reservationId: reservation.id,
        promotionId,
        promotionCode,
        status: reservation.status,
        expiresAt: reservation.expiresAt,
        calculation,
        idempotencyKey,
      };
    });
  }

  /**
   * Consumes a reservation upon successful order placement within the checkout transaction.
   */
  public static async consume(
    tx: Prisma.TransactionClient,
    params: {
      reservationId: string;
      orderId: string;
      calculation: ShippingFundingBreakdown;
    }
  ): Promise<void> {
    const { reservationId, orderId, calculation } = params;

    const res = await tx.promotionReservation.findUnique({
      where: { id: reservationId },
    });

    if (!res) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    if (res.status === 'CONSUMED') {
      // Idempotent success
      return;
    }

    if (res.status !== 'RESERVED') {
      throw new Error(`Cannot consume reservation with status ${res.status}`);
    }

    // Update reservation status
    await tx.promotionReservation.update({
      where: { id: reservationId },
      data: {
        status: 'CONSUMED',
        consumedAt: new Date(),
        orderId,
      },
    });

    // Record authoritative PromotionUsage
    await tx.promotionUsage.create({
      data: {
        customerId: res.customerId,
        promotionType: res.promotionType,
        shippingPromotionId: res.shippingPromotionId,
        orderId,
        reservationId,
        costBearer: res.costBearer,
        originalShippingAmount: calculation.originalShippingAmount,
        discountAmount: calculation.shippingPromotionDiscount,
        platformSubsidy: calculation.platformShippingSubsidy,
        sellerContribution: calculation.sellerShippingContribution,
        sellerDeliveryReimbursement: calculation.sellerDeliveryReimbursement,
        status: 'CONSUMED',
      },
    });

    // Update promotion usage counters
    if (res.shippingPromotionId) {
      await ShippingPromotionBudgetService.incrementUsage(tx, {
        promotionId: res.shippingPromotionId,
        amount: calculation.platformShippingSubsidy,
        orderId,
        reservationId,
      });
    }
  }

  /**
   * Releases an unconsumed reservation (e.g. checkout cancellation or failed payment).
   */
  public static async release(params: {
    reservationId: string;
    reason?: string;
  }): Promise<void> {
    const { reservationId, reason } = params;

    await prisma.$transaction(async (tx) => {
      const res = await tx.promotionReservation.findUnique({
        where: { id: reservationId },
      });

      if (!res || res.status !== 'RESERVED') {
        return;
      }

      await tx.promotionReservation.update({
        where: { id: reservationId },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
        },
      });

      // Release reserved budget
      if (res.shippingPromotionId && res.platformSubsidy > 0) {
        await ShippingPromotionBudgetService.releaseBudget(tx, {
          promotionId: res.shippingPromotionId,
          amount: res.platformSubsidy,
          reservationId,
          reason,
        });
      }
    });
  }
}
