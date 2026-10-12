import { Router, Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../../../utils/response.util';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { sellerPromotionService } from '../services/seller-promotion.service';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { SocketService } from '../../../services/websocket/socket.service';

const router = Router();
router.use(authenticate);
router.use(authorize('ADMIN'));

// ────────────────────────────────────────────────────────────────────────────
// PACKAGE MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

// GET /api/v1/admin/marketing/packages
router.get('/packages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const packages = await prisma.sellerPromotionPackage.findMany({
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
    });
    ResponseUtil.success(res, packages);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/marketing/packages
router.post('/packages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      nameAr,
      description,
      descriptionAr,
      placementKey,
      promotionType,
      price,
      currency,
      durationDays,
      impressionLimit,
      clickLimit,
      dailyImpressionLimit,
      allowsCustomCreative,
      allowsCategoryTarget,
      allowsGeoTarget,
      maxConcurrent,
      displayOrder,
    } = req.body;

    if (!name || !nameAr) throw new AppError('اسم الباقة مطلوب (عربي وإنجليزي)', 400);
    if (!placementKey) throw new AppError('مفتاح المنصة مطلوب', 400);
    if (!price || price <= 0) throw new AppError('سعر الباقة يجب أن يكون أكبر من صفر', 400);

    const pkg = await sellerPromotionService.createPackage({
      name,
      nameAr,
      description,
      descriptionAr,
      placementKey,
      promotionType,
      price,
      currency: currency || 'YER',
      durationDays: durationDays ?? 7,
      impressionLimit,
      clickLimit,
      dailyImpressionLimit,
      allowsCustomCreative: allowsCustomCreative ?? false,
      allowsCategoryTarget: allowsCategoryTarget ?? false,
      allowsGeoTarget: allowsGeoTarget ?? false,
      maxConcurrent: maxConcurrent ?? 1,
      displayOrder: displayOrder ?? 0,
    });

    ResponseUtil.created(res, pkg, 'تم إنشاء الباقة الإعلانية بنجاح');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/marketing/packages/:id
router.patch('/packages/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await sellerPromotionService.updatePackage(
      String(req.params.id),
      req.body,
    );
    ResponseUtil.success(res, updated, 'تم تعديل الباقة بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/marketing/packages/:id  — archive only (no hard delete)
router.delete('/packages/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await prisma.sellerPromotionPackage.update({
      where: { id: String(req.params.id) },
      data: { status: 'ARCHIVED' },
    });
    ResponseUtil.success(res, updated, 'تم أرشفة الباقة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SELLER PROMOTION APPROVAL QUEUE
// ────────────────────────────────────────────────────────────────────────────

// GET /api/v1/admin/marketing/seller-promotions
// Approval queue with optional status filter
router.get('/seller-promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, sellerId, placementKey, page, limit } = req.query;

    // Default: show all promotions that need attention
    const statusFilter = status
      ? (String(status).split(',') as any[])
      : ['ADMIN_REVIEW', 'PAID', 'ACTIVE', 'PAUSED', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'ADMIN_REJECTED', 'CANCELLED'];

    const result = await sellerPromotionService.getAdminQueue({
      status: statusFilter,
      sellerId: sellerId as string,
      placementKey: placementKey as string,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/marketing/seller-promotions/stats
// Dashboard statistics
router.get('/seller-promotions/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [pending, active, totalRevenue, totalPromotions] = await Promise.all([
      prisma.sellerPromotion.count({
        where: { status: { in: ['ADMIN_REVIEW', 'PAID'] } },
      }),
      prisma.sellerPromotion.count({ where: { status: 'ACTIVE' } }),
      prisma.sellerPromotionPayment.aggregate({
        where: { paymentType: 'CHARGE', status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      prisma.sellerPromotion.count(),
    ]);

    ResponseUtil.success(res, {
      pendingApprovals: pending,
      activePromotions: active,
      totalRevenue: totalRevenue._sum.amount ?? 0,
      totalPromotions,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/marketing/seller-promotions/:id
// Full detail with product preview for approval
router.get('/seller-promotions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = await sellerPromotionService.getPromotionDetail(String(req.params.id));
    ResponseUtil.success(res, detail);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/marketing/seller-promotions/:id/approve
router.post(
  '/seller-promotions/:id/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user?.userId;
      const { startAt, adminNote } = req.body;

      const updated = await sellerPromotionService.approvePromotion({
        promotionId: String(req.params.id),
        adminId,
        startAt: startAt ? new Date(startAt) : undefined,
        adminNote,
      });

      SocketService.get()?.emitGlobal('admin:seller_promotion_updated', updated);
      SocketService.get()?.emitGlobal('seller:promotion_updated', updated);

      ResponseUtil.success(res, updated, 'تمت الموافقة على الحملة الإعلانية بنجاح');
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/v1/admin/marketing/seller-promotions/:id/reject
router.post(
  '/seller-promotions/:id/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user?.userId;
      const { rejectionReason } = req.body;

      if (!rejectionReason) {
        throw new AppError('يجب تحديد سبب الرفض', 400);
      }

      const updated = await sellerPromotionService.rejectPromotion({
        promotionId: String(req.params.id),
        adminId,
        rejectionReason,
      });

      SocketService.get()?.emitGlobal('admin:seller_promotion_updated', updated);
      SocketService.get()?.emitGlobal('seller:promotion_updated', updated);

      ResponseUtil.success(res, updated, 'تم رفض الحملة وسيتم إشعار البائع');
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/v1/admin/marketing/seller-promotions/:id/pause
router.post(
  '/seller-promotions/:id/pause',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user?.userId;
      const { reason } = req.body;
      const updated = await sellerPromotionService.pausePromotion(
        String(req.params.id),
        adminId,
        reason,
      );
      SocketService.get()?.emitGlobal('admin:seller_promotion_updated', updated);
      ResponseUtil.success(res, updated, 'تم إيقاف الحملة مؤقتاً');
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/v1/admin/marketing/seller-promotions/:id/resume
router.post(
  '/seller-promotions/:id/resume',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user?.userId;
      const updated = await sellerPromotionService.resumePromotion(
        String(req.params.id),
        adminId,
      );
      SocketService.get()?.emitGlobal('admin:seller_promotion_updated', updated);
      ResponseUtil.success(res, updated, 'تم استئناف الحملة بنجاح');
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /api/v1/admin/marketing/seller-promotions/:id
router.delete(
  '/seller-promotions/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user?.userId;
      const { reason } = req.body || {};
      const deleted = await sellerPromotionService.deletePromotion(
        String(req.params.id),
        adminId,
        reason,
      );
      ResponseUtil.success(res, deleted, 'تم إلغاء وحذف ترويج التاجر بنجاح');
    } catch (error) {
      next(error);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// SPONSORED PRODUCT SERVING (Customer-facing — mounted under admin for internal use)
// GET /api/v1/admin/marketing/sponsored-products/:placementKey
// ────────────────────────────────────────────────────────────────────────────
router.get(
  '/sponsored-products/:placementKey',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = await sellerPromotionService.getActiveSponsoredProducts(
        String(req.params.placementKey).toUpperCase(),
        { limit: 10 },
      );
      ResponseUtil.success(res, results);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/v1/admin/marketing/expire-promotions
// Called by scheduler to expire/activate promotions
router.post('/expire-promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await sellerPromotionService.expireCompletedPromotions();
    ResponseUtil.success(res, result, `تم تحديث ${result.expired + result.activated} حملة`);
  } catch (error) {
    next(error);
  }
});

export const adminSellerPromotionRoutes = router;
