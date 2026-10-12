/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Promotion Reservation & Consumption Service
 * Concurrency-Safe with Transactions & Atomic Updates
 * Version: 1.0.0
 */

import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  PromotionReservationStatus,
  ShippingPromotionCostBearer,
} from '@prisma/client';
import { FirstOrderShippingCalculationService } from './first-order-shipping-calculation.service';
import { FirstOrderShippingConfigService } from './first-order-shipping-config.service';
import { FirstOrderFreeShippingEligibilityService } from './first-order-eligibility.service';
import { FirstOrderEligibilityStatus, FirstOrderShippingCalculation } from '../first-order-shipping.types';

export class FirstOrderPromotionReservationService {
  public static readonly DEFAULT_RESERVATION_TTL_MINUTES = 15;

  /**
   * Cleans up expired reservations
   */
  public static async cleanupExpiredReservations(tx?: any): Promise<number> {
    const client = tx || prisma;
    const now = new Date();

    const expired = await client.promotionReservation.findMany({
      where: {
        promotionType: 'FIRST_ORDER_FREE_SHIPPING',
        status: PromotionReservationStatus.RESERVED,
        expiresAt: { lt: now },
      },
      select: { id: true },
    });

    if (expired.length === 0) return 0;

    await client.promotionReservation.updateMany({
      where: {
        id: { in: expired.map((e: { id: string }) => e.id) },
      },
      data: {
        status: PromotionReservationStatus.EXPIRED,
      },
    });

    return expired.length;
  }

  /**
   * Concurrency-safe atomic reservation of the First-Order Free Shipping benefit.
   * Prevents simultaneous checkouts on multiple tabs/devices from consuming the benefit twice.
   */
  public static async reservePromotion(params: {
    customerId: string;
    cartId?: string;
    checkoutId?: string;
    cartSubtotal: number;
    originalShippingAmount: number;
    deliveryMethod?: string;
    deliveryZoneId?: string | null;
    deliveryZoneName?: string | null;
    sellerQuotes?: Array<{ sellerId: string; deliveryFee: number }>;
    idempotencyKey?: string;
    ttlMinutes?: number;
  }): Promise<{
    reservationId: string;
    calculation: FirstOrderShippingCalculation;
  }> {
    const config = await FirstOrderShippingConfigService.getConfig();

    return await prisma.$transaction(async (tx) => {
      // 1. Expire outdated reservations first
      await this.cleanupExpiredReservations(tx);

      // 2. Check for existing consumed promotion
      const priorConsumed = await tx.promotionUsage.findFirst({
        where: {
          customerId: params.customerId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status: 'CONSUMED',
        },
      });

      if (priorConsumed) {
        throw new AppError('تمت الاستفادة مسبقاً من عرض الشحن المجاني للطلب الأول', 400);
      }

      // 3. Check for existing active reservation
      const activeReservation = await tx.promotionReservation.findFirst({
        where: {
          customerId: params.customerId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status: PromotionReservationStatus.RESERVED,
          expiresAt: { gt: new Date() },
        },
      });

      // 4. Calculate Authoritative Shipping Discount & Allocation
      const calculation = FirstOrderShippingCalculationService.calculateShippingPromotion({
        originalShippingAmount: params.originalShippingAmount,
        config,
        sellerQuotes: params.sellerQuotes,
      });

      // 5. If active reservation exists for the same checkout/idempotency, reuse or update it
      if (activeReservation) {
        if (
          (params.idempotencyKey && activeReservation.idempotencyKey === params.idempotencyKey) ||
          (params.cartId && activeReservation.cartId === params.cartId)
        ) {
          const updated = await tx.promotionReservation.update({
            where: { id: activeReservation.id },
            data: {
              originalShippingAmount: calculation.originalShippingAmount,
              discountAmount: calculation.shippingPromotionDiscount,
              platformSubsidy: calculation.platformShippingSubsidy,
              sellerContribution: calculation.sellerShippingContribution,
              costBearer: calculation.costBearer,
              expiresAt: new Date(Date.now() + (params.ttlMinutes || this.DEFAULT_RESERVATION_TTL_MINUTES) * 60 * 1000),
            },
          });
          return { reservationId: updated.id, calculation };
        } else {
          // Simultaneous checkout on another tab/device detected
          throw new AppError(
            'يوجد حجز نشط لعرض الشحن المجاني قيد المعالجة في جلسة دفع أخرى. يرجى الانتظار أو إتمام الطلب السابق.',
            409
          );
        }
      }

      // 6. Check campaign budget
      if (config.platformBudget !== null && calculation.platformShippingSubsidy > 0) {
        const remainingBudget = config.platformBudget - config.consumedBudget;
        if (remainingBudget < calculation.platformShippingSubsidy) {
          throw new AppError('عذراً، نفدت ميزانية الشحن المجاني الترويجي المخصصة للمنصة', 400);
        }
      }

      // 7. Create new atomic reservation
      const ttlMinutes = params.ttlMinutes || this.DEFAULT_RESERVATION_TTL_MINUTES;
      const reservation = await tx.promotionReservation.create({
        data: {
          customerId: params.customerId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          cartId: params.cartId || null,
          checkoutId: params.checkoutId || null,
          status: PromotionReservationStatus.RESERVED,
          originalShippingAmount: calculation.originalShippingAmount,
          discountAmount: calculation.shippingPromotionDiscount,
          platformSubsidy: calculation.platformShippingSubsidy,
          sellerContribution: calculation.sellerShippingContribution,
          costBearer: calculation.costBearer,
          reservedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
          idempotencyKey: params.idempotencyKey || null,
        },
      });

      return {
        reservationId: reservation.id,
        calculation,
      };
    });
  }

