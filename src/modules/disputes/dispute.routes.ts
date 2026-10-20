import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, authorize } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { DisputeService } from './dispute.service';
import { DisputeStatus, RefundActorType, UserRoleType } from '@prisma/client';

const router = Router();
router.use(authenticate);

// ── GET /api/v1/disputes ──────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;
    const status = req.query.status as DisputeStatus | undefined;
    const search = (req.query.search as string)?.trim();

    const where: any = {};

    if (userRole === 'ADMIN') {
      // Admin sees all
    } else {
      // Check if user is a seller
      const seller = await prisma.seller.findFirst({ where: { userId } });
      if (seller) {
        where.sellerId = seller.id;
      } else {
        where.customerId = userId;
      }
    }

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { reason: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { orderId: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, disputes] = await Promise.all([
      prisma.dispute.count({ where }),
      prisma.dispute.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
          seller: {
            include: {
              stores: { select: { id: true, name: true, logo: true } },
            },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      disputes,
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

// ── GET /api/v1/disputes/:id ──────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        seller: {
          include: {
            stores: { select: { id: true, name: true, logo: true } },
            user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    // Authorization
    const isAdmin = userRole === 'ADMIN';
    const isCustomer = dispute.customerId === userId;
    const isSeller = dispute.seller.userId === userId;

    if (!isAdmin && !isCustomer && !isSeller) {
      throw new AppError('غير مصرح لك بالاطلاع على تفاصيل هذا النزاع', 403);
    }

    // Correlated Order and Refund data
    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: dispute.orderId }, { orderNumber: dispute.orderId }],
      },
      include: {
        sellerOrders: { include: { items: true } },
        payment: true,
      },
    });

    const refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: dispute.orderId },
      include: {
        evidence: { orderBy: { createdAt: 'desc' } },
        messages: {
          where: isAdmin ? {} : { isPrivateAdminNote: false },
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });

    ResponseUtil.success(res, {
      ...dispute,
      order,
      evidence: refundReq?.evidence || [],
      messages: refundReq?.messages || [],
      statusHistory: refundReq?.statusHistory || [],
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes ─────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.user!.userId;
    const { orderId, reason, description, refundRequestId, evidence } = req.body;

    if (!orderId) throw new AppError('معرف الطلب مطلوب', 400);

    const dispute = await DisputeService.openDispute({
      customerId,
      orderId,
      reason,
      description,
      refundRequestId,
      evidence,
    });

    ResponseUtil.created(res, dispute, 'تم فتح النزاع بنجاح وجارٍ مراجعته من قبل إدارة المنصة');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/respond ─────────────────────────────────────────
router.post('/:id/respond', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const sellerUserId = req.user!.userId;
    const { response, acceptClaim, evidence } = req.body;

    const updated = await DisputeService.sellerRespond({
      disputeId,
      sellerUserId,
      response,
      acceptClaim,
      evidence,
    });

    ResponseUtil.success(res, updated, 'تم تسجيل رد المتجر وإشعار الأطراف بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/evidence ────────────────────────────────────────
router.post('/:id/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const { fileUrl, fileType, fileSize, mimeType, description } = req.body;

    const actorRole =
      userRole === 'SELLER'
        ? RefundActorType.SELLER
        : userRole === 'ADMIN'
        ? RefundActorType.ADMIN
        : RefundActorType.CUSTOMER;

    const evidence = await DisputeService.submitEvidence({
      disputeId,
      userId,
      role: actorRole,
      fileUrl,
      fileType,
      fileSize,
      mimeType,
      description,
    });

    ResponseUtil.created(res, evidence, 'تم إرفاق الدليل بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/messages ────────────────────────────────────────
router.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const senderId = req.user!.userId;
    const userRole = req.user!.role;
    const { message, isPrivateAdminNote } = req.body;

    const actorRole =
      userRole === 'SELLER'
        ? RefundActorType.SELLER
        : userRole === 'ADMIN'
        ? RefundActorType.ADMIN
        : RefundActorType.CUSTOMER;

    const createdMsg = await DisputeService.sendMessage({
      disputeId,
      senderId,
      senderRole: actorRole,
      message,
      isPrivateAdminNote: !!isPrivateAdminNote,
    });

    ResponseUtil.created(res, createdMsg, 'تم إرسال الرسالة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/request-info ────────────────────────────────────
router.post('/:id/request-info', authorize(UserRoleType.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const adminUserId = req.user!.userId;
    const { targetRole, requestNote, deadlineHours } = req.body;

    if (!targetRole || (targetRole !== 'CUSTOMER' && targetRole !== 'SELLER')) {
      throw new AppError('الطرف المستهدف مطلوب (CUSTOMER أو SELLER)', 400);
    }

    const result = await DisputeService.requestInformation({
      disputeId,
      adminUserId,
      targetRole,
      requestNote,
      deadlineHours: deadlineHours ? parseInt(deadlineHours, 10) : 48,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/resolve ─────────────────────────────────────────
router.post('/:id/resolve', authorize(UserRoleType.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const adminUserId = req.user!.userId;
    const { decision, resolution, refundAmount, note } = req.body;

    if (!decision) throw new AppError('قرار النزاع مطلوب', 400);

    const updated = await DisputeService.resolveDispute({
      disputeId,
      adminUserId,
      decision,
      resolution,
      refundAmount: refundAmount ? parseFloat(refundAmount) : 0,
      note,
    });

    ResponseUtil.success(res, updated, 'تم إصدار قرار النزاع وتسجيله بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/disputes/:id/appeal ──────────────────────────────────────────
router.post('/:id/appeal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const { appealReason, evidence } = req.body;

    const role = userRole === 'SELLER' ? 'SELLER' : 'CUSTOMER';

    const updated = await DisputeService.appealDispute({
      disputeId,
      userId,
      role,
      appealReason,
      evidence,
    });

    ResponseUtil.success(res, updated, 'تم تسجيل طلب الاستئناف بنجاح وإحالته للمراجعة');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/disputes/:id/sync ─────────────────────────────────────────────
router.get('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const disputeId = String(req.params.id);
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const sinceParam = req.query.since as string | undefined;
    const since = sinceParam ? new Date(sinceParam) : undefined;

    const syncData = await DisputeService.syncDispute(disputeId, userId, userRole, since);
    ResponseUtil.success(res, syncData);
  } catch (error) {
    next(error);
  }
});

export const disputeRoutes = router;
