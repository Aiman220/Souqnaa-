import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../../../database/prisma';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { RefundService } from '../services/refund.service';
import { RefundEligibilityService } from '../services/refund-eligibility.service';
import { ManualWalletTransferService } from '../services/manual-wallet-transfer.service';
import { RefundReconciliationService } from '../services/refund-reconciliation.service';
import { CustomerWalletService } from '../../wallet/customer-wallet.service';
import { SocketService } from '../../../services/websocket/socket.service';
import { RefundStateMachine } from '../refund.state-machine';
import { RefundActorType, RefundStatus, UserRoleType, RefundDestination, ManualTransferStatus, NotificationType } from '@prisma/client';

const router = Router();
router.use(authenticate);
router.use(authorize(UserRoleType.ADMIN));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB limit
});

// ── GET /api/v1/admin/refunds/policy ──────────────────────────────────────────
router.get('/policy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let policy = await prisma.refundPolicyConfig.findFirst();
    if (!policy) {
      policy = await prisma.refundPolicyConfig.create({
        data: {
          refundWindowDays: 14,
          refundWindowEnabled: true,
          allowPartialRefund: true,
          allowFullRefund: true,
          allowShippingRefund: false,
          allowSellerDecision: true,
          allowCustomerDispute: true,
          adminEscalationEnabled: true,
          manualWalletRefundEnabled: true,
          dualApprovalEnabled: false,
        },
      });
    }
    ResponseUtil.success(res, policy);
  } catch (error) {
    next(error);
  }
});

