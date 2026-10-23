import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';
import {
  OrderStatus,
  SellerOrderStatus,
  PaymentStatus,
  TransactionType,
  CancellationRequestStatus,
  ReturnRequestStatus,
  RefundStatus,
  NotificationType,
  WalletTxType,
} from '@prisma/client';
import { SocketService } from '../../services/websocket/socket.service';
import { CustomerWalletService } from '../wallet/customer-wallet.service';
import { RewardsEarningService } from '../rewards/services/rewards-earning.service';
import { RewardsReversalService } from '../rewards/services/rewards-reversal.service';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { ShippingPromotionBudgetService } from '../promotions/services/shipping-promotion-budget.service';
import { MembershipEligibilityService } from '../membership/membership-eligibility.service';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';

/**
 * Valid transitions for Seller Orders / Orders based on current status.
 */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: [
    'CONFIRMED',
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_SELLER',
    'REJECTED_BY_SELLER',
    'CANCELLED_BY_ADMIN',
  ],
  CONFIRMED: [
    'PROCESSING',
    'READY_TO_SHIP',
    'SHIPPED',
    'CANCELLATION_REQUESTED',
    'CANCELLED_BY_SELLER',
    'CANCELLED_BY_ADMIN',
  ],
  PROCESSING: [
    'READY_TO_SHIP',
    'SHIPPED',
    'CANCELLATION_REQUESTED',
    'CANCELLED_BY_SELLER',
    'CANCELLED_BY_ADMIN',
  ],
  READY_TO_SHIP: [
    'SHIPPED',
    'DELIVERED',
    'CANCELLED_BY_ADMIN',
  ],
  SHIPPED: [
    'DELIVERED',
    'RETURN_REQUESTED',
  ],
  DELIVERED: [
    'RETURN_REQUESTED',
  ],
  CANCELLATION_REQUESTED: [
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_SELLER',
    'CANCELLED_BY_ADMIN',
    'CONFIRMED',
    'PROCESSING',
    'READY_TO_SHIP',
  ],
  RETURN_REQUESTED: [
    'RETURN_APPROVED',
    'DELIVERED',
    'REFUND_PENDING',
    'REFUNDED',
  ],
  RETURN_APPROVED: [
    'RETURNED',
    'REFUND_PENDING',
    'REFUNDED',
  ],
  RETURNED: [
    'REFUND_PENDING',
    'REFUNDED',
  ],
  REFUND_PENDING: [
    'REFUNDED',
  ],
  REFUNDED: [],
  CANCELLED_BY_CUSTOMER: [],
  CANCELLED_BY_SELLER: [],
  REJECTED_BY_SELLER: [],
  CANCELLED_BY_ADMIN: [],
};

export class OrderStateMachine {
  /**
   * Validate if a transition from `currentStatus` to `targetStatus` is permitted.
   */
  static isValidTransition(currentStatus: string, targetStatus: string): boolean {
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  /**
   * Recalculate and update parent Order status from all its child SellerOrders.
   */
  static async syncParentOrderStatus(orderId: string, tx: any = prisma): Promise<OrderStatus> {
    const allSellerOrders = await tx.sellerOrder.findMany({
      where: { orderId },
      select: { status: true },
    });

    if (allSellerOrders.length === 0) return OrderStatus.PENDING;

    const statuses: string[] = allSellerOrders.map((so: any) => String(so.status));

    let parentStatus: OrderStatus = OrderStatus.PENDING;

    if (statuses.every((s: string) => s === 'DELIVERED')) {
      parentStatus = OrderStatus.DELIVERED;
    } else if (statuses.every((s: string) => s.startsWith('CANCELLED_') || s === 'REJECTED_BY_SELLER')) {
      // If all are cancelled by customer
      if (statuses.every((s: string) => s === 'CANCELLED_BY_CUSTOMER')) {
        parentStatus = OrderStatus.CANCELLED_BY_CUSTOMER;
      } else if (statuses.every((s: string) => s === 'REJECTED_BY_SELLER')) {
        parentStatus = OrderStatus.REJECTED_BY_SELLER;
      } else {
        parentStatus = OrderStatus.CANCELLED_BY_SELLER;
      }
    } else if (statuses.every((s: string) => s === 'REFUNDED')) {
      parentStatus = OrderStatus.REFUNDED;
    } else if (statuses.some((s: string) => s === 'SHIPPED')) {
      parentStatus = OrderStatus.SHIPPED;
    } else if (statuses.some((s: string) => s === 'READY_TO_SHIP')) {
      parentStatus = OrderStatus.READY_TO_SHIP;
    } else if (statuses.some((s: string) => s === 'PROCESSING')) {
      parentStatus = OrderStatus.PROCESSING;
    } else if (statuses.some((s: string) => s === 'CONFIRMED')) {
      parentStatus = OrderStatus.CONFIRMED;
    } else if (statuses.some((s: string) => s === 'CANCELLATION_REQUESTED')) {
      parentStatus = OrderStatus.CANCELLATION_REQUESTED;
    } else if (statuses.some((s: string) => s === 'RETURN_REQUESTED')) {
      parentStatus = OrderStatus.RETURN_REQUESTED;
    } else if (statuses.some((s: string) => s === 'RETURN_APPROVED')) {
      parentStatus = OrderStatus.RETURN_APPROVED;
    } else if (statuses.some((s: string) => s === 'RETURNED')) {
      parentStatus = OrderStatus.RETURNED;
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: parentStatus,
        ...(parentStatus === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
      },
    });

    return parentStatus;
  }

