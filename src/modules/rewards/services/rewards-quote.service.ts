import crypto from 'crypto';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  CoinQuoteRequest,
  CoinQuoteResponse,
  CoinReservationStatus,
  RewardTxType,
  RewardTxSource,
} from '../rewards.types';
import { RewardsConfigService } from './rewards-config.service';
import { RewardsLedgerService } from './rewards-ledger.service';

export class RewardsQuoteService {
  private static readonly QUOTE_TTL_MINUTES = 15;

  /**
   * Generates a server-authoritative checkout coin quote (§16, §80, §81).
   * Validates balances, caps, thresholds, and calculates eligible discount.
   */
  static async calculateQuote(params: CoinQuoteRequest): Promise<CoinQuoteResponse> {
    const { customerId, orderSubtotal, coinsRequested = 0, currency = 'YER' } = params;

    const rules = await RewardsConfigService.getRules();
    const isCoinsEnabled = await RewardsConfigService.isEnabled('rewards_coins.enabled');
    const isRedemptionEnabled = await RewardsConfigService.isEnabled('rewards_coin_redemption.enabled');

    if (!isCoinsEnabled || !isRedemptionEnabled) {
      return {
        quoteId: crypto.randomUUID(),
        quoteVersion: '1.0.0',
        availableCoins: 0,
        maxUsableCoins: 0,
        coinsRequested: 0,
        coinsAccepted: 0,
        conversionRate: rules.redemptionRatio || 100,
        discountAmount: 0,
        orderSubtotal,
        remainingPayable: orderSubtotal,
        currency,
        maxOrderPercentage: rules.maxOrderPercentage || 0.20,
        expiresAt: new Date(Date.now() + this.QUOTE_TTL_MINUTES * 60 * 1000).toISOString(),
        eligible: false,
        reason: 'نظام خصم العملات غير مفعل حالياً',
      };
    }

    const availableCoins = await RewardsLedgerService.getAuthoritativeBalance(customerId);

    // Minimum order amount check
    if (orderSubtotal < (rules.minOrderAmount || 200)) {
      return {
        quoteId: crypto.randomUUID(),
        quoteVersion: '1.0.0',
        availableCoins,
        maxUsableCoins: 0,
        coinsRequested: 0,
        coinsAccepted: 0,
        conversionRate: rules.redemptionRatio,
        discountAmount: 0,
        orderSubtotal,
        remainingPayable: orderSubtotal,
        currency,
        maxOrderPercentage: rules.maxOrderPercentage,
        expiresAt: new Date(Date.now() + this.QUOTE_TTL_MINUTES * 60 * 1000).toISOString(),
        eligible: false,
        reason: `الحد الأدنى للطلب لاستخدام العملات هو ${rules.minOrderAmount} ${currency}`,
      };
    }

    // Minimum coins required check
    if (availableCoins < (rules.minCoinsRequired || 50)) {
      return {
        quoteId: crypto.randomUUID(),
        quoteVersion: '1.0.0',
        availableCoins,
        maxUsableCoins: 0,
        coinsRequested: 0,
        coinsAccepted: 0,
        conversionRate: rules.redemptionRatio,
        discountAmount: 0,
        orderSubtotal,
        remainingPayable: orderSubtotal,
        currency,
        maxOrderPercentage: rules.maxOrderPercentage,
        expiresAt: new Date(Date.now() + this.QUOTE_TTL_MINUTES * 60 * 1000).toISOString(),
        eligible: false,
        reason: `الحد الأدنى المطلوب لاستخدام العملات هو ${rules.minCoinsRequired} عملة`,
      };
    }

    // Calculate maximum allowable discount and coins for this order (§13):
    // Max discount by percentage: e.g. 20% of subtotal
    const maxDiscountAllowed = parseFloat((orderSubtotal * rules.maxOrderPercentage).toFixed(2));
    // Coins needed for max discount
    const coinsForMaxDiscount = Math.floor(maxDiscountAllowed * rules.redemptionRatio);

    // Max usable coins = MIN(availableCoins, coinsForMaxDiscount, maxCoinsPerOrder)
    const maxUsableCoins = Math.min(
      availableCoins,
      coinsForMaxDiscount,
      rules.maxCoinsPerOrder || 2000
    );

    // If customer asked for a specific amount, cap it at maxUsableCoins
    const coinsAccepted = Math.max(0, Math.min(coinsRequested, maxUsableCoins));
    const discountAmount = parseFloat((coinsAccepted / rules.redemptionRatio).toFixed(2));
    const remainingPayable = parseFloat(Math.max(0, orderSubtotal - discountAmount).toFixed(2));

    const quoteId = crypto.randomUUID();
    const expiresAtDate = new Date(Date.now() + this.QUOTE_TTL_MINUTES * 60 * 1000);

    return {
      quoteId,
      quoteVersion: rules.version || '1.0.0',
      availableCoins,
      maxUsableCoins,
      coinsRequested,
      coinsAccepted,
      conversionRate: rules.redemptionRatio,
      discountAmount,
      orderSubtotal,
      remainingPayable,
      currency,
      maxOrderPercentage: rules.maxOrderPercentage,
      expiresAt: expiresAtDate.toISOString(),
      eligible: maxUsableCoins > 0,
    };
  }

