import { prisma } from '../../../database/prisma';
import {
  RewardTxType,
  RewardTxSource,
  RewardTxStatus,
} from '../rewards.types';
import { RewardsConfigService } from './rewards-config.service';
import { RewardsLedgerService } from './rewards-ledger.service';
import { RewardsNotificationService } from './rewards-notification.service';

export class RewardsReversalService {
  /**
   * Handles reward reversal and coin refund when an order is cancelled (§21).
   */
  static async onOrderCancelled(params: {
    orderId: string;
    cancelledBy: string;
    reason?: string;
    externalTx?: any;
  }) {
    const { orderId, cancelledBy, reason, externalTx } = params;

    const execute = async (tx: any) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
      });

      if (!order) return;

      // 1. If coins were redeemed at checkout, refund the coins back to customer
      if (order.coinsUsed && order.coinsUsed > 0) {
        const idempotencyKey = `cancelCoinRefund:${orderId}`;
        const creditRes = await RewardsLedgerService.creditCoins(
          {
            customerId: order.userId,
            coins: order.coinsUsed,
            type: RewardTxType.ORDER_CANCELLATION,
            source: RewardTxSource.SYSTEM,
            referenceType: 'ORDER',
            referenceId: orderId,
            idempotencyKey,
            descriptionAr: `استرجاع عملات سوقناا المستخدمة في الطلب الملغي #${order.orderNumber}`,
            descriptionEn: `Refund of SOUQNAA Coins used on cancelled order #${order.orderNumber}`,
            createdBy: cancelledBy,
            metadata: { orderId, orderNumber: order.orderNumber, reason },
          },
          tx
        );

        if (!creditRes.isDuplicate) {
          await RewardsNotificationService.notifyCoinsEarned({
            customerId: order.userId,
            coins: order.coinsUsed,
            reasonAr: `استرجاع عملاتك من الطلب الملغي #${order.orderNumber}`,
            reasonEn: `refunded from cancelled order #${order.orderNumber}`,
            referenceId: orderId,
          });
        }
      }

      // 2. If purchase reward was already granted for this order, reverse it
      const earnTx = await tx.coinTransaction.findFirst({
        where: {
          referenceType: 'ORDER',
          referenceId: orderId,
          type: RewardTxType.PURCHASE_REWARD,
          status: RewardTxStatus.COMPLETED,
        },
      });

      if (earnTx && earnTx.coins > 0) {
        const reversalKey = `cancelRewardRev:${orderId}`;
        const rules = await RewardsConfigService.getRules();

        await RewardsLedgerService.debitCoinsFIFO(
          {
            customerId: order.userId,
            coins: earnTx.coins,
            type: RewardTxType.ORDER_CANCELLATION,
            source: RewardTxSource.SYSTEM,
            referenceType: 'ORDER',
            referenceId: orderId,
            idempotencyKey: reversalKey,
            descriptionAr: `إلغاء مكافأة الطلب الملغي #${order.orderNumber}`,
            descriptionEn: `Reversal of reward for cancelled order #${order.orderNumber}`,
            createdBy: cancelledBy,
            allowNegative: rules.negativeBalanceAllowed,
          },
          tx
        );

        await RewardsNotificationService.notifyCoinsReversed({
          customerId: order.userId,
          coins: earnTx.coins,
          reasonAr: `بسبب إلغاء الطلب #${order.orderNumber}`,
          reasonEn: `due to cancellation of order #${order.orderNumber}`,
        });
      }
    };

    return externalTx ? execute(externalTx) : prisma.$transaction(execute);
  }

  /**
   * Handles proportionate coin reversal when an order is partially or fully refunded (§22, §23, §83).
   * Uses historical order snapshot instead of today's live configuration.
   */
  static async onOrderRefunded(params: {
    orderId: string;
    refundAmount: number;
    refundId: string;
    externalTx?: any;
  }) {
    const { orderId, refundAmount, refundId, externalTx } = params;

    const execute = async (tx: any) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
      });

      if (!order) return;

      // 1. Find historical purchase reward transaction for this order (§83)
      const earnTx = await tx.coinTransaction.findFirst({
        where: {
          referenceType: 'ORDER',
          referenceId: orderId,
          type: RewardTxType.PURCHASE_REWARD,
          status: RewardTxStatus.COMPLETED,
        },
      });

      if (!earnTx || earnTx.coins <= 0) {
        return; // No purchase coins were earned on this order
      }

      // Calculate proportionate reversal based on eligible order subtotal
      const refundRatio = order.subtotal > 0 ? Math.min(1.0, refundAmount / order.subtotal) : 1.0;
      const coinsToReverse = Math.ceil(earnTx.coins * refundRatio);

      if (coinsToReverse <= 0) return;

      const idempotencyKey = `refundCoinRev:${refundId}`;
      const rules = await RewardsConfigService.getRules();

      const debitResult = await RewardsLedgerService.debitCoinsFIFO(
        {
          customerId: order.userId,
          coins: coinsToReverse,
          type: RewardTxType.REFUND_REVERSAL,
          source: RewardTxSource.SYSTEM,
          referenceType: 'REFUND',
          referenceId: refundId,
          idempotencyKey,
          descriptionAr: `استرداد عملات بنسبة ${Math.round(refundRatio * 100)}% بسبب استرجاع في الطلب #${order.orderNumber}`,
          descriptionEn: `Reversal of ${coinsToReverse} coins (${Math.round(refundRatio * 100)}%) due to refund on order #${order.orderNumber}`,
          allowNegative: rules.negativeBalanceAllowed,
          metadata: {
            orderId,
            refundId,
            refundAmount,
            refundRatio,
            originalEarnedCoins: earnTx.coins,
          },
        },
        tx
      );

      if (!debitResult.isDuplicate) {
        await RewardsNotificationService.notifyCoinsReversed({
          customerId: order.userId,
          coins: coinsToReverse,
          reasonAr: `بسبب استرجاع في الطلب #${order.orderNumber}`,
          reasonEn: `due to a refund on order #${order.orderNumber}`,
        });
      }
    };

    return externalTx ? execute(externalTx) : prisma.$transaction(execute);
  }
}
