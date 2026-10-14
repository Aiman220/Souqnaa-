import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import {
  OrderStatus,
  SellerOrderStatus,
  PaymentStatus,
  TransactionType,
  CancellationRequestStatus,
  ReturnRequestStatus,
  NotificationType,
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

        // Revert seller pending balance
        await tx.sellerBalance.updateMany({
          where: { sellerId: sellerOrder.sellerId },
          data: { pendingBalance: { decrement: sellerOrder.sellerPayout } },
        });

        // If order was PAID -> directly credit back customer's local wallet
        if (sellerOrder.order.payment && sellerOrder.order.payment.status === PaymentStatus.PAID) {
          const refundAmount = sellerOrder.subtotal;
          await CustomerWalletService.creditForOrderRefund(
            {
              customerId: sellerOrder.order.userId,
              orderId: sellerOrder.orderId,
              orderNumber: sellerOrder.order.orderNumber,
              amount: refundAmount,
              reason: reason || (targetStatusStr === 'REJECTED_BY_SELLER' ? 'رفض الطلب من قبل المتجر' : 'إلغاء الطلب من قبل المتجر'),
              referenceType: `SELLER_ORDER_${sellerOrderId}`,
            },
            tx
          );

          await tx.payment.update({
            where: { orderId: sellerOrder.orderId },
            data: { status: PaymentStatus.REFUNDED },
          });
        }
      } else if (targetStatusStr === 'DELIVERED') {
        // Permanent stock deduction
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
        }

        // Move seller payout from pendingBalance to availableBalance
        const bal = await tx.sellerBalance.upsert({
          where: { sellerId: sellerOrder.sellerId },
          update: {
            pendingBalance: { decrement: sellerOrder.sellerPayout },
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

        // Update payment status to PAID if it was CASH_ON_DELIVERY and PENDING
        const isCodOrder = sellerOrder.order.payment?.method === 'CASH_ON_DELIVERY';
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
        // If order had previously been delivered, adjust seller balance and liabilities
        const wasDelivered = currentStatus === 'DELIVERED';
        const sellerBalance = await tx.sellerBalance.findUnique({
          where: { sellerId: sellerOrder.sellerId },
        });

        if (sellerBalance && wasDelivered) {
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
      };
    });

    // 6. Realtime WebSocket Broadcast
    try {
      const payload = {
        orderId: sellerOrder.orderId,
        orderNumber: sellerOrder.order?.orderNumber,
        sellerOrderId: sellerOrder.id,
        status: targetStatusStr,
        parentStatus: result.parentStatus,
        changedByRole,
      };
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal('order:status', payload);
        const specificEvent = `order:${targetStatusStr.toLowerCase()}`;
        socket.emitGlobal(specificEvent, payload);
        if (sellerOrder.order?.userId) {
          socket.emitToUser(sellerOrder.order.userId, 'order:status', payload);
          socket.emitToUser(sellerOrder.order.userId, specificEvent, payload);
        }
      }
    } catch (_) {}

    // 7. Centralized SOUQNAA Notification Platform Dispatch
    try {
      const orderEvtMap: Record<string, any> = {
        CONFIRMED: 'ORDER_CONFIRMED',
        PROCESSING: 'ORDER_PROCESSING',
        SHIPPED: 'ORDER_SHIPPED',
        DELIVERED: 'ORDER_DELIVERED',
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
        sellerOrders: { include: { items: true } },
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
        await tx.sellerOrder.update({
          where: { id: so.id },
          data: {
            status: targetStatus as any,
            ...(targetStatusStr === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
          },
        });

        if (isCancellationOrRejection) {
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

          // Revert pending balance
          await tx.sellerBalance.updateMany({
            where: { sellerId: so.sellerId },
            data: { pendingBalance: { decrement: so.sellerPayout } },
          });
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
          // Permanently deduct inventory & credit seller
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
          }

          const bal = await tx.sellerBalance.upsert({
            where: { sellerId: so.sellerId },
            update: {
              pendingBalance: { decrement: so.sellerPayout },
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

          // Authoritative Platform Commission collection & Outstanding liability handling
          const isCodOrder = order.payment?.method === 'CASH_ON_DELIVERY';
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
        if (order.payment && order.payment.status === PaymentStatus.PAID) {
          await CustomerWalletService.creditForOrderRefund(
            {
              customerId: order.userId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              amount: order.total,
              reason: reason || (targetStatusStr === 'CANCELLED_BY_CUSTOMER' ? 'إلغاء الطلب من قبل العميل' : 'إلغاء الطلب واسترداد القيمة للمحفظة'),
              referenceType: 'ORDER_CANCEL_REFUND',
            },
            tx
          );

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

      return updatedOrder;
    });

    // 6. Broadcast via Socket
    try {
      SocketService.get()?.emitGlobal('order:status', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: targetStatusStr,
        changedByRole,
      });
    } catch (_) {}

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

    return result;
  }
}
