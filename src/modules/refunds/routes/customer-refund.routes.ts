import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { RefundService } from '../services/refund.service';
import { RefundEligibilityService } from '../services/refund-eligibility.service';
import { RefundStateMachine } from '../refund.state-machine';
import { RefundActorType } from '@prisma/client';
import { requireFeature } from '../../remote-config/remote-config.middleware';

const router = Router();
router.use(authenticate);

// ── GET /api/v1/customer/refunds/reasons ──────────────────────────────────────
router.get('/reasons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let reasons = await prisma.refundReason.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
    });

    if (reasons.length === 0) {
      const defaults = [
        { code: 'DAMAGED', nameAr: 'المنتج تالف أو به كسر', nameEn: 'Product damaged', requiresDescription: false, displayOrder: 1 },
        { code: 'DEFECTIVE', nameAr: 'المنتج به عيب مصنعي أو لا يعمل', nameEn: 'Product defective', requiresDescription: false, displayOrder: 2 },
        { code: 'NOT_AS_DESCRIBED', nameAr: 'المنتج غير مطابق للوصف والصور', nameEn: 'Product not as described', requiresDescription: false, displayOrder: 3 },
        { code: 'WRONG_ITEM', nameAr: 'استلمت منتجاً مختلفاً أو مقاساً خاطئاً', nameEn: 'Wrong product received', requiresDescription: false, displayOrder: 4 },
        { code: 'MISSING_ITEM', nameAr: 'عناصر ناقصة أو شحنة غير مكتملة', nameEn: 'Missing items in package', requiresDescription: false, displayOrder: 5 },
        { code: 'WRONG_QUANTITY', nameAr: 'الكمية المستلمة غير صحيحة', nameEn: 'Wrong quantity', requiresDescription: false, displayOrder: 6 },
        { code: 'OTHER', nameAr: 'سبب آخر (يتطلب توضيحاً كتابياً)', nameEn: 'Other reason', requiresDescription: true, displayOrder: 7 },
      ];

      for (const d of defaults) {
        await prisma.refundReason.upsert({
          where: { code: d.code },
          update: {},
          create: d,
        });
      }

      reasons = await prisma.refundReason.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
      });
    }

    ResponseUtil.success(res, reasons);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/customer/refunds/orders/:orderId/eligibility ─────────────────
router.get('/orders/:orderId/eligibility', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const orderId = String(req.params.orderId);
    const eligibility = await RefundEligibilityService.checkOrderEligibility(orderId, customerId);
    ResponseUtil.success(res, eligibility);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/customer/refunds ─────────────────────────────────────────────
router.post(
  '/',
  requireFeature('refunds', 'تقديم طلبات الإرجاع واسترداد الأموال معطل حالياً لأسباب الصيانة التشغيلية.'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
    const customerId = req.user!.userId;
    const {
      orderId,
      reasonId,
      reasonText,
      description,
      customerNote,
      destination,
      walletProvider,
      walletNumber,
      walletHolderName,
      items,
      evidence,
    } = req.body;

    if (!orderId) throw new AppError('معرف الطلب مطلوب', 400);
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('يجب تحديد المنتجات والكميات المطلوبة للاسترجاع', 400);
    }

    const refund = await RefundService.createRefundRequest({
      orderId,
      customerId,
      reasonId,
      reasonText,
      description,
      customerNote,
      destination,
      walletProvider,
      walletNumber,
      walletHolderName,
      items,
      evidence,
    });

    ResponseUtil.created(res, refund, 'تم تقديم طلب الاسترجاع بنجاح وجارٍ مراجعته من قبل المتجر');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/customer/refunds ──────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where: any = { customerId };
    if (status && status.toUpperCase() !== 'ALL') {
      where.status = status;
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
          seller: {
            include: {
              stores: { select: { name: true, logo: true }, take: 1 },
            },
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
        availableActions: RefundStateMachine.getAvailableActions(r.status, RefundActorType.CUSTOMER),
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

// ── GET /api/v1/customer/refunds/:id ──────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const id = String(req.params.id);

    const refund = await prisma.refundRequest.findFirst({
      where: {
        id,
        customerId,
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
        manualTransfer: {
          select: {
            id: true,
            walletProvider: true,
            walletNumberMasked: true,
            status: true,
            createdAt: true,
          },
        },
        messages: {
          where: { isPrivateAdminNote: false },
          orderBy: { createdAt: 'asc' },
        },
        seller: {
          include: {
            stores: { select: { name: true, logo: true }, take: 1 },
          },
        },
        order: {
          include: {
            payment: true,
          },
        },
      },
    });

    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const availableActions = RefundStateMachine.getAvailableActions(
      refund.status,
      RefundActorType.CUSTOMER
    );

    ResponseUtil.success(res, {
      ...refund,
      availableActions,
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/customer/refunds/:id/evidence ────────────────────────────────
router.post('/:id/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const id = String(req.params.id);
    const { fileUrl, fileType, fileSize, mimeType, description } = req.body;

    if (!fileUrl) throw new AppError('رابط الملف مطلوب', 400);

    const refund = await prisma.refundRequest.findFirst({
      where: { id, customerId },
    });
    if (!refund) throw new AppError('طلب الاسترجاع غير موجود', 404);

    const evidence = await prisma.refundEvidence.create({
      data: {
        refundRequestId: id,
        uploadedBy: customerId,
        uploadedByRole: RefundActorType.CUSTOMER,
        fileUrl,
        fileType: fileType || 'image/jpeg',
        fileSize: fileSize || 0,
        mimeType: mimeType || 'image/jpeg',
        description: description || null,
      },
    });

    ResponseUtil.created(res, evidence, 'تم إرفاق الدليل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/customer/refunds/:id/customer/accept ─────────────────────────
router.post(['/:id/customer/accept', '/:id/accept-rejection'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const id = String(req.params.id);

    const updated = await RefundService.customerAcceptDecision(id, customerId);
    ResponseUtil.success(res, updated, 'تم تأكيد قرار المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/customer/refunds/:id/customer/dispute ────────────────────────
router.post(['/:id/customer/dispute', '/:id/dispute'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const id = String(req.params.id);
    const { disputeReason, reason, evidence } = req.body;

    const finalReason = disputeReason || reason;
    if (!finalReason || finalReason.trim().length < 5) {
      throw new AppError('يرجى توضيح سبب النزاع وطلب تدخل الإدارة بالتفصيل', 400);
    }

    const updated = await RefundService.customerDispute(id, customerId, finalReason, evidence);
    ResponseUtil.success(res, updated, 'تم فتح النزاع بنجاح وتم إحالته إلى إدارة المنصة للتحكيم');
  } catch (error) {
    next(error);
  }
});

export const customerRefundRoutes = router;
