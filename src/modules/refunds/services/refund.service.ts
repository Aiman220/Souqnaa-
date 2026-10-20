import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { AppError } from '../../../middleware/error.middleware';
import {
  RefundStatus,
  RefundActorType,
  RefundMethod,
  RefundDestination,
  FinancialTransactionType,
  NotificationType,
  PaymentStatus,
  PaymentMethodType,
  TransactionType,
  DisputeStatus,
  OrderStatus,
  SellerOrderStatus,
  ReturnRequestStatus,
} from '@prisma/client';
import { RefundStateMachine } from '../refund.state-machine';
import { RefundEligibilityService } from './refund-eligibility.service';
import { CustomerWalletService } from '../../wallet/customer-wallet.service';
import { ManualWalletTransferService } from './manual-wallet-transfer.service';
import { SocketService } from '../../../services/websocket/socket.service';
import { RewardsReversalService } from '../../rewards/services/rewards-reversal.service';
import { NotificationEventFactory } from '../../notifications/events/domain-events';
import { notificationDispatcher } from '../../notifications/services/notification-dispatcher';
import { TaxEngine } from '../../tax/tax.service';
import { MembershipEligibilityService } from '../../membership/membership-eligibility.service';

export interface CreateRefundInput {
  orderId: string;
  customerId: string;
  reasonId?: string;
  reasonText?: string;
  description?: string;
  customerNote?: string;
  destination?: RefundDestination;
  walletProvider?: string;
  walletNumber?: string;
  walletHolderName?: string;
  items: Array<{
    orderItemId: string;
    quantity: number;
    requestedAmount?: number;
  }>;
  evidence?: Array<{
    fileUrl: string;
    fileType?: string;
    fileSize?: number;
    mimeType?: string;
    description?: string;
  }>;
}