  /**
   * Execute state transition on a SellerOrder with inventory, finance, and history handling.
   */
  static async transitionSellerOrder(params: {
    sellerOrderId: string;
    targetStatus: SellerOrderStatus;
    changedBy: string;
    changedByRole: 'CUSTOMER' | 'SELLER' | 'ADMIN' | 'SYSTEM';
    reason?: string;
    note?: string;
    metadata?: Record<string, any>;
  }) {
    const {
      sellerOrderId,
      targetStatus,
      changedBy,
      changedByRole,
      reason,
      note,
      metadata,
    } = params;

    const sellerOrder = await prisma.sellerOrder.findUnique({
      where: { id: sellerOrderId },
      include: {
        items: true,
        seller: { select: { id: true, userId: true } },
        order: {
          include: {
            payment: true,
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!sellerOrder) throw new AppError('طلب المتجر غير موجود', 404);

    const currentStatus = sellerOrder.status as string;
    const targetStatusStr = targetStatus as string;

    if (!this.isValidTransition(currentStatus, targetStatusStr)) {
      throw new AppError(
        `لا يمكن تحويل حالة الطلب من [${currentStatus}] إلى [${targetStatusStr}]`,
        422
      );
    }

    const isCancellationOrRejection =
      targetStatusStr.startsWith('CANCELLED_') || targetStatusStr === 'REJECTED_BY_SELLER';

    const result = await prisma.$transaction(async (tx) => {
      const soldCountUpdates: Array<{ productId: string; soldCount: number; delta: number }> = [];

      // 1. Update Seller Order Status
      const updatedSellerOrder = await tx.sellerOrder.update({
        where: { id: sellerOrderId },
        data: {
          status: targetStatus,
          ...(targetStatusStr === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        },
      });

      // 2. Manage Inventory & Balance based on target status
      if (isCancellationOrRejection) {
        // Release reserved stock back to available
        for (const item of sellerOrder.items) {
          if (item.variantId) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stockQuantity: { increment: item.quantity } },
            });
          } else {
            await tx.inventory.update({
              where: { productId: item.productId },
              data: { reserved: { decrement: item.quantity } },
            });
          }
        }

        // Revert seller pending balance safely without going below 0
        const currentBal = await tx.sellerBalance.findUnique({
          where: { sellerId: sellerOrder.sellerId },
        });
        if (currentBal) {
          await tx.sellerBalance.update({
            where: { id: currentBal.id },
            data: { pendingBalance: Math.max(0, currentBal.pendingBalance - sellerOrder.sellerPayout) },
          });
        }

        // If order was PAID (via Card, Online, SOUQNApay Wallet, etc.) -> directly credit back customer's local wallet with full payment
        const isPaid = Boolean(
          sellerOrder.order.payment &&
          (sellerOrder.order.payment.status === PaymentStatus.PAID ||
            sellerOrder.order.payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
            sellerOrder.order.payment.method === 'WALLET' ||
            sellerOrder.order.payment.paidAt !== null)
        );

        if (isPaid) {
          // Query sibling seller orders for this parent order
          const allSubOrders = await tx.sellerOrder.findMany({
            where: { orderId: sellerOrder.orderId },
            select: {
              id: true,
              status: true,
              subtotal: true,
              deliveryFee: true,
              customerDeliveryCharge: true,
              taxAmount: true,
              voucherDiscountAmount: true,
            },
          });

          const isSingleSubOrder = allSubOrders.length <= 1;
          const otherSubOrders = allSubOrders.filter((s) => s.id !== sellerOrder.id);
          const allOthersTerminated = otherSubOrders.every((s) => {
            const st = String(s.status);
            return (
              st.startsWith('CANCELLED_') ||
              st === 'REJECTED_BY_SELLER' ||
              st === 'CANCELLED' ||
              st === 'RETURN_APPROVED' ||
              st === 'RETURNED' ||
              st === 'REFUNDED'
            );
          });

          // Sum all previous wallet refunds for this parent order to avoid over-refunding
          const priorRefundLedgers = await tx.walletLedgerEntry.findMany({
            where: {
              referenceId: sellerOrder.orderId,
              type: WalletTxType.ORDER_REFUND,
              direction: 'CREDIT',
            },
            select: { amount: true },
          });
          const priorRefundTotal = priorRefundLedgers.reduce((sum: number, l: any) => sum + (l.amount || 0), 0);
          const fullOrderPayment = Number(sellerOrder.order.total || 0);
          const maxRemainingToRefund = Math.max(0, parseFloat((fullOrderPayment - priorRefundTotal).toFixed(2)));

          let refundAmount = 0;
          if (isSingleSubOrder || allOthersTerminated) {
            // Full remaining payment of the order returned to customer wallet
            refundAmount = maxRemainingToRefund;
          } else {
            // Proportional full payment for this seller sub-order:
            // subtotal + customer delivery charge + tax - voucher discount
            const custDelivery = sellerOrder.customerDeliveryCharge ?? sellerOrder.deliveryFee ?? 0;
            const custTax = sellerOrder.taxAmount ?? 0;
            const custDiscount = sellerOrder.voucherDiscountAmount ?? 0;
            const subOrderFullAmount = Math.max(
              0,
              parseFloat((sellerOrder.subtotal + custDelivery + custTax - custDiscount).toFixed(2))
            );
            refundAmount = Math.min(subOrderFullAmount, maxRemainingToRefund);
          }

          if (refundAmount > 0) {
            await CustomerWalletService.creditForOrderRefund(
              {
                customerId: sellerOrder.order.userId,
                orderId: sellerOrder.orderId,
                orderNumber: sellerOrder.order.orderNumber,
                amount: refundAmount,
                reason:
                  reason ||
                  (targetStatusStr === 'REJECTED_BY_SELLER'
                    ? 'رفض الطلب من قبل المتجر واسترداد كامل المبلغ للمحفظة'
                    : 'إلغاء الطلب واسترداد كامل المبلغ للمحفظة'),
                referenceType: `SELLER_ORDER_${sellerOrderId}`,
              },
              tx
            );

            const isOrderFullyRefunded = (maxRemainingToRefund - refundAmount) <= 0.01;
            await tx.payment.update({
              where: { orderId: sellerOrder.orderId },
              data: {
                status: isOrderFullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
              },
            });
          }
        }
      } else if (targetStatusStr === 'DELIVERED') {
        const wasDelivered = currentStatus === 'DELIVERED';
        // Permanent stock deduction & sold count increment (Idempotent: only if not previously delivered)
        if (!wasDelivered) {
          for (const item of sellerOrder.items) {
            if (!item.variantId) {
              await tx.inventory.update({
                where: { productId: item.productId },
                data: {
                  quantity: { decrement: item.quantity },
                  reserved: { decrement: item.quantity },
                },
              });
            }
            if (item.productId) {
              const updatedProduct = await tx.product.update({
                where: { id: item.productId },
                data: {
                  soldCount: { increment: item.quantity },
                },
                select: { id: true, soldCount: true },
              });
              soldCountUpdates.push({
                productId: updatedProduct.id,
                soldCount: updatedProduct.soldCount,
                delta: item.quantity,
              });
            }
          }
        }

        const isCodOrder = sellerOrder.order.payment?.method === 'CASH_ON_DELIVERY';
        const currentBal = await tx.sellerBalance.findUnique({
          where: { sellerId: sellerOrder.sellerId },
        });
        const newPending = currentBal ? Math.max(0, currentBal.pendingBalance - sellerOrder.sellerPayout) : 0;

        if (isCodOrder) {
          // COD: Cash is collected in person by seller/courier upon delivery.
          // Marketplace does NOT credit availableBalance to prevent double payout.
          await tx.sellerBalance.upsert({
            where: { sellerId: sellerOrder.sellerId },
            update: { pendingBalance: newPending },
            create: {
              sellerId: sellerOrder.sellerId,
              pendingBalance: 0,
              availableBalance: 0,
              withdrawnBalance: 0,
            },
          });
        } else {
          // Prepaid: Platform holds customer funds and moves payout to availableBalance
          const bal = await tx.sellerBalance.upsert({
            where: { sellerId: sellerOrder.sellerId },
            update: {
              pendingBalance: newPending,
              availableBalance: { increment: sellerOrder.sellerPayout },
            },
            create: {
              sellerId: sellerOrder.sellerId,
              pendingBalance: 0,
              availableBalance: sellerOrder.sellerPayout,
              withdrawnBalance: 0,
            },
          });

          // Record credit transaction
          await tx.sellerTransaction.create({
            data: {
              sellerBalanceId: bal.id,
              amount: sellerOrder.sellerPayout,
              type: TransactionType.CREDIT,
              referenceId: sellerOrder.id,
              description: `أرباح الطلب #${sellerOrder.order.orderNumber}`,
            },
          });
        }

        // Update payment status to PAID if it was CASH_ON_DELIVERY and PENDING
        if (sellerOrder.order.payment && sellerOrder.order.payment.status === PaymentStatus.PENDING) {
          await tx.payment.update({
            where: { orderId: sellerOrder.orderId },
            data: { status: PaymentStatus.PAID, paidAt: new Date() },
          });
        }

        // Authoritative Platform Commission collection & Outstanding liability handling
        await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
          sellerOrderId: sellerOrder.id,
          orderNumber: sellerOrder.order.orderNumber,
          sellerId: sellerOrder.sellerId,
          commissionAmount: sellerOrder.commissionAmount,
          isCod: isCodOrder,
        });
      } else if (targetStatusStr === 'RETURN_APPROVED' || targetStatusStr === 'REFUNDED') {
        // If order had previously been delivered or in return flow, adjust seller balance and liabilities
        const wasDelivered =
          currentStatus === 'DELIVERED' ||
          currentStatus === 'RETURN_REQUESTED' ||
          currentStatus === 'RETURN_APPROVED' ||
          Boolean(sellerOrder.deliveredAt || (sellerOrder.order as any)?.deliveredAt);
        const sellerBalance = await tx.sellerBalance.findUnique({
          where: { sellerId: sellerOrder.sellerId },
        });

        if (sellerBalance && wasDelivered) {
          // Revert sold count for returned delivered items
          for (const item of sellerOrder.items) {
            if (item.productId) {
              const currentProd = await tx.product.findUnique({
                where: { id: item.productId },
                select: { soldCount: true },
              });
              if (currentProd && currentProd.soldCount > 0) {
                const newSoldCount = Math.max(0, currentProd.soldCount - item.quantity);
                const updatedProduct = await tx.product.update({
                  where: { id: item.productId },
                  data: { soldCount: newSoldCount },
                  select: { id: true, soldCount: true },
                });
                soldCountUpdates.push({
                  productId: updatedProduct.id,
                  soldCount: updatedProduct.soldCount,
                  delta: -item.quantity,
                });
              }
            }
          }

          const deduction = sellerOrder.sellerPayout || 0;
          if (deduction > 0) {
            const currentAvailable = sellerBalance.availableBalance || 0;
            if (currentAvailable >= deduction) {
              await tx.sellerBalance.update({
                where: { sellerId: sellerOrder.sellerId },
                data: { availableBalance: parseFloat((currentAvailable - deduction).toFixed(2)) },
              });
              await tx.sellerTransaction.create({
                data: {
                  sellerBalanceId: sellerBalance.id,
                  amount: -deduction,
                  type: TransactionType.REFUND,
                  referenceId: sellerOrder.id,
                  description: `خصم استرجاع الطلب #${sellerOrder.order.orderNumber}`,
                },
              });
            } else {
              const availableDeduction = Math.max(0, currentAvailable);
              const outstandingDebt = parseFloat((deduction - availableDeduction).toFixed(2));
              await tx.sellerBalance.update({
                where: { sellerId: sellerOrder.sellerId },
                data: {
                  availableBalance: 0,
                  outstandingCommission: { increment: outstandingDebt },
                },
              });
              if (availableDeduction > 0) {
                await tx.sellerTransaction.create({
                  data: {
                    sellerBalanceId: sellerBalance.id,
                    amount: -availableDeduction,
                    type: TransactionType.REFUND,
                    referenceId: sellerOrder.id,
                    description: `خصم استرجاع جزئي للطلب #${sellerOrder.order.orderNumber}`,
                  },
                });
              }
              await tx.sellerOutstanding.create({
                data: {
                  sellerId: sellerOrder.sellerId,
                  sourceType: 'REFUND_LIABILITY',
                  sourceReference: sellerOrder.order.orderNumber,
                  amount: outstandingDebt,
                  paidAmount: 0,
                  remainingAmount: outstandingDebt,
                  currency: 'YER',
                  status: 'OPEN',
                  warningLevel: 'NORMAL',
                  metadata: JSON.stringify({
                    sellerOrderId: sellerOrder.id,
                    orderNumber: sellerOrder.order.orderNumber,
                    totalPayout: deduction,
                    coveredFromBalance: availableDeduction,
                    outstandingDebt,
                    createdAt: new Date().toISOString(),
                  }),
                },
              });
              await tx.sellerTransaction.create({
                data: {
                  sellerBalanceId: sellerBalance.id,
                  amount: -outstandingDebt,
                  type: TransactionType.OUTSTANDING_PAYMENT,
                  referenceId: sellerOrder.id,
                  description: `مديونية معلقة لاسترجاع الطلب #${sellerOrder.order.orderNumber}`,
                },
              });
            }
          }
        }

        // Refund full payment to customer wallet upon return approval if order was paid
        const isPaid = Boolean(
          sellerOrder.order.payment &&
          (sellerOrder.order.payment.status === PaymentStatus.PAID ||
            sellerOrder.order.payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
            sellerOrder.order.payment.method === 'WALLET' ||
            sellerOrder.order.payment.paidAt !== null)
        );

        if (isPaid) {
          const account = await tx.walletAccount.findUnique({
            where: { userId: sellerOrder.order.userId },
          });

          const existingReturnRefund = account ? await tx.walletLedgerEntry.findFirst({
            where: {
              walletAccountId: account.id,
              referenceId: sellerOrder.orderId,
              referenceType: { in: [`SELLER_ORDER_${sellerOrderId}`, `RETURN_${sellerOrderId}`, 'ORDER_CANCEL_REFUND'] },
              type: WalletTxType.ORDER_REFUND,
            },
          }) : null;

          if (!existingReturnRefund) {
            const allSubOrders = await tx.sellerOrder.findMany({
              where: { orderId: sellerOrder.orderId },
              select: {
                id: true,
                status: true,
                subtotal: true,
                deliveryFee: true,
                customerDeliveryCharge: true,
                taxAmount: true,
                voucherDiscountAmount: true,
              },
            });

            const isSingleSubOrder = allSubOrders.length <= 1;
            const otherSubOrders = allSubOrders.filter((s) => s.id !== sellerOrder.id);
            const allOthersTerminated = otherSubOrders.every((s) => {
              const st = String(s.status);
              return (
                st.startsWith('CANCELLED_') ||
                st === 'REJECTED_BY_SELLER' ||
                st === 'CANCELLED' ||
                st === 'RETURN_APPROVED' ||
                st === 'RETURNED' ||
                st === 'REFUNDED'
              );
            });

            const priorRefundLedgers = await tx.walletLedgerEntry.findMany({
              where: {
                referenceId: sellerOrder.orderId,
                type: WalletTxType.ORDER_REFUND,
                direction: 'CREDIT',
              },
              select: { amount: true },
            });
            const priorRefundTotal = priorRefundLedgers.reduce((sum: number, l: any) => sum + (l.amount || 0), 0);
            const fullOrderPayment = Number(sellerOrder.order.total || 0);
            const maxRemainingToRefund = Math.max(0, parseFloat((fullOrderPayment - priorRefundTotal).toFixed(2)));

            let retRefundAmt = 0;
            if (isSingleSubOrder || allOthersTerminated) {
              retRefundAmt = maxRemainingToRefund;
            } else {
              const custDelivery = sellerOrder.customerDeliveryCharge ?? sellerOrder.deliveryFee ?? 0;
              const custTax = sellerOrder.taxAmount ?? 0;
              const custDiscount = sellerOrder.voucherDiscountAmount ?? 0;
              const subOrderFullAmount = Math.max(
                0,
                parseFloat((sellerOrder.subtotal + custDelivery + custTax - custDiscount).toFixed(2))
              );
              retRefundAmt = Math.min(subOrderFullAmount, maxRemainingToRefund);
            }

            if (retRefundAmt > 0) {
              await CustomerWalletService.creditForOrderRefund(
                {
                  customerId: sellerOrder.order.userId,
                  orderId: sellerOrder.orderId,
                  orderNumber: sellerOrder.order.orderNumber,
                  amount: retRefundAmt,
                  reason: reason || 'موافقة المتجر على طلب الإرجاع واسترداد كامل المبلغ للمحفظة',
                  referenceType: `SELLER_ORDER_${sellerOrderId}`,
                },
                tx
              );

              const isOrderFullyRefunded = (maxRemainingToRefund - retRefundAmt) <= 0.01;
              await tx.payment.update({
                where: { orderId: sellerOrder.orderId },
                data: {
                  status: isOrderFullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
                },
              });

              if (isOrderFullyRefunded) {
                await tx.sellerOrder.update({
                  where: { id: sellerOrder.id },
                  data: { status: SellerOrderStatus.REFUNDED },
                });
                updatedSellerOrder.status = SellerOrderStatus.REFUNDED;

                await tx.returnRequest.updateMany({
                  where: { orderId: sellerOrder.orderId, status: ReturnRequestStatus.PENDING },
                  data: {
                    status: ReturnRequestStatus.APPROVED,
                    refundAmount: retRefundAmt,
                    resolvedBy: changedBy,
                    resolvedAt: new Date(),
                  },
                });

                await tx.refundRequest.updateMany({
                  where: {
                    orderId: sellerOrder.orderId,
                    status: { in: [RefundStatus.SUBMITTED, RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_ACCEPTED, RefundStatus.REQUESTED] },
                  },
                  data: {
                    status: RefundStatus.REFUND_COMPLETED,
                    resolvedAt: new Date(),
                  },
                });
              }
            }
          }
        }
      }

      // 3. Record Order Status History
      await tx.orderStatusHistory.create({
        data: {
          orderId: sellerOrder.orderId,
          sellerOrderId: sellerOrder.id,
          fromStatus: currentStatus,
          toStatus: targetStatusStr,
          status: targetStatus as any,
          changedBy,
          changedByRole,
          reason,
          metadata: metadata ? JSON.stringify(metadata) : null,
          note: note || `تغيير الحالة إلى ${targetStatusStr}`,
        },
      });

      // 4. Record Audit Log
      await tx.auditLog.create({
        data: {
          userId: changedBy,
          action: `SELLER_ORDER_${targetStatusStr}`,
          resource: 'seller_orders',
          details: JSON.stringify({
            sellerOrderId: sellerOrder.id,
            orderId: sellerOrder.orderId,
            fromStatus: currentStatus,
            toStatus: targetStatusStr,
            role: changedByRole,
            reason,
          }),
        },
      });

      // 5. Sync parent Order status
      const parentStatus = await this.syncParentOrderStatus(sellerOrder.orderId, tx);

      // If all seller orders are cancelled, release slot & release active promotion reservations (§45)
      if (parentStatus && String(parentStatus).startsWith('CANCELLED_')) {
        await tx.deliverySlotBooking.deleteMany({
          where: { orderId: sellerOrder.orderId },
        });

        await ShippingPromotionBudgetService.revertUsageAndBudget(tx, {
          orderId: sellerOrder.orderId,
          reason: reason || `Cancelled by ${changedByRole}`,
        });
      }

      return {
        sellerOrder: updatedSellerOrder,
        parentStatus,
        soldCountUpdates,
      };
    }, {
      maxWait: 10000,
      timeout: 30000,
    });