// ── PUT /api/v1/admin/refunds/policy ──────────────────────────────────────────
router.put('/policy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUserId = req.user!.userId;
    const {
      refundWindowDays,
      refundWindowEnabled,
      allowPartialRefund,
      allowFullRefund,
      allowShippingRefund,
      allowSellerDecision,
      allowCustomerDispute,
      adminEscalationEnabled,
      manualWalletRefundEnabled,
      dualApprovalEnabled,
      dualApprovalThresholdYER,
    } = req.body;

    let existing = await prisma.refundPolicyConfig.findFirst();
    const data: any = {
      ...(refundWindowDays !== undefined ? { refundWindowDays: parseInt(refundWindowDays, 10) } : {}),
      ...(refundWindowEnabled !== undefined ? { refundWindowEnabled: !!refundWindowEnabled } : {}),
      ...(allowPartialRefund !== undefined ? { allowPartialRefund: !!allowPartialRefund } : {}),
      ...(allowFullRefund !== undefined ? { allowFullRefund: !!allowFullRefund } : {}),
      ...(allowShippingRefund !== undefined ? { allowShippingRefund: !!allowShippingRefund } : {}),
      ...(allowSellerDecision !== undefined ? { allowSellerDecision: !!allowSellerDecision } : {}),
      ...(allowCustomerDispute !== undefined ? { allowCustomerDispute: !!allowCustomerDispute } : {}),
      ...(adminEscalationEnabled !== undefined ? { adminEscalationEnabled: !!adminEscalationEnabled } : {}),
      ...(manualWalletRefundEnabled !== undefined ? { manualWalletRefundEnabled: !!manualWalletRefundEnabled } : {}),
      ...(dualApprovalEnabled !== undefined ? { dualApprovalEnabled: !!dualApprovalEnabled } : {}),
      ...(dualApprovalThresholdYER !== undefined ? { dualApprovalThresholdYER: parseFloat(dualApprovalThresholdYER) } : {}),
      updatedBy: adminUserId,
    };

    let updated;
    if (existing) {
      updated = await prisma.refundPolicyConfig.update({
        where: { id: existing.id },
        data,
      });
    } else {
      updated = await prisma.refundPolicyConfig.create({ data });
    }

    // Audit policy modification
    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: 'REFUND_POLICY_CONFIG_UPDATED',
        resource: 'refund_policy_configs',
        details: JSON.stringify(data),
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث سياسات الاسترجاع بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/refunds/reconciliation ──────────────────────────────────
router.get('/reconciliation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await RefundReconciliationService.runReconciliationAudit();
    ResponseUtil.success(res, report);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/refunds/manual-transfers ─────────────────────────────────
router.get('/manual-transfers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const status = req.query.status as ManualTransferStatus | undefined;
    const provider = req.query.provider as string | undefined;

    const result = await ManualWalletTransferService.listTransfers({
      page,
      limit,
      status,
      provider,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/refunds/manual-transfers/:id/unmask ──────────────────────
router.get('/manual-transfers/:id/unmask', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const adminUserId = req.user!.userId;
    const details = await ManualWalletTransferService.getUnmaskedTransferDetails(id, adminUserId);
    ResponseUtil.success(res, details);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/manual-transfers/:id/proof ─────────────────────
router.post('/manual-transfers/:id/proof', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const adminUserId = req.user!.userId;

    if (req.file) {
      const proof = await ManualWalletTransferService.attachProof({
        transferId: id,
        adminUserId,
        file: req.file,
      });
      return ResponseUtil.created(res, proof, 'تم إرفاق إشعار التحويل بنجاح');
    }

    const { fileUrl, fileType, fileSize, mimeType } = req.body;
    if (!fileUrl) throw new AppError('ملف إشعار التحويل البنكي/السند مطلوب', 400);

    const proof = await prisma.transferProof.create({
      data: {
        transferId: id,
        fileUrl,
        fileType: fileType || mimeType || 'image/jpeg',
        fileSize: fileSize || 0,
        fileHash: 'VERIFIED_EXTERNAL_PROOF',
        uploadedBy: adminUserId,
      },
    });

    ResponseUtil.created(res, proof, 'تم إرفاق إشعار التحويل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/manual-transfers/:id/complete ──────────────────
router.post('/manual-transfers/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const adminUserId = req.user!.userId;
    const { externalTransactionReference, adminNote } = req.body;

    const completed = await ManualWalletTransferService.completeTransfer({
      transferId: id,
      adminUserId,
      externalTransactionReference,
      adminNote,
    });

    ResponseUtil.success(res, completed, 'تم تأكيد اكتمال التحويل الخارجي وتسوية الاسترجاع بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/manual-transfers/:id/reject ────────────────────
router.post('/manual-transfers/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const adminUserId = req.user!.userId;
    const { rejectionReason } = req.body;

    const rejected = await ManualWalletTransferService.rejectTransfer({
      transferId: id,
      adminUserId,
      rejectionReason,
    });

    ResponseUtil.success(res, rejected, 'تم تسجيل رفض طلب التحويل الخارجي بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/refunds ─────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;

    const {
      status,
      tab,
      orderId,
      refundId,
      customer,
      seller,
      search,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    } = req.query as Record<string, string | undefined>;

    const where: any = {};

    if (tab) {
      const t = tab.toUpperCase();
      if (t === 'PENDING') where.status = { in: [RefundStatus.SUBMITTED, RefundStatus.REQUESTED] };
      else if (t === 'SELLER_REVIEW') where.status = { in: [RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_REVIEW] };
      else if (t === 'DISPUTED') where.status = { in: [RefundStatus.CUSTOMER_DISPUTED, RefundStatus.DISPUTED, RefundStatus.ADMIN_REVIEW] };
      else if (t === 'ADMIN_REVIEW') where.status = RefundStatus.ADMIN_REVIEW;
      else if (t === 'APPROVED') where.status = { in: [RefundStatus.ADMIN_APPROVED, RefundStatus.APPROVED, RefundStatus.REFUND_PENDING, RefundStatus.REFUND_PROCESSING] };
      else if (t === 'REJECTED') where.status = { in: [RefundStatus.ADMIN_REJECTED, RefundStatus.SELLER_REJECTED, RefundStatus.REJECTED] };
      else if (t === 'REFUNDED') where.status = { in: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUNDED] };
      else if (t === 'CLOSED') where.status = { in: [RefundStatus.CLOSED, RefundStatus.CANCELLED, RefundStatus.EXPIRED] };
    } else if (status && status.toUpperCase() !== 'ALL') {
      where.status = status;
    }

    if (refundId) where.refundNumber = { contains: refundId, mode: 'insensitive' };
    if (orderId) where.order = { orderNumber: { contains: orderId, mode: 'insensitive' } };

    if (customer) {
      where.customer = {
        OR: [
          { firstName: { contains: customer, mode: 'insensitive' } },
          { lastName: { contains: customer, mode: 'insensitive' } },
          { phone: { contains: customer } },
          { email: { contains: customer, mode: 'insensitive' } },
        ],
      };
    }

    if (seller) {
      where.seller = {
        OR: [
          { stores: { some: { name: { contains: seller, mode: 'insensitive' } } } },
          { user: { phone: { contains: seller } } },
        ],
      };
    }

    if (search) {
      where.OR = [
        { refundNumber: { contains: search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: search, mode: 'insensitive' } } },
        { reasonText: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    if (minAmount || maxAmount) {
      where.requestedAmount = {};
      if (minAmount) where.requestedAmount.gte = parseFloat(minAmount);
      if (maxAmount) where.requestedAmount.lte = parseFloat(maxAmount);
    }

    const [total, refunds] = await Promise.all([
      prisma.refundRequest.count({ where }),
      prisma.refundRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              product: { select: { id: true, nameAr: true, nameEn: true, images: true } },
            },
          },
          customer: {
            select: { id: true, firstName: true, lastName: true, phone: true, email: true },
          },
          seller: {
            include: {
              stores: { select: { name: true, logo: true }, take: 1 },
            },
          },
          order: {
            select: { id: true, orderNumber: true, total: true, status: true, currency: true },
          },
          evidence: {
            orderBy: { createdAt: 'desc' },
          },
          statusHistory: {
            orderBy: { createdAt: 'asc' },
          },
          manualTransfer: {
            select: { id: true, status: true, walletProvider: true, walletNumberMasked: true },
          },
        },
      }),
    ]);

    const enrichedRefunds = refunds.map((r) => ({
      ...r,
      customerName: r.customer
        ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim()
        : null,
      customerPhone: r.customer?.phone || null,
      storeName: r.seller?.stores?.[0]?.name || null,
      orderNumber: r.order?.orderNumber || null,
      availableActions: RefundStateMachine.getAvailableActions(r.status, RefundActorType.ADMIN),
    }));

    ResponseUtil.success(res, {
      refunds: enrichedRefunds,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/admin/refunds/:id ─────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);

    const refund = await prisma.refundRequest.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, images: true } },
            orderItem: true,
          },
        },
        evidence: {
          orderBy: { createdAt: 'desc' },
        },
        statusHistory: {
          include: {
            actor: { select: { id: true, firstName: true, lastName: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        sellerDecisions: {
          orderBy: { createdAt: 'desc' },
        },
        customerDecisions: {
          orderBy: { createdAt: 'desc' },
        },
        adjustments: {
          include: { admin: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
        },
        manualTransfer: {
          include: { proofs: true },
        },
        executionLock: true,
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        customer: {
          select: { id: true, firstName: true, lastName: true, phone: true, email: true },
        },
        seller: {
          include: {
            stores: { select: { name: true, logo: true }, take: 1 },
            user: { select: { id: true, firstName: true, lastName: true, phone: true } },
          },
        },
        order: {
          include: {
            payment: true,
            deliveryAddress: true,
          },
        },
        sellerOrder: true,
        financialTransactions: {
          orderBy: { createdAt: 'desc' },
        },
        snapshot: true,
      },
    });

    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const eligibility = await RefundEligibilityService.checkOrderEligibility(refund.orderId);
    const availableActions = RefundStateMachine.getAvailableActions(
      refund.status,
      RefundActorType.ADMIN
    );

    ResponseUtil.success(res, {
      ...refund,
      availableActions,
      eligibilitySnapshot: {
        remainingRefundableTotal: eligibility.remainingRefundableTotal,
        alreadyRefundedTotal: eligibility.alreadyRefundedTotal,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/:id/approve ────────────────────────────────────
router.post(['/:id/admin/approve', '/:id/approve'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { decisionReason, destination = RefundDestination.CUSTOMER_WALLET, internalNote } = req.body;

    if (!decisionReason) throw new AppError('سبب وتبرير الموافقة الإدارية مطلوب', 400);

    const updated = await RefundService.adminResolve({
      refundId: id,
      adminUserId: req.user!.userId,
      decision: 'APPROVE_FULL',
      destination,
      decisionReason,
      internalNote,
    });

    ResponseUtil.success(res, updated, 'تم اعتماد الاسترجاع الكامل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/:id/adjust (or partial-approve) ────────────────
router.post(['/:id/admin/adjust', '/:id/partial-approve'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { approvedAmount, destination = RefundDestination.CUSTOMER_WALLET, decisionReason, internalNote } = req.body;

    const parsedAmount = parseFloat(approvedAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError('مبلغ الاسترجاع الجزئي غير صالح', 400);
    }
    if (!decisionReason) throw new AppError('سبب وتبرير التعديل أو الموافقة الجزئية مطلوب', 400);

    const updated = await RefundService.adminResolve({
      refundId: id,
      adminUserId: req.user!.userId,
      decision: 'APPROVE_PARTIAL',
      approvedAmount: parsedAmount,
      destination,
      decisionReason,
      internalNote,
    });

    ResponseUtil.success(res, updated, `تم اعتماد تعديل المبلغ والاسترجاع الجزئي بمبلغ ${parsedAmount} بنجاح`);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/:id/reject ─────────────────────────────────────
router.post(['/:id/admin/reject', '/:id/reject'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { decisionReason, internalNote } = req.body;

    if (!decisionReason) throw new AppError('سبب وتبرير قرار الرفض مطلوب', 400);

    const updated = await RefundService.adminResolve({
      refundId: id,
      adminUserId: req.user!.userId,
      decision: 'REJECT',
      decisionReason,
      internalNote,
    });

    ResponseUtil.success(res, updated, 'تم إصدار قرار رفض الاسترجاع وإغلاق النزاع بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/wallet/adjust ──────────────────────────────────
router.post('/wallet/adjust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUserId = req.user!.userId;
    const { targetUserId, amount, direction, reason, reference } = req.body;

    const result = await CustomerWalletService.manualAdjustment({
      adminUserId,
      targetUserId,
      amount: parseFloat(amount),
      direction,
      reason,
      reference,
    });

    ResponseUtil.success(res, result, 'تم تنفيذ التسوية المالية للمحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/admin/refunds/:id/messages ──────────────────────────────────
router.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { message, isPrivateAdminNote = false } = req.body;
    if (!message || !message.trim()) {
      throw new AppError('نص الرسالة مطلوب', 400);
    }
    const refund = await prisma.refundRequest.findUnique({
      where: { id },
      include: { seller: { include: { user: true } }, customer: true },
    });
    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const newMsg = await prisma.refundMessage.create({
      data: {
        refundRequestId: refund.id,
        senderId: req.user!.userId,
        senderRole: RefundActorType.ADMIN,
        message: message.trim(),
        isPrivateAdminNote: !!isPrivateAdminNote,
      },
    });

    if (!isPrivateAdminNote) {
      // Notify customer
      await prisma.notification.create({
        data: {
          userId: refund.customerId,
          titleAr: `رسالة جديدة من إدارة سوقناا حول النزاع #${refund.refundNumber}`,
          titleEn: `Admin Message on Refund #${refund.refundNumber}`,
          bodyAr: message.trim(),
          bodyEn: message.trim(),
          type: NotificationType.REFUND_DISPUTED,
          data: JSON.stringify({ refundId: refund.id }),
        },
      });
      // Notify seller
      if (refund.seller?.userId) {
        await prisma.notification.create({
          data: {
            userId: refund.seller.userId,
            titleAr: `توجيه إداري من إدارة سوقناا حول النزاع #${refund.refundNumber}`,
            titleEn: `Admin Directive on Refund #${refund.refundNumber}`,
            bodyAr: message.trim(),
            bodyEn: message.trim(),
            type: NotificationType.REFUND_DISPUTED,
            data: JSON.stringify({ refundId: refund.id }),
          },
        });
      }
    }

    try {
      SocketService.get()?.emitToRoom(`refund:${refund.id}`, 'refund:message', newMsg);
    } catch (_) {}

    ResponseUtil.success(res, newMsg, 'تم إرسال الرسالة بنجاح');
  } catch (error) {
    next(error);
  }
});

export const adminRefundRoutes = router;