  /**
   * Reserves coins during checkout session (§17).
   */
  static async reserveCoins(params: {
    customerId: string;
    coins: number;
    discountAmount: number;
    quoteVersion: string;
    orderId?: string;
    idempotencyKey?: string;
  }) {
    const { customerId, coins, discountAmount, quoteVersion, orderId, idempotencyKey } = params;

    if (coins <= 0) return null;

    return prisma.$transaction(async (tx) => {
      // 1. Check idempotency
      if (idempotencyKey) {
        const existing = await tx.coinReservation.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return existing;
      }

      // 2. Verify customer has enough unreserved available coins
      const balance = await RewardsLedgerService.getAuthoritativeBalance(customerId, tx);

      // Sum currently active reservations for this customer
      const activeReservations = await tx.coinReservation.aggregate({
        where: {
          customerId,
          status: CoinReservationStatus.RESERVED,
          expiresAt: { gt: new Date() },
          ...(orderId ? { orderId: { not: orderId } } : {}),
        },
        _sum: { coins: true },
      });

      const reservedCoins = activeReservations._sum.coins || 0;
      const unreservedCoins = balance - reservedCoins;

      if (unreservedCoins < coins) {
        throw new AppError(
          `رصيد العملات المتاح غير كافٍ للحجز. المتاح: ${unreservedCoins}، المطلوب: ${coins}`,
          400,
          'INSUFFICIENT_UNRESERVED_COINS'
        );
      }

      const expiresAt = new Date(Date.now() + this.QUOTE_TTL_MINUTES * 60 * 1000);
      const rules = await RewardsConfigService.getRules();

      const reservation = await tx.coinReservation.create({
        data: {
          customerId,
          orderId,
          coins,
          discountAmount,
          conversionRate: rules.redemptionRatio,
          status: CoinReservationStatus.RESERVED,
          quoteVersion,
          idempotencyKey,
          expiresAt,
        },
      });

      return reservation;
    });
  }

  /**
   * Releases reserved coins if checkout/payment is cancelled or fails (§17).
   */
  static async releaseReservation(reservationId: string) {
    return prisma.coinReservation.updateMany({
      where: {
        id: reservationId,
        status: CoinReservationStatus.RESERVED,
      },
      data: {
        status: CoinReservationStatus.RELEASED,
      },
    });
  }

  /**
   * Confirms reservation and executes the authoritative FIFO ledger redemption (§17).
   */
  static async confirmReservation(params: {
    reservationId: string;
    orderId: string;
    tx: any;
  }) {
    const { reservationId, orderId, tx } = params;

    const reservation = await tx.coinReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      throw new AppError('حجز العملات غير موجود', 404);
    }

    if (reservation.status === CoinReservationStatus.CONFIRMED) {
      return reservation; // Already confirmed idempotently
    }

    if (reservation.status !== CoinReservationStatus.RESERVED) {
      throw new AppError('حجز العملات غير صالح أو ملغي', 400);
    }

    if (reservation.expiresAt < new Date()) {
      throw new AppError('انتهت صلاحية حجز العملات. يرجى إعادة تطبيق الخصم', 400);
    }

    // Mark reservation as CONFIRMED and attach orderId
    await tx.coinReservation.update({
      where: { id: reservationId },
      data: {
        status: CoinReservationStatus.CONFIRMED,
        orderId,
      },
    });

    // Execute FIFO ledger debit
    const debitResult = await RewardsLedgerService.debitCoinsFIFO(
      {
        customerId: reservation.customerId,
        coins: reservation.coins,
        type: RewardTxType.REDEEM,
        source: RewardTxSource.PURCHASE,
        referenceType: 'ORDER',
        referenceId: orderId,
        idempotencyKey: `orderRedeem:${orderId}`,
        descriptionAr: `استخدام عملات سوقناا في الطلب #${orderId}`,
        descriptionEn: `SOUQNAA Coins redeemed on order #${orderId}`,
      },
      tx
    );

    return { reservation, transaction: debitResult.transaction };
  }
}
