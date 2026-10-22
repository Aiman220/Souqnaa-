import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { RefundService } from '../services/refund.service';
import { RefundStateMachine } from '../refund.state-machine';
import { RefundActorType, RefundStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

async function getSellerProfile(userId: string) {
  const seller = await prisma.seller.findFirst({
    where: { userId },
  });
  if (!seller) {
    throw new AppError('حساب التاجر غير موجود أو غير مفعل', 403);
  }
  return seller;
}

// ── GET /api/v1/seller/refunds ────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSellerProfile(req.user!.userId);
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const skip = (page - 1) * limit;
    const statusParam = req.query.status as string | undefined;

    const where: any = { sellerId: seller.id };
    if (statusParam && statusParam.toUpperCase() !== 'ALL') {
      const upper = statusParam.toUpperCase();
      if (upper === 'DISPUTED' || upper === 'CUSTOMER_DISPUTED' || upper === 'ADMIN_REVIEW') {
        where.status = {
          in: [RefundStatus.CUSTOMER_DISPUTED, RefundStatus.ADMIN_REVIEW, RefundStatus.DISPUTED],
        };
      } else {
        const formatted = upper.includes('_') ? upper : upper.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
        where.status = formatted;
      }
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
          evidence: true,
          customer: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
          order: {
            select: { id: true, orderNumber: true, total: true, status: true, currency: true },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      refunds: refunds.map((r) => ({
        ...r,
        availableActions: RefundStateMachine.getAvailableActions(r.status, RefundActorType.SELLER),
      })),
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

// ── GET /api/v1/seller/refunds/:id ────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSellerProfile(req.user!.userId);
    const id = String(req.params.id);
    let disputeOrderId: string | undefined;
    const matchedDispute = await prisma.dispute.findFirst({
      where: { id, sellerId: seller.id },
      select: { orderId: true },
    });
    if (matchedDispute) {
      disputeOrderId = matchedDispute.orderId;
    }

    const orConditions: any[] = [
      { id },
      { refundNumber: id },
      { orderId: id },
      { order: { orderNumber: id } },
    ];
    if (disputeOrderId) {
      orConditions.push({ orderId: disputeOrderId });
    }

    const refund = await prisma.refundRequest.findFirst({
      where: {
        sellerId: seller.id,
        OR: orConditions,
      },
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
          orderBy: { createdAt: 'asc' },
        },
        sellerDecisions: {
          orderBy: { createdAt: 'desc' },
        },
        customerDecisions: {
          orderBy: { createdAt: 'desc' },
        },
        messages: {
          where: { isPrivateAdminNote: false },
          orderBy: { createdAt: 'asc' },
        },
        customer: {
          select: { id: true, firstName: true, lastName: true, phone: true, email: true },
        },
        order: {
          include: {
            payment: true,
            deliveryAddress: true,
          },
        },
        sellerOrder: true,
        snapshot: true,
      },
    });

    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const availableActions = RefundStateMachine.getAvailableActions(
      refund.status,
      RefundActorType.SELLER
    );

    ResponseUtil.success(res, {
      ...refund,
      availableActions,
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/seller/refunds/:id/accept ────────────────────────────────────
router.post(['/:id/seller/accept', '/:id/accept', '/:id/approve'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason } = req.body;
    const updated = await RefundService.sellerAccept(id, req.user!.userId, reason);
    ResponseUtil.success(res, updated, 'تمت الموافقة على طلب الاسترجاع وإحالته لتأكيد العميل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/seller/refunds/:id/reject ────────────────────────────────────
router.post(['/:id/seller/reject', '/:id/reject'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { rejectionReason, reason, evidence } = req.body;
    const finalReason = rejectionReason || reason;

    if (!finalReason || finalReason.trim().length < 5) {
      throw new AppError('سبب الرفض إلزامي ويجب ألا يقل عن 5 أحرف', 400);
    }

    const updated = await RefundService.sellerReject(
      id,
      req.user!.userId,
      finalReason,
      evidence
    );

    ResponseUtil.success(res, updated, 'تم تسجيل رفض الطلب وإخطار العميل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/seller/refunds/:id/evidence ──────────────────────────────────
router.post('/:id/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSellerProfile(req.user!.userId);
    const id = String(req.params.id);
    const { fileUrl, fileType, fileSize, mimeType, description } = req.body;

    if (!fileUrl) throw new AppError('رابط الملف مطلوب', 400);

    const refund = await prisma.refundRequest.findFirst({
      where: { id, sellerId: seller.id },
    });
    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const evidence = await prisma.refundEvidence.create({
      data: {
        refundRequestId: id,
        uploadedBy: req.user!.userId,
        uploadedByRole: RefundActorType.SELLER,
        fileUrl,
        fileType: fileType || 'image/jpeg',
        fileSize: fileSize || 0,
        mimeType: mimeType || 'image/jpeg',
        description: description || null,
      },
    });

    ResponseUtil.created(res, evidence, 'تم إرفاق دليل المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const sellerRefundRoutes = router;
