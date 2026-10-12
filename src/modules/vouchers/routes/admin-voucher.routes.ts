import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate } from '../../../middleware/auth.middleware';
import { requireAdmin } from '../../../middleware/rbac.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { VoucherService } from '../voucher.service';
import { VoucherAnalyticsService } from '../services/voucher-analytics.service';

const router = Router();
router.use(authenticate, requireAdmin);

// GET /api/v1/admin/vouchers/analytics — Marketplace-wide analytics
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await VoucherAnalyticsService.getAdminAnalytics({
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/vouchers — List all vouchers with filters
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      status,
      ownerType,
      voucherType,
      search,
      page = '1',
      limit = '20',
    } = req.query;

    const where: any = {};
    if (status) where.status = status;
    if (ownerType) where.ownerType = ownerType;
    if (voucherType) where.voucherType = voucherType;
    if (search && typeof search === 'string') {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const pageNum = parseInt(page as string, 10) || 1;
    const limitNum = parseInt(limit as string, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [total, vouchers] = await Promise.all([
      prisma.voucher.count({ where }),
      prisma.voucher.findMany({
        where,
        include: {
          seller: { include: { stores: true } },
          _count: {
            select: {
              customerVouchers: true,
              redemptions: true,
            },
          },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limitNum,
      }),
    ]);

    ResponseUtil.paginated(res, vouchers, pageNum, limitNum, total);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/vouchers — Create platform or managed voucher
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body;

    const rawCode = body.code;
    const rawName = body.name || body.titleAr || body.titleEn || body.title;
    const description = body.description || body.titleAr || body.titleEn;
    const ownerType = body.ownerType || 'PLATFORM';
    let voucherType = body.voucherType || 'DISCOUNT';
    let scopeType = body.scopeType || 'PLATFORM';
    if (['STORE', 'SELLER', 'PRODUCT', 'CATEGORY', 'PRODUCT_SET', 'CART', 'PLATFORM'].includes(String(voucherType).toUpperCase())) {
      scopeType = String(voucherType).toUpperCase() as any;
      voucherType = 'DISCOUNT';
    }
    const rawDiscountType = body.discountType || 'PERCENTAGE';
    const discountType = rawDiscountType === 'FIXED_AMOUNT' ? 'FIXED' : rawDiscountType;
    const rawDiscountValue = body.discountValue !== undefined ? body.discountValue : body.value;
    const rawMaxDiscount = body.maximumDiscount !== undefined ? body.maximumDiscount : body.maxDiscount;
    const rawMinSpend = body.minimumOrderAmount !== undefined ? body.minimumOrderAmount : (body.minSpend ?? 0);
    const rawMinEligible = body.minimumEligibleAmount !== undefined ? body.minimumEligibleAmount : (body.minSpend ?? 0);
    const currency = body.currency || 'SAR';
    const isClaimable = body.isClaimable !== undefined ? Boolean(body.isClaimable) : true;
    const isAutoApply = body.isAutoApply !== undefined ? Boolean(body.isAutoApply) : false;
    const isStackable = body.isStackable !== undefined ? Boolean(body.isStackable) : false;
    const priority = parseInt(body.priority as any, 10) || 0;
    const usageLimit = body.usageLimit ? parseInt(body.usageLimit, 10) : undefined;
    const claimLimit = body.claimLimit ? parseInt(body.claimLimit, 10) : undefined;
    const perCustomerClaimLimit = body.perCustomerClaimLimit ?? body.perCustomerLimit ?? 1;
    const perCustomerUsageLimit = body.perCustomerUsageLimit ?? body.perCustomerLimit ?? 1;
    const rawStartAt = body.startAt || body.validFrom;
    const rawEndAt = body.endAt || body.validUntil;
    const firstOrderOnly = Boolean(body.firstOrderOnly);
    const newCustomerOnly = Boolean(body.newCustomerOnly);
    const sellerId = body.sellerId;
    const fundingType = body.fundingType || 'PLATFORM';
    const freeShipping = Boolean(body.freeShipping) || voucherType === 'FREE_SHIPPING';
    const maximumShippingDiscount = body.maximumShippingDiscount ? parseFloat(body.maximumShippingDiscount) : undefined;
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];

    if (!rawCode || !rawName || rawDiscountValue === undefined) {
      throw new AppError('يرجى ملء جميع الحقول الإلزامية للقسيمة (الرمز، الاسم، وقيمة الخصم)', 400);
    }

    const code = String(rawCode).trim().toUpperCase();
    const name = String(rawName).trim();
    const discountValue = parseFloat(rawDiscountValue);
    if (isNaN(discountValue) || discountValue <= 0) {
      throw new AppError('قيمة الخصم يجب أن تكون رقماً أكبر من صفر', 400);
    }

    const startAt = rawStartAt ? new Date(rawStartAt) : new Date();
    const endAt = rawEndAt ? new Date(rawEndAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      throw new AppError('تاريخ صلاحية القسيمة غير صالح', 400);
    }

    if (startAt >= endAt) {
      throw new AppError('تاريخ انتهاء القسيمة يجب أن يكون بعد تاريخ البدء', 400);
    }

    const created = await VoucherService.createVoucher({
      code,
      name,
      description,
      ownerType,
      ownerId: req.user!.userId,
      voucherType,
      discountType,
      discountValue,
      maximumDiscount: rawMaxDiscount ? parseFloat(rawMaxDiscount) : undefined,
      minimumOrderAmount: rawMinSpend ? parseFloat(rawMinSpend) : 0,
      minimumEligibleAmount: rawMinEligible ? parseFloat(rawMinEligible) : 0,
      currency,
      scopeType,
      isClaimable,
      isAutoApply,
      isStackable,
      priority,
      usageLimit,
      claimLimit,
      perCustomerClaimLimit: parseInt(perCustomerClaimLimit as any, 10) || 1,
      perCustomerUsageLimit: parseInt(perCustomerUsageLimit as any, 10) || 1,
      startAt,
      endAt,
      status: 'ACTIVE',
      firstOrderOnly,
      newCustomerOnly,
      sellerId,
      fundingType,
      freeShipping: freeShipping || voucherType === 'FREE_SHIPPING',
      maximumShippingDiscount,
      productIds,
      categoryIds,
      createdBy: req.user!.userId,
    });

    ResponseUtil.success(res, created, 'تم إنشاء القسيمة بنجاح', 201);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/vouchers/:id — Voucher detail
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const voucher = await prisma.voucher.findUnique({
      where: { id: String(req.params.id) },
      include: {
        seller: { include: { stores: true } },
        products: { include: { product: true } },
        categories: { include: { category: true } },
        _count: { select: { customerVouchers: true, redemptions: true } },
      },
    });
    if (!voucher) throw new AppError('القسيمة غير موجودة', 404);
    ResponseUtil.success(res, voucher);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/vouchers/:id — Update voucher
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await VoucherService.updateVoucher(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل القسيمة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/vouchers/:id/activate — Activate
router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'ACTIVE');
    ResponseUtil.success(res, updated, 'تم تفعيل القسيمة');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/vouchers/:id/pause — Pause
router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'PAUSED');
    ResponseUtil.success(res, updated, 'تم إيقاف القسيمة مؤقتاً');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/vouchers/:id/disable — Disable
router.post('/:id/disable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'DISABLED');
    ResponseUtil.success(res, updated, 'تم تعطيل القسيمة');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/vouchers/:id/revoke — Revoke unredeemed vouchers from customers
router.post('/:id/revoke', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      // Mark voucher disabled
      await tx.voucher.update({
        where: { id },
        data: { status: 'DISABLED' },
      });

      // Revoke unclaimed or unredeemed vouchers
      const updatedCount = await tx.customerVoucher.updateMany({
        where: {
          voucherId: id,
          status: 'CLAIMED',
        },
        data: {
          status: 'REVOKED',
        },
      });

      return updatedCount;
    });

    ResponseUtil.success(res, result, 'تم إبطال القسيمة وسحبها من المستخدمين الذين لم يستخدموها بعد');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/vouchers/:id/redemptions — Redemption audit logs
router.get('/:id/redemptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const redemptions = await prisma.voucherRedemption.findMany({
      where: { voucherId: String(req.params.id) },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        order: { select: { id: true, orderNumber: true, total: true, createdAt: true } },
      },
      orderBy: { redeemedAt: 'desc' },
      take: 100,
    });
    ResponseUtil.success(res, redemptions);
  } catch (error) {
    next(error);
  }
});

export const adminVoucherRoutes = router;