  /**
   * Consumes an existing reservation during final order creation.
   * Atomically transitions status to CONSUMED and records permanent PromotionUsage snapshot.
   */
  public static async consumeReservation(
    tx: any,
    params: {
      reservationId: string;
      orderId: string;
      calculation: FirstOrderShippingCalculation;
    }
  ): Promise<any> {
    const reservation = await tx.promotionReservation.findUnique({
      where: { id: params.reservationId },
    });

    if (!reservation) {
      throw new AppError('حجز عرض الشحن المجاني غير موجود', 404);
    }

    if (reservation.status !== PromotionReservationStatus.RESERVED) {
      throw new AppError(
        `حالة حجز الشحن المجاني غير صالحة للاستخدام (${reservation.status})`,
        400
      );
    }

    if (new Date() > reservation.expiresAt) {
      throw new AppError('انتهت صلاحية حجز عرض الشحن المجاني، يرجى إعادة المحاولة', 400);
    }

    // 1. Mark reservation as CONSUMED
    const updatedReservation = await tx.promotionReservation.update({
      where: { id: reservation.id },
      data: {
        status: PromotionReservationStatus.CONSUMED,
        orderId: params.orderId,
        consumedAt: new Date(),
      },
    });

    // 2. Create immutable PromotionUsage record
    const usage = await tx.promotionUsage.create({
      data: {
        customerId: reservation.customerId,
        promotionType: 'FIRST_ORDER_FREE_SHIPPING',
        orderId: params.orderId,
        reservationId: reservation.id,
        costBearer: params.calculation.costBearer,
        originalShippingAmount: params.calculation.originalShippingAmount,
        discountAmount: params.calculation.shippingPromotionDiscount,
        platformSubsidy: params.calculation.platformShippingSubsidy,
        sellerShippingContribution: params.calculation.sellerShippingContribution,
        sellerDeliveryReimbursement: params.calculation.sellerDeliveryReimbursement,
        status: 'CONSUMED',
        consumedAt: new Date(),
      },
    });

    // 3. Atomically consume campaign budget if platform subsidy applied
    if (params.calculation.platformShippingSubsidy > 0) {
      const activeConfig = await tx.firstOrderFreeShippingConfig.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      if (activeConfig) {
        await tx.firstOrderFreeShippingConfig.update({
          where: { id: activeConfig.id },
          data: {
            consumedBudget: { increment: params.calculation.platformShippingSubsidy },
          },
        });
      }
    }

    return { reservation: updatedReservation, usage };
  }

  /**
   * Releases an active reservation if checkout is cancelled/abandoned before qualification.
   */
  public static async releaseReservation(
    reservationId: string,
    reason?: string,
    tx?: any
  ): Promise<boolean> {
    const client = tx || prisma;
    const reservation = await client.promotionReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation || reservation.status !== PromotionReservationStatus.RESERVED) {
      return false;
    }

    await client.promotionReservation.update({
      where: { id: reservationId },
      data: {
        status: PromotionReservationStatus.RELEASED,
        releasedAt: new Date(),
      },
    });

    return true;
  }

  /**
   * Admin-only exceptional restoration of first-order free shipping eligibility.
   * Requires elevated RBAC and an immutable audit log entry.
   */
  public static async restorePromotionUsage(params: {
    actorId: string;
    usageId: string;
    reason: string;
  }): Promise<any> {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new AppError('سبب إعادة منح العرض إلزامي ويجب توثيقه للأغراض المحاسبية', 400);
    }

    const usage = await prisma.promotionUsage.findUnique({
      where: { id: params.usageId },
      include: { order: true, customer: true },
    });

    if (!usage) {
      throw new AppError('سجل استخدام العرض غير موجود', 404);
    }

    if (usage.status !== 'CONSUMED') {
      throw new AppError(`لا يمكن تعديل حالة الاستخدام الحالية (${usage.status})`, 400);
    }

    const restored = await prisma.$transaction(async (tx) => {
      const updated = await tx.promotionUsage.update({
        where: { id: usage.id },
        data: {
          status: 'RESTORED',
          restoredAt: new Date(),
          restoredBy: params.actorId,
          restorationReason: params.reason,
        },
      });

      // Audit Log
      await tx.promotionConfigAuditLog.create({
        data: {
          actorId: params.actorId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          action: 'RESTORE_PROMOTION_USAGE',
          reason: params.reason,
          previousValue: JSON.stringify(usage),
          newValue: JSON.stringify(updated),
        },
      });

      return updated;
    });

    return restored;
  }
}