    // 6. Realtime WebSocket Broadcast
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitOrderStatusUpdate({
          orderId: sellerOrder.orderId,
          orderNumber: sellerOrder.order?.orderNumber || '',
          displayOrderNumber: sellerOrder.order?.displayOrderNumber || undefined,
          sellerOrderId: sellerOrder.id,
          sellerOrderNumber: sellerOrder.sellerOrderNumber || undefined,
          status: targetStatusStr,
          parentStatus: result.parentStatus || undefined,
          version: (result.sellerOrder as any)?.updatedAt ? new Date((result.sellerOrder as any).updatedAt).getTime() : Date.now(),
          timestamp: new Date().toISOString(),
          changedByRole,
          customerUserId: sellerOrder.order?.userId,
          sellerUserIds: sellerOrder.seller?.userId ? [sellerOrder.seller.userId] : [],
        });

        // Broadcast product sold count updates to all connected clients
        if (result.soldCountUpdates && result.soldCountUpdates.length > 0) {
          for (const upd of result.soldCountUpdates) {
            socket.emitGlobal('product:sold_count_updated', {
              productId: upd.productId,
              soldCount: upd.soldCount,
              delta: upd.delta,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Invalidate Redis caches for updated products and store
        if (result.soldCountUpdates && result.soldCountUpdates.length > 0) {
          try {
            if (sellerOrder.sellerId) {
              const store = await prisma.store.findFirst({
                where: { sellerId: sellerOrder.sellerId },
                select: { id: true, slug: true },
              });
              if (store) {
                await redis.del(`storefront:${store.slug}`);
                await redis.del(`storefront:${store.id}`);
              }
            }
            for (const upd of result.soldCountUpdates) {
              await redis.del(`product:${upd.productId}`);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 7. Centralized SOUQNAA Notification Platform Dispatch
    try {
      const orderEvtMap: Record<string, any> = {
        CONFIRMED: 'ORDER_CONFIRMED',
        PROCESSING: 'ORDER_PROCESSING',
        READY_TO_SHIP: 'ORDER_READY_TO_SHIP',
        SHIPPED: 'ORDER_SHIPPED',
        DELIVERED: 'ORDER_DELIVERED',
        CANCELLED_BY_CUSTOMER: 'ORDER_CANCELLED',
        CANCELLED_BY_SELLER: 'ORDER_CANCELLED',
        REJECTED_BY_SELLER: 'ORDER_CANCELLED',
        CANCELLED_BY_ADMIN: 'ORDER_CANCELLED',
        CANCELLED: 'ORDER_CANCELLED',
      };
      const eventType = orderEvtMap[targetStatusStr];
      if (eventType && sellerOrder.order?.userId) {
        notificationDispatcher.dispatch(
          NotificationEventFactory.orderEvent({
            eventType,
            recipientId: sellerOrder.order.userId,
            orderId: sellerOrder.orderId,
            orderNumber: sellerOrder.order.orderNumber,
            totalAmount: Number(sellerOrder.order.subtotal || 0),
            cancelReason: reason,
          })
        ).catch(() => {});
      }
    } catch (_) {}

    // 8. SOUQNAA Coins Purchase Rewards trigger (§19, §20)
    if (result.parentStatus === OrderStatus.DELIVERED && sellerOrder.order?.userId) {
      try {
        await RewardsEarningService.onOrderDelivered({
          orderId: sellerOrder.orderId,
          userId: sellerOrder.order.userId,
          orderNumber: sellerOrder.order.orderNumber,
          subtotal: sellerOrder.order.subtotal,
          sellerId: sellerOrder.sellerId,
        });
      } catch (err) {
        console.error('[Rewards] Failed to award purchase coins on delivery:', err);
      }

      // SOUQNAA Customer Membership & VIP Tiers evaluation on order delivery
      try {
        await MembershipEligibilityService.onOrderDelivered({
          userId: sellerOrder.order.userId,
          orderId: sellerOrder.orderId,
          subtotal: sellerOrder.order.subtotal,
        });
      } catch (err) {
        console.error('[Membership] Failed to evaluate membership on delivery:', err);
      }
    }

    // 9. SOUQNAA Coins Cancellation Reversal & Coin Refund trigger (§21)
    if (result.parentStatus && String(result.parentStatus).startsWith('CANCELLED_')) {
      try {
        await RewardsReversalService.onOrderCancelled({
          orderId: sellerOrder.orderId,
          cancelledBy: changedBy,
          reason,
        });
      } catch (err) {
        console.error('[Rewards] Failed to reverse/refund coins on cancellation:', err);
      }

      // SOUQNAA Customer Membership & VIP Tiers update on cancellation
      if (sellerOrder.order?.userId) {
        try {
          await MembershipEligibilityService.onOrderCancelled({
            userId: sellerOrder.order.userId,
            orderId: sellerOrder.orderId,
            subtotal: sellerOrder.order.subtotal,
          });
        } catch (err) {
          console.error('[Membership] Failed to update membership on cancellation:', err);
        }
      }
    }

    // 10. SOUQNAA Seller Performance Score Engine event ingestion
    try {
      const { SellerPerformanceEventService } = await import('../seller-performance/seller-performance-event.service');
      if (targetStatusStr === 'DELIVERED') {
        SellerPerformanceEventService.recordEvent({
          sellerId: sellerOrder.sellerId,
          eventType: 'ORDER_COMPLETED',
          entityId: sellerOrder.id,
        }).catch(() => {});
      } else if (targetStatusStr === 'CANCELLED_BY_SELLER' || targetStatusStr === 'REJECTED_BY_SELLER') {
        SellerPerformanceEventService.recordEvent({
          sellerId: sellerOrder.sellerId,
          eventType: 'ORDER_CANCELLED',
          entityId: sellerOrder.id,
          payload: { reason, changedByRole },
        }).catch(() => {});
      } else if (['READY_TO_SHIP', 'SHIPPED'].includes(targetStatusStr)) {
        SellerPerformanceEventService.recordEvent({
          sellerId: sellerOrder.sellerId,
          eventType: 'ORDER_FULFILLMENT_UPDATED',
          entityId: sellerOrder.id,
        }).catch(() => {});
      }
    } catch (_) {}

    return result;
  }

  /**
   * Execute direct cancellation / status transition on the whole Order (e.g. customer cancels PENDING or admin cancels order).
   */
  static async transitionOrder(params: {
    orderId: string;
    targetStatus: OrderStatus;
    changedBy: string;
    changedByRole: 'CUSTOMER' | 'SELLER' | 'ADMIN' | 'SYSTEM';
    reason?: string;
    note?: string;
    metadata?: Record<string, any>;
  }) {
    const {
      orderId,
      targetStatus,
      changedBy,
      changedByRole,
      reason,
      note,
      metadata,
    } = params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        sellerOrders: {
          include: {
            items: true,
            seller: { select: { id: true, userId: true } },
          },
        },
        payment: true,
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const currentStatus = order.status as string;
    const targetStatusStr = targetStatus as string;

    if (!this.isValidTransition(currentStatus, targetStatusStr)) {
      throw new AppError(
        `لا يمكن تحويل حالة الطلب من [${currentStatus}] إلى [${targetStatusStr}]`,
        422
      );
    }

    const isCancellationOrRejection =
      targetStatusStr.startsWith('CANCELLED_') || targetStatusStr === 'REJECTED_BY_SELLER';

    const result = await prisma.$transaction(async (tx) => {
      const soldCountUpdates: Array<{ productId: string; soldCount: number; delta: number }> = [];

      // 1. Update Order Status
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: targetStatus,
          ...(targetStatusStr === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        },
      });

      // 2. Cascade status to all child SellerOrders
      for (const so of order.sellerOrders) {
        const soWasDelivered = so.status === 'DELIVERED';
        await tx.sellerOrder.update({
          where: { id: so.id },
          data: {
            status: targetStatus as any,
            ...(targetStatusStr === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
          },
        });

        if (isCancellationOrRejection) {
          if (currentStatus === 'DELIVERED' || soWasDelivered) {
            for (const item of so.items) {
              if (item.productId) {
                const currentProd = await tx.product.findUnique({
                  where: { id: item.productId },
                  select: { soldCount: true },
                });
                if (currentProd && currentProd.soldCount > 0) {
                  const newSoldCount = Math.max(0, currentProd.soldCount - item.quantity);
                  const updatedProduct = await tx.product.update({
                    where: { id: item.productId },
                    data: { soldCount: newSoldCount },
                    select: { id: true, soldCount: true },
                  });
                  soldCountUpdates.push({
                    productId: updatedProduct.id,
                    soldCount: updatedProduct.soldCount,
                    delta: -item.quantity,
                  });
                }
              }
            }
          }

          // Release reserved inventory
          for (const item of so.items) {
            if (item.variantId) {
              await tx.productVariant.update({
                where: { id: item.variantId },
                data: { stockQuantity: { increment: item.quantity } },
              });
            } else {
              await tx.inventory.update({
                where: { productId: item.productId },
                data: { reserved: { decrement: item.quantity } },
              });
            }
          }

          // Revert pending balance safely without going below 0
          const currentBal = await tx.sellerBalance.findUnique({
            where: { sellerId: so.sellerId },
          });
          if (currentBal) {
            await tx.sellerBalance.update({
              where: { id: currentBal.id },
              data: { pendingBalance: Math.max(0, currentBal.pendingBalance - so.sellerPayout) },
            });
          }
        }

        if (isCancellationOrRejection) {
          // §SCHED-3: Release delivery slot booking
          await tx.deliverySlotBooking.deleteMany({
            where: { orderId: order.id },
          });

          // Revert shipping promotion usage and budget on cancellation
          await ShippingPromotionBudgetService.revertUsageAndBudget(tx, {
            orderId: order.id,
            reason: reason || (targetStatusStr === 'CANCELLED_BY_CUSTOMER' ? 'إلغاء الطلب من قبل العميل' : 'إلغاء الطلب'),
          });
        } else if (targetStatusStr === 'DELIVERED') {
          // Permanently deduct inventory & credit seller & increment sold count
          // IDEMPOTENCY GUARD: Only increment if this child seller order was NOT already DELIVERED
          if (!soWasDelivered) {
            for (const item of so.items) {
              if (!item.variantId) {
                await tx.inventory.update({
                  where: { productId: item.productId },
                  data: {
                    quantity: { decrement: item.quantity },
                    reserved: { decrement: item.quantity },
                  },
                });
              }
              if (item.productId) {
                const updatedProduct = await tx.product.update({
                  where: { id: item.productId },
                  data: {
                    soldCount: { increment: item.quantity },
                  },
                  select: { id: true, soldCount: true },
                });
                soldCountUpdates.push({
                  productId: updatedProduct.id,
                  soldCount: updatedProduct.soldCount,
                  delta: item.quantity,
                });
              }
            }
          }

          const isCodOrder = order.payment?.method === 'CASH_ON_DELIVERY';
          const currentBal = await tx.sellerBalance.findUnique({
            where: { sellerId: so.sellerId },
          });
          const newPending = currentBal ? Math.max(0, currentBal.pendingBalance - so.sellerPayout) : 0;

          if (isCodOrder) {
            // COD: Cash is collected directly in-person by seller/courier.
            // Platform does not credit availableBalance to avoid double payout.
            await tx.sellerBalance.upsert({
              where: { sellerId: so.sellerId },
              update: { pendingBalance: newPending },
              create: {
                sellerId: so.sellerId,
                pendingBalance: 0,
                availableBalance: 0,
                withdrawnBalance: 0,
              },
            });
          } else {
            // Prepaid: Platform holds customer funds, move to availableBalance
            const bal = await tx.sellerBalance.upsert({
              where: { sellerId: so.sellerId },
              update: {
                pendingBalance: newPending,
                availableBalance: { increment: so.sellerPayout },
              },
              create: {
                sellerId: so.sellerId,
                pendingBalance: 0,
                availableBalance: so.sellerPayout,
                withdrawnBalance: 0,
              },
            });

            await tx.sellerTransaction.create({
              data: {
                sellerBalanceId: bal.id,
                amount: so.sellerPayout,
                type: TransactionType.CREDIT,
                referenceId: so.id,
                description: `أرباح الطلب #${order.orderNumber}`,
              },
            });
          }

          // Authoritative Platform Commission collection & Outstanding liability handling
          await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
            sellerOrderId: so.id,
            orderNumber: order.orderNumber,
            sellerId: so.sellerId,
            commissionAmount: so.commissionAmount,
            isCod: isCodOrder,
          });
        }
      }

      if (targetStatusStr === 'DELIVERED' && order.payment && order.payment.status === PaymentStatus.PENDING) {
        await tx.payment.update({
          where: { orderId: order.id },
          data: { status: PaymentStatus.PAID, paidAt: new Date() },
        });
      }

      // 3. Handle Payment & Direct Wallet Refund
      if (isCancellationOrRejection) {
        const isPaid = Boolean(
          order.payment &&
          (order.payment.status === PaymentStatus.PAID ||
            order.payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
            order.payment.method === 'WALLET' ||
            order.payment.paidAt !== null)
        );
        if (isPaid) {
          const priorRefundLedgers = await tx.walletLedgerEntry.findMany({
            where: {
              referenceId: order.id,
              type: WalletTxType.ORDER_REFUND,
              direction: 'CREDIT',
            },
            select: { amount: true },
          });
          const priorRefundTotal = priorRefundLedgers.reduce((sum: number, l: any) => sum + (l.amount || 0), 0);
          const fullOrderPayment = Number(order.total || 0);
          const remainingToRefund = Math.max(0, parseFloat((fullOrderPayment - priorRefundTotal).toFixed(2)));

          if (remainingToRefund > 0) {
            await CustomerWalletService.creditForOrderRefund(
              {
                customerId: order.userId,
                orderId: order.id,
                orderNumber: order.orderNumber,
                amount: remainingToRefund,
                reason: reason || (targetStatusStr === 'CANCELLED_BY_CUSTOMER' ? 'إلغاء الطلب من قبل العميل واسترداد كامل المبلغ للمحفظة' : 'إلغاء الطلب واسترداد كامل المبلغ للمحفظة'),
                referenceType: 'ORDER_CANCEL_REFUND',
              },
              tx
            );
          }

          await tx.payment.update({
            where: { orderId: order.id },
            data: { status: PaymentStatus.REFUNDED },
          });
        }
      } else if (targetStatusStr === 'DELIVERED') {
        if (order.payment && order.payment.status === PaymentStatus.PENDING) {
          await tx.payment.update({
            where: { orderId: order.id },
            data: { status: PaymentStatus.PAID, paidAt: new Date() },
          });
        }
      }

      // 4. Log Status History
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: currentStatus,
          toStatus: targetStatusStr,
          status: targetStatus,
          changedBy,
          changedByRole,
          reason,
          metadata: metadata ? JSON.stringify(metadata) : null,
          note: note || `تغيير الحالة إلى ${targetStatusStr}`,
        },
      });

      // 5. Log Audit Trail
      await tx.auditLog.create({
        data: {
          userId: changedBy,
          action: `ORDER_${targetStatusStr}`,
          resource: 'orders',
          details: JSON.stringify({
            orderId: order.id,
            fromStatus: currentStatus,
            toStatus: targetStatusStr,
            role: changedByRole,
            reason,
          }),
        },
      });

      return {
        updatedOrder,
        soldCountUpdates,
      };
    }, {
      maxWait: 10000,
      timeout: 30000,
    });

    // 6. Broadcast via Socket
    try {
      const socket = SocketService.get();
      if (socket) {
        const sellerUserIds: string[] = order.sellerOrders
          .map((so: any) => so.seller?.userId)
          .filter((uid: any): uid is string => Boolean(uid));

        socket.emitOrderStatusUpdate({
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber || undefined,
          status: targetStatusStr,
          parentStatus: targetStatusStr,
          version: (result.updatedOrder as any)?.updatedAt ? new Date((result.updatedOrder as any).updatedAt).getTime() : Date.now(),
          timestamp: new Date().toISOString(),
          changedByRole,
          customerUserId: order.userId,
          sellerUserIds,
          extra: {
            customerConfirmed: targetStatusStr === 'DELIVERED' && changedByRole === 'CUSTOMER',
          },
        });

        // Broadcast product sold count updates to all connected clients
        if (result.soldCountUpdates && result.soldCountUpdates.length > 0) {
          for (const upd of result.soldCountUpdates) {
            socket.emitGlobal('product:sold_count_updated', {
              productId: upd.productId,
              soldCount: upd.soldCount,
              delta: upd.delta,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    } catch (_) {}

    // 6.5. Dispatch Notifications for Whole Order Transitions
    try {
      if (targetStatusStr === 'DELIVERED' && changedByRole === 'CUSTOMER') {
        // Customer confirmed order received -> Notify each seller (Push + In-App)
        for (const so of order.sellerOrders) {
          const sUserId = so.seller?.userId;
          if (sUserId) {
            notificationDispatcher.dispatch(
              NotificationEventFactory.sellerOrderReceivedEvent({
                recipientId: sUserId,
                orderId: order.id,
                orderNumber: so.sellerOrderNumber || order.orderNumber,
                sellerOrderId: so.id,
                totalAmount: Number(so.sellerPayout || 0),
              })
            ).catch((err) => {
              console.error('[Orders] Failed to dispatch seller order received notification:', err);
            });
          }
        }
      } else if (targetStatusStr === 'DELIVERED' && changedByRole !== 'CUSTOMER') {
        // Order delivered by seller/courier/admin -> Notify customer
        if (order.userId) {
          notificationDispatcher.dispatch(
            NotificationEventFactory.orderEvent({
              eventType: 'ORDER_DELIVERED',
              recipientId: order.userId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              totalAmount: Number(order.total || 0),
            })
          ).catch(() => {});
        }
      } else if (targetStatusStr.startsWith('CANCELLED_')) {
        if (changedByRole === 'CUSTOMER') {
          // Cancelled by customer -> Notify each seller
          for (const so of order.sellerOrders) {
            const sUserId = so.seller?.userId;
            if (sUserId) {
              notificationDispatcher.dispatch(
                NotificationEventFactory.sellerOrderCancelledEvent({
                  recipientId: sUserId,
                  orderId: order.id,
                  orderNumber: so.sellerOrderNumber || order.orderNumber,
                  sellerOrderId: so.id,
                  reason,
                })
              ).catch(() => {});
            }
          }
        } else {
          // Cancelled by seller/admin -> Notify customer
          if (order.userId) {
            notificationDispatcher.dispatch(
              NotificationEventFactory.orderEvent({
                eventType: 'ORDER_CANCELLED',
                recipientId: order.userId,
                orderId: order.id,
                orderNumber: order.orderNumber,
                totalAmount: Number(order.total || 0),
                cancelReason: reason,
              })
            ).catch(() => {});
          }
        }
      }
    } catch (notifErr) {
      console.error('[Orders] Whole order transition notification error:', notifErr);
    }

    // 7. SOUQNAA Coins Purchase Rewards trigger (§19, §20)
    if (targetStatusStr === 'DELIVERED' && order.userId) {
      try {
        await RewardsEarningService.onOrderDelivered({
          orderId: order.id,
          userId: order.userId,
          orderNumber: order.orderNumber,
          subtotal: order.subtotal,
        });
      } catch (err) {
        console.error('[Rewards] Failed to award purchase coins on order delivery:', err);
      }

      // SOUQNAA Customer Membership & VIP Tiers evaluation on direct order delivery
      try {
        await MembershipEligibilityService.onOrderDelivered({
          userId: order.userId,
          orderId: order.id,
          subtotal: order.subtotal,
        });
      } catch (err) {
        console.error('[Membership] Failed to evaluate membership on direct delivery:', err);
      }
    }

    // 8. SOUQNAA Coins Cancellation Reversal & Coin Refund trigger (§21)
    if (isCancellationOrRejection) {
      try {
        await RewardsReversalService.onOrderCancelled({
          orderId: order.id,
          cancelledBy: changedBy,
          reason,
        });
      } catch (err) {
        console.error('[Rewards] Failed to reverse/refund coins on order cancellation:', err);
      }

      // SOUQNAA Customer Membership & VIP Tiers update on direct cancellation
      if (order.userId) {
        try {
          await MembershipEligibilityService.onOrderCancelled({
            userId: order.userId,
            orderId: order.id,
            subtotal: order.subtotal,
          });
        } catch (err) {
          console.error('[Membership] Failed to update membership on direct cancellation:', err);
        }
      }
    }

    return result.updatedOrder;
  }
}