export class RefundService {
  /**
   * 1. Customer creates a refund request with authoritative calculation.
   */
  static async createRefundRequest(input: CreateRefundInput) {
    const {
      orderId,
      customerId,
      reasonId,
      description,
      customerNote,
      destination = RefundDestination.CUSTOMER_WALLET,
      walletProvider,
      walletNumber,
      walletHolderName,
      items,
      evidence,
    } = input;

    // Resolve reason text
    let resolvedReasonText = input.reasonText || '';
    if (reasonId) {
      const dbReason = await prisma.refundReason.findUnique({ where: { id: reasonId } });
      if (dbReason) {
        resolvedReasonText = dbReason.nameAr;
        if (dbReason.requiresDescription && (!description || description.trim().length < 5)) {
          throw new AppError('يرجى تقديم شرح تفصيلي لسبب الاسترجاع المحدد', 400);
        }
      }
    }

    if (!resolvedReasonText && !description) {
      throw new AppError('سبب وتفاصيل طلب الاسترجاع مطلوبة', 400);
    }

    // Validate requested items and compute authoritative refundable amounts
    const { order, sellerId, sellerOrderId, validatedItems, totalAuthoritativeAmount } =
      await RefundEligibilityService.validateRequestedItems(orderId, customerId, items);

    // Validate evidence
    const maxFiles = 10;
    if (evidence && evidence.length > maxFiles) {
      throw new AppError(`لا يمكن إرفاق أكثر من ${maxFiles} ملفات كأدلة`, 400);
    }

    // Check policy auto-escalate threshold
    let initialStatus: RefundStatus = RefundStatus.UNDER_SELLER_REVIEW;
    try {
      const policy = await prisma.refundPolicyConfig.findFirst();
      if (policy && policy.adminEscalationEnabled && policy.dualApprovalThresholdYER) {
        if (totalAuthoritativeAmount >= policy.dualApprovalThresholdYER) {
          initialStatus = RefundStatus.ADMIN_REVIEW;
        }
      }
    } catch (_) {}

    const refundNumber = `RF-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

    const refund = await prisma.$transaction(async (tx) => {
      const req = await tx.refundRequest.create({
        data: {
          refundNumber,
          orderId: order.id,
          sellerOrderId,
          customerId,
          sellerId,
          status: initialStatus,
          reasonId: reasonId || null,
          reasonText: resolvedReasonText || 'طلب استرجاع',
          description: description || null,
          requestedAmount: totalAuthoritativeAmount,
          currency: order.currency || 'YER',
          destination,
          customerNote: customerNote || null,
          items: {
            create: validatedItems.map((v) => ({
              orderItemId: v.orderItemId,
              productId: v.productId,
              variantId: v.variantId || null,
              quantity: v.quantity,
              requestedAmount: v.authoritativeRefundAmount,
            })),
          },
          evidence:
            evidence && evidence.length > 0
              ? {
                  create: evidence.map((e) => ({
                    uploadedBy: customerId,
                    uploadedByRole: RefundActorType.CUSTOMER,
                    fileUrl: e.fileUrl,
                    fileType: e.fileType || 'image/jpeg',
                    fileSize: e.fileSize || 0,
                    mimeType: e.mimeType || 'image/jpeg',
                    description: e.description || null,
                  })),
                }
              : undefined,
          statusHistory: {
            create: [
              {
                fromStatus: null,
                toStatus: initialStatus,
                changedBy: customerId,
                actorType: RefundActorType.CUSTOMER,
                reason: 'تقديم طلب الاسترجاع من قبل العميل',
              },
            ],
          },
        },
        include: {
          items: true,
          evidence: true,
          statusHistory: true,
        },
      });

      // If manual transfer selected, create initial manual transfer request
      if (destination === RefundDestination.MANUAL_WALLET_TRANSFER && walletProvider && walletNumber) {
        await ManualWalletTransferService.createTransferRequest(
          {
            refundId: req.id,
            customerId,
            walletProvider,
            walletNumber,
            holderName: walletHolderName,
            amount: totalAuthoritativeAmount,
            currency: order.currency || 'YER',
          },
          tx
        );
      }

      // Synchronize Order and SellerOrder status to RETURN_REQUESTED (Awaiting seller review)
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.RETURN_REQUESTED },
      });

      if (sellerOrderId) {
        await tx.sellerOrder.update({
          where: { id: sellerOrderId },
          data: { status: SellerOrderStatus.RETURN_REQUESTED },
        });
      } else {
        await tx.sellerOrder.updateMany({
          where: { orderId: order.id },
          data: { status: SellerOrderStatus.RETURN_REQUESTED },
        });
      }

      // Record ReturnRequest with PENDING status for seller review
      await tx.returnRequest.create({
        data: {
          orderId: order.id,
          sellerOrderId: sellerOrderId || null,
          customerId,
          reason: resolvedReasonText || 'طلب استرجاع',
          description: description || null,
          status: ReturnRequestStatus.PENDING,
          refundAmount: totalAuthoritativeAmount,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          sellerOrderId: sellerOrderId || null,
          fromStatus: order.status,
          toStatus: 'RETURN_REQUESTED',
          status: OrderStatus.RETURN_REQUESTED,
          changedBy: customerId,
          changedByRole: 'CUSTOMER',
          reason: resolvedReasonText || 'طلب استرجاع',
          note: `تم تقديم طلب الاسترجاع وهو قيد مراجعة المتجر: ${resolvedReasonText || 'طلب استرجاع'}${description ? ` - ${description}` : ''}`,
        },
      });

      return req;
    });

    // Notify seller and customer via centralized SOUQNAA Notification Platform
    try {
      const sellerUser = await prisma.seller.findUnique({
        where: { id: sellerId },
        select: { userId: true },
      });
      if (sellerUser) {
        notificationDispatcher.dispatch(
          NotificationEventFactory.refundEvent({
            eventType: 'REFUND_REQUESTED',
            recipientId: sellerUser.userId,
            refundId: refund.id,
            refundNumber: refund.refundNumber,
            orderId: order.id,
            orderNumber: order.orderNumber,
            amount: Number(totalAuthoritativeAmount),
            isSeller: true,
          })
        ).catch(() => {});
      }

      notificationDispatcher.dispatch(
        NotificationEventFactory.refundEvent({
          eventType: 'REFUND_REQUESTED',
          recipientId: customerId,
          refundId: refund.id,
          refundNumber: refund.refundNumber,
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: Number(totalAuthoritativeAmount),
          isSeller: false,
        })
      ).catch(() => {});

      // Realtime broadcast to all connected apps (Customer, Seller, Admin)
      SocketService.get()?.emitGlobal('REFUND_CREATED', {
        refundId: refund.id,
        orderId: order.id,
        status: refund.status,
      });
      SocketService.get()?.emitGlobal('order:return_requested', {
        orderId: order.id,
        refundId: refund.id,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: order.id,
        status: order.status,
      });
    } catch (_) {}

    return refund;
  }

  /**
   * 2. Seller accepts refund request (Atomic transition to SELLER_ACCEPTED).
   */
  static async sellerAccept(refundId: string, sellerUserId: string, reason?: string) {
    const updated = await prisma.$transaction(async (tx) => {
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        include: { seller: true, order: true },
      });

      if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);
      if (refund.seller.userId !== sellerUserId) {
        throw new AppError('غير مصرح لك بإدارة هذا الطلب', 403);
      }

      // Check state machine validity
      if (
        refund.status !== RefundStatus.SUBMITTED &&
        refund.status !== RefundStatus.UNDER_SELLER_REVIEW &&
        refund.status !== RefundStatus.REQUESTED &&
        refund.status !== RefundStatus.SELLER_REVIEW
      ) {
        throw new AppError(
          'لا يمكن اتخاذ هذا القرار: تم تسجيل قرار على هذا الطلب مسبقاً (REFUND_ACTION_ALREADY_COMPLETED)',
          409
        );
      }

      // Record Seller Decision
      await tx.sellerRefundDecision.create({
        data: {
          refundId: refund.id,
          sellerId: refund.sellerId,
          decision: 'ACCEPT',
          reason: reason || 'موافقة المتجر على طلب الاسترجاع',
          amount: refund.requestedAmount,
          createdBy: sellerUserId,
        },
      });

      // Record Status History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.SELLER_ACCEPTED,
          changedBy: sellerUserId,
          actorType: RefundActorType.SELLER,
          reason: reason || 'موافقة المتجر على طلب الاسترجاع',
        },
      });

      const updated = await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.SELLER_ACCEPTED,
          approvedAmount: refund.requestedAmount,
          sellerResponse: reason || 'موافقة المتجر',
        },
        include: { items: true, sellerDecisions: true, statusHistory: true, order: true },
      });

      // Synchronize order and sellerOrder status to RETURN_APPROVED
      await tx.order.update({
        where: { id: refund.orderId },
        data: { status: OrderStatus.RETURN_APPROVED },
      });

      if (refund.sellerOrderId) {
        await tx.sellerOrder.update({
          where: { id: refund.sellerOrderId },
          data: { status: SellerOrderStatus.RETURN_APPROVED },
        });
      }

      // Mark ReturnRequest as APPROVED
      await tx.returnRequest.updateMany({
        where: {
          orderId: refund.orderId,
          status: ReturnRequestStatus.PENDING,
        },
        data: {
          status: ReturnRequestStatus.APPROVED,
          refundAmount: refund.requestedAmount,
          resolvedBy: sellerUserId,
          resolvedAt: new Date(),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: refund.orderId,
          sellerOrderId: refund.sellerOrderId || null,
          fromStatus: refund.order?.status || 'RETURN_REQUESTED',
          toStatus: 'RETURN_APPROVED',
          status: OrderStatus.RETURN_APPROVED,
          changedBy: sellerUserId,
          changedByRole: 'SELLER',
          reason: reason || 'موافقة المتجر على طلب الاسترجاع',
          note: `تمت موافقة المتجر على طلب الإرجاع وجارٍ خصم المبلغ من محفظة المتجر`,
        },
      });

      // Automatically execute financial refund upon seller acceptance
      await this.executeFinancialRefundInternal(updated, tx);

      // Notify customer
      await tx.notification.create({
        data: {
          userId: refund.customerId,
          titleAr: 'وافق المتجر على طلب الاسترجاع',
          titleEn: 'Seller Accepted Refund Request',
          bodyAr: `وافق المتجر على طلب الاسترجاع #${refund.refundNumber}، وجارٍ استرداد المبلغ إلى حسابك.`,
          bodyEn: `Seller accepted refund request #${refund.refundNumber}. The refund is being processed to your account.`,
          type: NotificationType.REFUND_SELLER_APPROVED,
          data: JSON.stringify({ refundId: refund.id, orderId: refund.orderId }),
        },
      });

      return updated;
    });

    notificationDispatcher.dispatch(
      NotificationEventFactory.refundEvent({
        eventType: 'REFUND_ACCEPTED',
        recipientId: updated.customerId,
        refundId: updated.id,
        refundNumber: updated.refundNumber,
        orderId: updated.orderId,
        amount: Number(updated.requestedAmount || 0),
        isSeller: false,
      })
    ).catch(() => {});

    await RefundService.emitAdjustedProductSales((updated as any)?.__adjustedProducts);

    try {
      SocketService.get()?.emitGlobal('refund:seller_accepted', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('REFUND_APPROVED', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:status', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:updated', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:return_approved', {
        orderId: updated.orderId,
        refundId: updated.id,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: updated.orderId,
        refundId: updated.id,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: updated.orderId,
        status: updated.order?.status,
      });
    } catch (_) {}

    return updated;
  }

  /**
   * 3. Seller rejects refund request (Atomic transition to SELLER_REJECTED).
   */
  static async sellerReject(
    refundId: string,
    sellerUserId: string,
    rejectionReason: string,
    evidence?: Array<{ fileUrl: string; fileType?: string; fileSize?: number; mimeType?: string; description?: string }>
  ) {
    if (!rejectionReason || rejectionReason.trim().length < 5) {
      throw new AppError('سبب رفض الاسترجاع إلزامي ويجب توضيحه بشكل كافٍ (5 أحرف على الأقل)', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        include: { seller: true, order: true },
      });

      if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);
      if (refund.seller.userId !== sellerUserId) {
        throw new AppError('غير مصرح لك بإدارة هذا الطلب', 403);
      }

      if (
        refund.status !== RefundStatus.SUBMITTED &&
        refund.status !== RefundStatus.UNDER_SELLER_REVIEW &&
        refund.status !== RefundStatus.REQUESTED &&
        refund.status !== RefundStatus.SELLER_REVIEW
      ) {
        throw new AppError(
          'لا يمكن اتخاذ هذا القرار: تم تسجيل قرار على هذا الطلب مسبقاً (REFUND_ACTION_ALREADY_COMPLETED)',
          409
        );
      }

      // Record seller evidence if provided
      if (evidence && evidence.length > 0) {
        await tx.refundEvidence.createMany({
          data: evidence.map((e) => ({
            refundRequestId: refund.id,
            uploadedBy: sellerUserId,
            uploadedByRole: RefundActorType.SELLER,
            fileUrl: e.fileUrl,
            fileType: e.fileType || 'image/jpeg',
            fileSize: e.fileSize || 0,
            mimeType: e.mimeType || 'image/jpeg',
            description: e.description || null,
          })),
        });
      }

      // Record Seller Decision
      await tx.sellerRefundDecision.create({
        data: {
          refundId: refund.id,
          sellerId: refund.sellerId,
          decision: 'REJECT',
          reason: rejectionReason,
          amount: 0,
          createdBy: sellerUserId,
        },
      });

      // Record Status History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.SELLER_REJECTED,
          changedBy: sellerUserId,
          actorType: RefundActorType.SELLER,
          reason: rejectionReason,
        },
      });

      const res = await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.SELLER_REJECTED,
          sellerResponse: rejectionReason,
          sellerRejectionReason: rejectionReason,
        },
        include: { items: true, sellerDecisions: true, statusHistory: true, order: true },
      });

      // Notify customer
      await tx.notification.create({
        data: {
          userId: refund.customerId,
          titleAr: 'رفض المتجر طلب الاسترجاع',
          titleEn: 'Seller Rejected Refund Request',
          bodyAr: `تم رفض طلب الاسترجاع #${refund.refundNumber}. السبب: ${rejectionReason}. يمكنك قبول القرار أو تصعيد النزاع للإدارة.`,
          bodyEn: `Seller rejected refund request #${refund.refundNumber}. Reason: ${rejectionReason}`,
          type: NotificationType.REFUND_SELLER_REJECTED,
          data: JSON.stringify({ refundId: refund.id, orderId: refund.orderId }),
        },
      });

      return res;
    });

    notificationDispatcher.dispatch(
      NotificationEventFactory.refundEvent({
        eventType: 'REFUND_REJECTED',
        recipientId: updated.customerId,
        refundId: updated.id,
        refundNumber: updated.refundNumber,
        orderId: updated.orderId,
        reason: rejectionReason,
        isSeller: false,
      })
    ).catch(() => {});

    try {
      SocketService.get()?.emitGlobal('refund:seller_rejected', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
        rejectionReason,
      });
      SocketService.get()?.emitGlobal('REFUND_SELLER_REJECTED', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
        rejectionReason,
      });
      SocketService.get()?.emitGlobal('refund:status', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:updated', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:return_rejected', {
        orderId: updated.orderId,
        refundId: updated.id,
        reason: rejectionReason,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: updated.orderId,
        refundId: updated.id,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: updated.orderId,
        status: updated.order?.status,
      });
    } catch (_) {}

    return updated;
  }

  /**
   * 4. Customer accepts seller decision.
   * If seller accepted -> transitions to CUSTOMER_ACCEPTED -> REFUND_PENDING.
   * If seller rejected -> transitions to CLOSED.
   */
  static async customerAcceptDecision(refundId: string, customerId: string) {
    const updated = await prisma.$transaction(async (tx) => {
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        include: { order: true },
      });

      if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);
      if (refund.customerId !== customerId) {
        throw new AppError('غير مصرح لك بإدارة هذا الطلب', 403);
      }

      if (
        refund.status !== RefundStatus.SELLER_ACCEPTED &&
        refund.status !== RefundStatus.SELLER_REJECTED &&
        refund.status !== RefundStatus.REJECTED
      ) {
        throw new AppError(
          'لا يمكن اتخاذ هذا القرار في الحالة الحالية أو تم اتخاذ القرار مسبقاً (REFUND_ACTION_ALREADY_COMPLETED)',
          400
        );
      }

      const isSellerAccepted = refund.status === RefundStatus.SELLER_ACCEPTED;
      const nextStatus = isSellerAccepted ? RefundStatus.REFUND_PENDING : RefundStatus.CLOSED;

      // 1. Record Customer Decision
      await tx.customerRefundDecision.create({
        data: {
          refundId: refund.id,
          customerId,
          decision: 'ACCEPT_SELLER',
          reason: isSellerAccepted
            ? 'قبول العميل لموافقة المتجر وجارٍ تنفيذ الاسترجاع المالي'
            : 'قبول العميل لقرار المتجر بالرفض وإغلاق القضية نهائياً',
        },
      });

      // 2. Record Status History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: nextStatus,
          changedBy: customerId,
          actorType: RefundActorType.CUSTOMER,
          reason: isSellerAccepted ? 'قبول العميل لقرار المتجر' : 'قبول العميل لرفض المتجر وإغلاق القضية',
        },
      });

      const res = await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: nextStatus,
          approvedAmount: isSellerAccepted ? refund.requestedAmount : 0,
          resolvedAt: !isSellerAccepted ? new Date() : undefined,
        },
        include: { items: true, customerDecisions: true, statusHistory: true, order: true },
      });

      // If seller accepted, automatically trigger financial execution (Wallet credit or Manual Transfer queue)
      if (isSellerAccepted) {
        // Execute financial refund
        await this.executeFinancialRefundInternal(res, tx);
      }

      return res;
    });

    await RefundService.emitAdjustedProductSales((updated as any)?.__adjustedProducts);

    try {
      SocketService.get()?.emitGlobal('refund:customer_accepted', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:closed', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:status', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:updated', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: updated.orderId,
        refundId: updated.id,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: updated.orderId,
        status: updated.order?.status,
      });
    } catch (_) {}

    if (updated.status === RefundStatus.REFUND_PENDING || updated.status === RefundStatus.REFUND_COMPLETED) {
      MembershipEligibilityService.onRefundCompleted({
        userId: updated.customerId,
        refundId: updated.id,
        approvedAmount: updated.approvedAmount || updated.requestedAmount,
      }).catch((err) => console.error('[Membership] Re-eval on refund error:', err));
    }

    return updated;
  }

  /**
   * 5. Customer disputes seller decision -> transitions to CUSTOMER_DISPUTED -> ADMIN_REVIEW.
   */
  static async customerDispute(
    refundId: string,
    customerId: string,
    disputeReason: string,
    evidence?: Array<{ fileUrl: string; fileType?: string; fileSize?: number; mimeType?: string; description?: string }>
  ) {
    if (!disputeReason || disputeReason.trim().length < 5) {
      throw new AppError('سبب وتوضيح النزاع إلزامي ويجب ألا يقل عن 5 أحرف', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        include: { seller: true, order: true },
      });

      if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);
      if (refund.customerId !== customerId) {
        throw new AppError('غير مصرح لك بفتح نزاع على هذا الطلب', 403);
      }

      const nonDisputableStatuses: RefundStatus[] = [
        RefundStatus.ADMIN_APPROVED,
        RefundStatus.REFUND_COMPLETED,
        RefundStatus.REFUNDED,
        RefundStatus.CANCELLED,
        RefundStatus.CLOSED,
        RefundStatus.CUSTOMER_DISPUTED,
      ];
      if (nonDisputableStatuses.includes(refund.status)) {
        throw new AppError(
          'لا يمكن تصعيد النزاع في حالة الطلب الحالية أو تم إغلاق الطلب مسبقاً',
          400
        );
      }

      // Add evidence if provided
      if (evidence && evidence.length > 0) {
        await tx.refundEvidence.createMany({
          data: evidence.map((e) => ({
            refundRequestId: refund.id,
            uploadedBy: customerId,
            uploadedByRole: RefundActorType.CUSTOMER,
            fileUrl: e.fileUrl,
            fileType: e.fileType || 'image/jpeg',
            fileSize: e.fileSize || 0,
            mimeType: e.mimeType || 'image/jpeg',
            description: e.description || 'دليل النزاع',
          })),
        });
      }

      // Record Customer Decision
      await tx.customerRefundDecision.create({
        data: {
          refundId: refund.id,
          customerId,
          decision: 'DISPUTE',
          reason: disputeReason,
        },
      });

      // Record History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.ADMIN_REVIEW,
          changedBy: customerId,
          actorType: RefundActorType.CUSTOMER,
          reason: disputeReason,
        },
      });

      // Synchronize in prisma.dispute
      await tx.dispute.upsert({
        where: { id: refund.id },
        create: {
          id: refund.id,
          customerId,
          sellerId: refund.sellerId,
          orderId: refund.orderId,
          reason: refund.reasonText,
          description: disputeReason,
          status: DisputeStatus.OPEN,
          refundAmount: refund.requestedAmount,
        },
        update: {
          status: DisputeStatus.OPEN,
          description: disputeReason,
          refundAmount: refund.requestedAmount,
        },
      });

      const res = await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.ADMIN_REVIEW,
          customerNote: refund.customerNote
            ? `${refund.customerNote}\n[ملاحظة النزاع]: ${disputeReason}`
            : disputeReason,
        },
        include: { items: true, evidence: true, customerDecisions: true, statusHistory: true, order: true, seller: true },
      });

      // Notify Seller & Admin
      if (refund.seller.userId) {
        await tx.notification.create({
          data: {
            userId: refund.seller.userId,
            titleAr: 'اعتراض العميل على القرار',
            titleEn: 'Customer Disputed Decision',
            bodyAr: `قام العميل بتصعيد النزاع للطلب #${refund.refundNumber} وتم إحالته إلى إدارة المنصة.`,
            bodyEn: `Customer opened a dispute for refund #${refund.refundNumber}`,
            type: NotificationType.REFUND_DISPUTED,
            data: JSON.stringify({ refundId: refund.id, orderId: refund.orderId }),
          },
        });
      }

      return res;
    });

    if (updated.seller?.userId) {
      notificationDispatcher.dispatch(
        NotificationEventFactory.refundEvent({
          eventType: 'REFUND_ESCALATED',
          recipientId: updated.seller.userId,
          refundId: updated.id,
          refundNumber: updated.refundNumber,
          orderId: updated.orderId,
          reason: disputeReason,
          isSeller: true,
        })
      ).catch(() => {});
    }

    try {
      SocketService.get()?.emitGlobal('dispute:created', {
        refundId: updated.id,
        orderId: updated.orderId,
        disputeReason,
      });
      SocketService.get()?.emitGlobal('admin:new_dispute', {
        refundId: updated.id,
        orderId: updated.orderId,
        disputeReason,
      });
      SocketService.get()?.emitGlobal('refund:disputed', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:status', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:updated', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: updated.orderId,
        refundId: updated.id,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: updated.orderId,
        status: updated.order?.status,
      });
    } catch (_) {}

    return updated;
  }

  /**
   * 6. Admin resolves dispute (Approve Full, Approve Partial, or Reject).
   */
  static async adminResolve(params: {
    refundId: string;
    adminUserId: string;
    decision: 'APPROVE_FULL' | 'APPROVE_PARTIAL' | 'REJECT';
    approvedAmount?: number;
    destination?: RefundDestination;
    decisionReason: string;
    internalNote?: string;
  }) {
    const { refundId, adminUserId, decision, approvedAmount, destination, decisionReason, internalNote } =
      params;

    if (!decisionReason || decisionReason.trim().length < 5) {
      throw new AppError('سبب قرار الإدارة إلزامي ومطلوب للتوثيق (5 أحرف على الأقل)', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        include: { order: true, seller: true },
      });

      if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

      const nonResolvableStatuses: RefundStatus[] = [
        RefundStatus.ADMIN_APPROVED,
        RefundStatus.REFUND_COMPLETED,
        RefundStatus.REFUNDED,
        RefundStatus.CLOSED,
        RefundStatus.CANCELLED,
      ];
      if (nonResolvableStatuses.includes(refund.status)) {
        throw new AppError(
          `لا يمكن اتخاذ قرار إداري في حالة الطلب الحالية [${refund.status}] لأن المعاملة منتهية أو مغلقة`,
          400
        );
      }

      // If Reject
      if (decision === 'REJECT') {
        await tx.refundStatusHistory.create({
          data: {
            refundRequestId: refund.id,
            fromStatus: refund.status,
            toStatus: RefundStatus.CLOSED,
            changedBy: adminUserId,
            actorType: RefundActorType.ADMIN,
            reason: `رفض الإدارة: ${decisionReason}`,
          },
        });

        // Close dispute
        await tx.dispute.updateMany({
          where: { orderId: refund.orderId, status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } },
          data: { status: DisputeStatus.REJECTED, decision: 'REJECTED', resolution: decisionReason },
        });

        const res = await tx.refundRequest.update({
          where: { id: refundId },
          data: {
            status: RefundStatus.CLOSED,
            adminDecision: 'REJECT',
            adminDecisionReason: decisionReason,
            resolvedAt: new Date(),
          },
          include: { order: true, seller: true },
        });

        await tx.notification.create({
          data: {
            userId: refund.customerId,
            titleAr: 'قرار الإدارة برفض طلب الاسترجاع',
            titleEn: 'Dispute Decision: Rejected',
            bodyAr: `أصدرت إدارة المنصة قراراً برفض طلب الاسترجاع #${refund.refundNumber}. السبب: ${decisionReason}`,
            bodyEn: `Dispute for refund #${refund.refundNumber} was rejected by admin.`,
            type: NotificationType.REFUND_ADMIN_REJECTED,
            data: JSON.stringify({ refundId: refund.id }),
          },
        });

        return res;
      }

      // Approve (Full or Partial)
      let finalApprovedAmount = refund.requestedAmount;
      if (decision === 'APPROVE_PARTIAL') {
        if (!approvedAmount || approvedAmount <= 0) {
          throw new AppError('يرجى تحديد مبلغ الاسترجاع الجزئي المعتمد', 400);
        }
        if (approvedAmount > refund.requestedAmount) {
          throw new AppError(
            `المبلغ المعتمد (${approvedAmount}) لا يمكن أن يتجاوز المبلغ المطلوب أصلاً (${refund.requestedAmount})`,
            400
          );
        }
        finalApprovedAmount = approvedAmount;

        // Record immutable adjustment
        await tx.refundAdjustment.create({
          data: {
            refundId: refund.id,
            adminId: adminUserId,
            originalRequestedAmount: refund.requestedAmount,
            approvedAmount: finalApprovedAmount,
            difference: parseFloat((refund.requestedAmount - finalApprovedAmount).toFixed(2)),
            reason: decisionReason,
          },
        });
      }

      const targetDestination = destination || refund.destination || RefundDestination.CUSTOMER_WALLET;

      // Status History
      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.REFUND_PENDING,
          changedBy: adminUserId,
          actorType: RefundActorType.ADMIN,
          reason: `موافقة الإدارة (${decision}): ${decisionReason}`,
        },
      });

      const res = await tx.refundRequest.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.REFUND_PENDING,
          approvedAmount: finalApprovedAmount,
          destination: targetDestination,
          adminDecision: decision,
          adminDecisionReason: decisionReason,
        },
        include: { order: true, seller: true },
      });

      // Execute financial refund according to destination
      await this.executeFinancialRefundInternal(res, tx, adminUserId);

      return res;
    });

    await RefundService.emitAdjustedProductSales((updated as any)?.__adjustedProducts);

    try {
      SocketService.get()?.emitGlobal('dispute:resolved', {
        refundId: updated.id,
        orderId: updated.orderId,
        decision,
        reason: decisionReason,
      });
      SocketService.get()?.emitGlobal('DISPUTE_RESOLVED', {
        refundId: updated.id,
        orderId: updated.orderId,
        decision,
      });
      SocketService.get()?.emitGlobal('REFUND_ADMIN_DECISION', {
        refundId: updated.id,
        orderId: updated.orderId,
        decision,
      });
      SocketService.get()?.emitGlobal('refund:admin_decision', {
        refundId: updated.id,
        orderId: updated.orderId,
        decision,
      });
      SocketService.get()?.emitGlobal('refund:status', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('refund:updated', {
        refundId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: updated.orderId,
        refundId: updated.id,
        status: updated.status,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: updated.orderId,
        status: updated.order?.status,
      });
    } catch (_) {}

    if (decision === 'APPROVE_FULL' || decision === 'APPROVE_PARTIAL') {
      MembershipEligibilityService.onRefundCompleted({
        userId: updated.customerId,
        refundId: updated.id,
        approvedAmount: updated.approvedAmount || updated.requestedAmount,
      }).catch((err) => console.error('[Membership] Re-eval on admin refund error:', err));
    }

    return updated;
  }

  /**
   * Internal Execution Coordinator with Concurrency & Double-Execution Lock
   */
  private static async executeFinancialRefundInternal(refund: any, tx: any, adminUserId?: string) {
    const destination = refund.destination || RefundDestination.CUSTOMER_WALLET;
    const approvedAmount = refund.approvedAmount || refund.requestedAmount;

    // Acquire Execution Lock to guarantee only ONE execution per refund
    const existingLock = await tx.refundExecutionLock.findUnique({
      where: { refundId: refund.id },
    });

    if (existingLock && existingLock.status === 'COMPLETED') {
      return; // Already executed
    }

    await tx.refundExecutionLock.upsert({
      where: { refundId: refund.id },
      create: {
        refundId: refund.id,
        destination,
        status: destination === RefundDestination.CUSTOMER_WALLET ? 'COMPLETED' : 'LOCKED',
        completedAt: destination === RefundDestination.CUSTOMER_WALLET ? new Date() : null,
      },
      update: {
        destination,
      },
    });

    // Destination 1: Internal Customer Wallet
    if (destination === RefundDestination.CUSTOMER_WALLET) {
      // 1. Credit Customer Wallet via Ledger
      await CustomerWalletService.creditRefund(
        {
          refundId: refund.id,
          customerId: refund.customerId,
          amount: approvedAmount,
          currency: refund.currency || 'YER',
          orderNumber: refund.order?.orderNumber || refund.orderId,
          refundNumber: refund.refundNumber,
          adminUserId,
        },
        tx
      );

      // 2. Adjust Seller Balance & Create Seller Transaction
      await this.adjustSellerSettlement(refund, approvedAmount, tx);

      // 2.05 Tax-Aware Refund Calculation & Immutable Recording (Section 13)
      try {
        const refundItems = await tx.refundRequestItem.findMany({
          where: { refundRequestId: refund.id },
        });

        const refundTaxInputItems = (refundItems || []).map((ri: any) => ({
          orderItemId: ri.orderItemId,
          quantity: ri.quantity || 1,
          refundAmount: ri.refundAmount || ri.totalPrice || approvedAmount,
        }));

        const refundTaxResult = await TaxEngine.calculateRefundTax({
          orderId: refund.orderId,
          items: refundTaxInputItems,
          refundShipping: false,
        });

        if (refundTaxResult.totalRefundableTax > 0) {
          await TaxEngine.recordRefundTax(tx, refund.id, refundTaxResult);
        }
      } catch (taxErr) {
        console.error('[TaxEngine] Error calculating refund tax:', taxErr);
      }

      // 2.1 SOUQNAA Coins Proportionate Reversal (§22, §23, §83)
      if (refund.orderId) {
        try {
          await RewardsReversalService.onOrderRefunded({
            orderId: refund.orderId,
            refundAmount: approvedAmount,
            refundId: refund.id,
            externalTx: tx,
          });
        } catch (coinErr) {
          console.error('[Rewards] Failed to reverse coins on refund:', coinErr);
        }
      }


      // 3. Mark Refund as REFUND_COMPLETED
      await tx.refundRequest.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.REFUND_COMPLETED,
          resolvedAt: new Date(),
        },
      });

      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.REFUND_COMPLETED,
          changedBy: adminUserId || refund.customerId,
          actorType: adminUserId ? RefundActorType.ADMIN : RefundActorType.SYSTEM,
          reason: 'إيداع المبلغ في محفظة العميل الداخلية وتحديث القيود المالية',
        },
      });

      // 4. Update Payment status
      if (refund.orderId) {
        await tx.payment.updateMany({
          where: { orderId: refund.orderId },
          data: { status: PaymentStatus.REFUNDED },
        });
      }

      // 5. Notify customer
      await tx.notification.create({
        data: {
          userId: refund.customerId,
          titleAr: 'تم إيداع مبلغ الاسترجاع في محفظتك',
          titleEn: 'Refund Credited to Your Wallet',
          bodyAr: `تم إيداع مبلغ ${approvedAmount} ${refund.currency} في محفظتك الداخلية بسوقناا للطلب #${refund.refundNumber}`,
          bodyEn: `Refund of ${approvedAmount} ${refund.currency} has been credited to your SOUQNAA wallet`,
          type: NotificationType.REFUND_COMPLETED,
          data: JSON.stringify({ refundId: refund.id }),
        },
      });
    }

    // Destination 2: Manual External Wallet Transfer
    else if (destination === RefundDestination.MANUAL_WALLET_TRANSFER) {
      // Update refund status to REFUND_PROCESSING
      await tx.refundRequest.update({
        where: { id: refund.id },
        data: { status: RefundStatus.REFUND_PROCESSING },
      });

      // Update manual transfer request to APPROVED (awaiting proof & reference from admin)
      await tx.manualWalletTransferRequest.updateMany({
        where: { refundId: refund.id },
        data: {
          status: 'APPROVED',
          amount: approvedAmount,
        },
      });

      // Adjust Seller Settlement immediately upon refund commitment
      await this.adjustSellerSettlement(refund, approvedAmount, tx);
    } else {
      // Destination 3: ORIGINAL_PAYMENT_METHOD, BANK_TRANSFER, etc.
      // 1. Adjust Seller Settlement immediately upon refund commitment
      await this.adjustSellerSettlement(refund, approvedAmount, tx);

      // 2. Mark Refund as REFUND_COMPLETED
      await tx.refundRequest.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.REFUND_COMPLETED,
          resolvedAt: new Date(),
        },
      });

      await tx.refundStatusHistory.create({
        data: {
          refundRequestId: refund.id,
          fromStatus: refund.status,
          toStatus: RefundStatus.REFUND_COMPLETED,
          changedBy: adminUserId || refund.customerId,
          actorType: adminUserId ? RefundActorType.ADMIN : RefundActorType.SYSTEM,
          reason: 'اعتماد الاسترداد المالي وإعادة قيد المبالغ على حساب المتجر',
        },
      });

      // 3. Update payment status if exists
      if (refund.orderId) {
        await tx.payment.updateMany({
          where: { orderId: refund.orderId },
          data: { status: PaymentStatus.REFUNDED },
        });
      }
    }

    // Revert Product Sold Count for Refunded Items across ALL destinations (§4)
    const adjustedProducts: Array<{ productId: string; newSoldCount: number; delta: number; storeId?: string }> = [];
    if (refund.id) {
      try {
        const refundItems = await tx.refundRequestItem.findMany({
          where: { refundRequestId: refund.id },
          select: { productId: true, quantity: true },
        });
        for (const item of refundItems) {
          if (item.productId && item.quantity > 0) {
            const currentProd = await tx.product.findUnique({
              where: { id: item.productId },
              select: { soldCount: true, storeId: true },
            });
            if (currentProd && currentProd.soldCount > 0) {
              const newSoldCount = Math.max(0, currentProd.soldCount - item.quantity);
              await tx.product.update({
                where: { id: item.productId },
                data: { soldCount: newSoldCount },
              });
              adjustedProducts.push({
                productId: item.productId,
                newSoldCount,
                delta: -item.quantity,
                storeId: currentProd.storeId,
              });
            }
          }
        }
      } catch (soldErr) {
        console.error('[Refund] Failed to adjust product soldCount on refund:', soldErr);
      }
    }
    (refund as any).__adjustedProducts = adjustedProducts;
  }

  /**
   * Broadcasts product sold-count changes and invalidates Redis caches post-commit.
   */
  public static async emitAdjustedProductSales(
    adjustedProducts?: Array<{ productId: string; newSoldCount: number; delta: number; storeId?: string }>
  ) {
    if (!adjustedProducts || adjustedProducts.length === 0) return;
    try {
      const socket = SocketService.get();
      for (const item of adjustedProducts) {
        if (socket) {
          socket.emitGlobal('product:sold_count_updated', {
            productId: item.productId,
            soldCount: item.newSoldCount,
            delta: item.delta,
            timestamp: new Date().toISOString(),
          });
        }
        try {
          await redis.del(`product:${item.productId}`);
          if (item.storeId) {
            const store = await prisma.store.findUnique({
              where: { id: item.storeId },
              select: { slug: true },
            });
            await redis.del(`storefront:${item.storeId}`);
            if (store?.slug) {
              await redis.del(`storefront:${store.slug}`);
            }
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error('[Refund] Failed to emit adjusted product sales:', err);
    }
  }

  /**
   * Adjusts seller settlement, platform commission reversal, and liabilities.
   */
  public static async adjustSellerSettlement(refund: any, approvedAmount: number, tx: any) {
    let sellerBalance = await tx.sellerBalance.findUnique({
      where: { sellerId: refund.sellerId },
    });

    if (!sellerBalance) {
      sellerBalance = await tx.sellerBalance.create({
        data: {
          sellerId: refund.sellerId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          outstandingCommission: 0,
          currency: refund.currency || 'YER',
        },
      });
    }

    const commissionRate = 0.10; // 10%
    const commissionReversal = parseFloat((approvedAmount * commissionRate).toFixed(2));
    const sellerNetDebit = parseFloat((approvedAmount - commissionReversal).toFixed(2));

    const orderRecord = await tx.order.findUnique({
      where: { id: refund.orderId },
      select: { orderNumber: true, displayOrderNumber: true },
    });
    const sellerOrderRecord = refund.sellerOrderId
      ? await tx.sellerOrder.findUnique({
          where: { id: refund.sellerOrderId },
          select: { sellerOrderNumber: true },
        })
      : null;

    const orderRef = orderRecord?.orderNumber || refund.orderId;
    const sellerOrderRef = sellerOrderRecord?.sellerOrderNumber || (refund.sellerOrderId || '');

    const currentAvailable = Number(sellerBalance.availableBalance || 0);

    if (currentAvailable >= sellerNetDebit) {
      // 1. Seller has sufficient balance -> Deduct in full
      const newAvailable = parseFloat((currentAvailable - sellerNetDebit).toFixed(2));
      await tx.sellerBalance.update({
        where: { sellerId: refund.sellerId },
        data: {
          availableBalance: newAvailable,
        },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: sellerBalance.id,
          amount: -sellerNetDebit,
          type: TransactionType.REFUND,
          referenceId: refund.id,
          description: `خصم استرجاع من رصيد المحفظة - الطلب: ${orderRef}${sellerOrderRef ? ` | طلب المتجر: ${sellerOrderRef}` : ''} (مرجع: ${refund.refundNumber})`,
        },
      });
    } else {
      // 2. Seller has insufficient or zero balance -> Deduct available portion down to 0 & Record Outstanding Payment
      const availableDeduction = Math.max(0, currentAvailable);
      const outstandingDebt = parseFloat((sellerNetDebit - availableDeduction).toFixed(2));

      await tx.sellerBalance.update({
        where: { sellerId: refund.sellerId },
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
            referenceId: refund.id,
            description: `خصم استرجاع جزئي من الرصيد المتاح - الطلب: ${orderRef} (مرجع: ${refund.refundNumber})`,
          },
        });
      }

      // Record official Outstanding Payment (Liability) for the seller
      await tx.sellerOutstanding.create({
        data: {
          sellerId: refund.sellerId,
          sourceType: 'REFUND_LIABILITY',
          sourceReference: orderRef,
          amount: outstandingDebt,
          paidAmount: 0,
          remainingAmount: outstandingDebt,
          currency: refund.currency || 'YER',
          status: 'OPEN',
          warningLevel: 'NORMAL',
          metadata: JSON.stringify({
            refundId: refund.id,
            refundNumber: refund.refundNumber,
            orderNumber: orderRef,
            sellerOrderNumber: sellerOrderRef,
            approvedAmount,
            sellerNetDebit,
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
          referenceId: refund.id,
          description: `مديونية مستحقة معلقة (استرجاع طلب) - الطلب: ${orderRef}${sellerOrderRef ? ` | طلب المتجر: ${sellerOrderRef}` : ''} (مرجع: ${refund.refundNumber})`,
        },
      });
    }

    // Create Financial Ledger Entries (Platform Audit)
    const txNum = `FT-REV-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
    await tx.financialTransaction.create({
      data: {
        transactionNumber: txNum,
        type: FinancialTransactionType.REFUND_CUSTOMER,
        orderId: refund.orderId,
        refundRequestId: refund.id,
        sellerId: refund.sellerId,
        amount: approvedAmount,
        currency: refund.currency || 'YER',
        direction: 'CREDIT',
        referenceId: refund.id,
        description: `استرجاع مالي للعميل #${refund.customerId} - الطلب: ${orderRef}${sellerOrderRef ? ` | طلب المتجر: ${sellerOrderRef}` : ''} (مرجع: ${refund.refundNumber})`,
        metadata: JSON.stringify({
          orderNumber: orderRef,
          sellerOrderNumber: sellerOrderRef,
          refundNumber: refund.refundNumber,
        }),
      },
    });
  }
}
