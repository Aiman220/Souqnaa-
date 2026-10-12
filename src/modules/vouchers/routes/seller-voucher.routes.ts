import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { authenticate } from '../../../middleware/auth.middleware';
import { requireSeller } from '../../../middleware/rbac.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { VoucherService } from '../voucher.service';
import { VoucherAnalyticsService } from '../services/voucher-analytics.service';

const router = Router();
router.use(authenticate, requireSeller);

async function invalidateStorefrontCache(sellerId: string) {
  try {
    const stores = await prisma.store.findMany({
      where: { sellerId },
      select: { id: true, slug: true },
    });
    for (const store of stores) {
      await Promise.all([
        redis.del(`storefront:${store.slug}`),
        redis.del(`storefront:${store.id}`),
      ]);
    }
  } catch (_) {}
}

async function getSellerId(userId: string): Promise<string> {
  let seller = await prisma.seller.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!seller) {
    seller = await prisma.seller.findFirst({
      select: { id: true },
    });
  }
  if (!seller) {
    throw new AppError('لم يتم العثور على حساب بائع مرتبط', 403);
  }
  return seller.id;
}

// GET /api/v1/seller/vouchers/analytics/summary — Overall vouchers analytics
router.get('/analytics/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const summary = await VoucherAnalyticsService.getSellerAnalytics(sellerId);
    ResponseUtil.success(res, summary);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/vouchers — List seller vouchers
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const status = req.query.status as string | undefined;

    const where: any = {
      OR: [{ sellerId }, { ownerId: sellerId }],
    };
    if (status && status !== 'ALL') where.status = status;

    const vouchers = await prisma.voucher.findMany({
      where,
      include: {
        products: { include: { product: true } },
        categories: { include: { category: true } },
        _count: {
          select: {
            customerVouchers: true,
            redemptions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, vouchers);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/vouchers — Create seller voucher
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const body = req.body;

    const rawCode = body.code;
    const rawName = body.name || body.titleAr || body.titleEn || body.title;
    const description = body.description || body.titleAr || body.titleEn;
    let voucherType = body.voucherType || 'DISCOUNT';
    let scopeType = body.scopeType || 'SELLER';
    if (['STORE', 'SELLER', 'PRODUCT', 'CATEGORY', 'PRODUCT_SET', 'CART'].includes(String(voucherType).toUpperCase())) {
      scopeType = String(voucherType).toUpperCase() as any;
      voucherType = 'DISCOUNT';
    }
    const rawDiscountType = body.discountType || 'PERCENTAGE';
    const discountType = rawDiscountType === 'FIXED_AMOUNT' ? 'FIXED' : rawDiscountType;
    const rawDiscountValue = body.discountValue !== undefined ? body.discountValue : body.value;
    const rawMaxDiscount = body.maximumDiscount !== undefined ? body.maximumDiscount : body.maxDiscount;
    const rawMinSpend = body.minimumOrderAmount !== undefined ? body.minimumOrderAmount : (body.minSpend ?? 0);
    const rawMinEligible = body.minimumEligibleAmount !== undefined ? body.minimumEligibleAmount : (body.minSpend ?? 0);
    const usageLimit = body.usageLimit;
    const claimLimit = body.claimLimit;
    const perCustomerClaimLimit = body.perCustomerClaimLimit ?? body.perCustomerLimit ?? 1;
    const perCustomerUsageLimit = body.perCustomerUsageLimit ?? body.perCustomerLimit ?? 1;
    const rawStartAt = body.startAt || body.validFrom;
    const rawEndAt = body.endAt || body.validUntil;
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

    // Verify product IDs belong to this seller
    if (productIds.length > 0) {
      const storeIds = (
        await prisma.store.findMany({
          where: { sellerId },
          select: { id: true },
        })
      ).map((s) => s.id);

      const count = await prisma.product.count({
        where: {
          id: { in: productIds },
          storeId: { in: storeIds },
        },
      });

      if (count !== productIds.length) {
        throw new AppError('بعض المنتجات المحددة لا تنتمي لمتجرك', 403);
      }
    }

    const created = await VoucherService.createVoucher({
      code,
      name,
      description,
      ownerType: 'SELLER',
      ownerId: sellerId,
      sellerId,
      fundingType: 'SELLER',
      voucherType,
      discountType,
      discountValue,
      maximumDiscount: rawMaxDiscount ? parseFloat(rawMaxDiscount) : undefined,
      minimumOrderAmount: rawMinSpend ? parseFloat(rawMinSpend) : 0,
      minimumEligibleAmount: rawMinEligible ? parseFloat(rawMinEligible) : 0,
      scopeType,
      isClaimable: true,
      usageLimit: usageLimit ? parseInt(usageLimit, 10) : undefined,
      claimLimit: claimLimit ? parseInt(claimLimit, 10) : undefined,
      perCustomerClaimLimit: parseInt(perCustomerClaimLimit as any, 10) || 1,
      perCustomerUsageLimit: parseInt(perCustomerUsageLimit as any, 10) || 1,
      startAt,
      endAt,
      status: 'ACTIVE',
      productIds,
      categoryIds,
      createdBy: req.user!.userId,
    });

    await invalidateStorefrontCache(sellerId);

    ResponseUtil.success(res, created, 'تم إنشاء قسيمة المتجر بنجاح', 201);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/vouchers/:id — Voucher detail
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const voucher = await prisma.voucher.findUnique({
      where: { id: String(req.params.id) },
      include: {
        products: { include: { product: true } },
        categories: { include: { category: true } },
        _count: { select: { customerVouchers: true, redemptions: true } },
      },
    });

    if (!voucher) throw new AppError('القسيمة غير موجودة', 404);
    if (voucher.sellerId !== sellerId && voucher.ownerId !== sellerId) {
      throw new AppError('غير مصرح لك بالوصول إلى هذه القسيمة', 403);
    }

    ResponseUtil.success(res, voucher);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/seller/vouchers/:id — Update voucher
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const updated = await VoucherService.updateVoucher(String(req.params.id), req.body, sellerId);
    await invalidateStorefrontCache(sellerId);
    ResponseUtil.success(res, updated, 'تم تعديل القسيمة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/vouchers/:id/activate — Activate
router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'ACTIVE', sellerId);
    await invalidateStorefrontCache(sellerId);
    ResponseUtil.success(res, updated, 'تم تفعيل القسيمة');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/vouchers/:id/pause — Pause
router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'PAUSED', sellerId);
    await invalidateStorefrontCache(sellerId);
    ResponseUtil.success(res, updated, 'تم إيقاف القسيمة مؤقتاً');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/vouchers/:id/disable — Disable
router.post('/:id/disable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const updated = await VoucherService.setVoucherStatus(String(req.params.id), 'DISABLED', sellerId);
    await invalidateStorefrontCache(sellerId);
    ResponseUtil.success(res, updated, 'تم تعطيل القسيمة');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/vouchers/:id/analytics — Voucher analytics
router.get('/:id/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const analytics = await VoucherAnalyticsService.getSellerAnalytics(sellerId, String(req.params.id));
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/vouchers/:id/send-to-followers & /api/v1/seller/vouchers/send-to-followers
// Broadcast / gift voucher to store followers with auto wallet claim & in-app push notification
router.post(
  ['/:id/send-to-followers', '/send-to-followers', '/:id/distribute', '/distribute'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = await getSellerId(req.user!.userId);
      const voucherId = String(req.params.id || req.body.voucherId || '');

      if (!voucherId) {
        throw new AppError('يرجى تحديد القسيمة المراد إرسالها', 400);
      }

      // Fetch Store Info
      const store = await prisma.store.findFirst({
        where: { sellerId },
        select: { id: true, name: true, slug: true, logo: true },
      });

      // Verify Voucher
      const voucher = await prisma.voucher.findUnique({
        where: { id: voucherId },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
          discountType: true,
          discountValue: true,
          minimumOrderAmount: true,
          sellerId: true,
          ownerId: true,
        },
      });

      if (!voucher) throw new AppError('القسيمة غير موجودة', 404);
      if (voucher.sellerId !== sellerId && voucher.ownerId !== sellerId) {
        throw new AppError('غير مصرح لك بإرسال هذه القسيمة', 403);
      }
      if (voucher.status !== 'ACTIVE') {
        throw new AppError('لا يمكن إرسال قسيمة غير نشطة، يرجى تفعيل القسيمة أولاً', 400);
      }
      if (new Date(voucher.endAt) < new Date()) {
        throw new AppError('هذه القسيمة منتهية الصلاحية', 400);
      }

      const target = String(req.body.target || 'ALL_FOLLOWERS');
      const customMessage = req.body.customMessage ? String(req.body.customMessage).trim() : null;
      let recipientUserIds: string[] = [];

      if (target === 'ALL_FOLLOWERS') {
        const follows = await prisma.socialFollow.findMany({
          where: {
            followedUserId: req.user!.userId,
            relationshipType: 'CUSTOMER_TO_SELLER',
            status: 'FOLLOWING',
          },
          select: { followerUserId: true },
        });
        recipientUserIds = follows.map((f) => f.followerUserId);
      } else {
        const rawList = req.body.customerUserIds || req.body.customerIds;
        if (Array.isArray(rawList)) {
          recipientUserIds = rawList.map(String).filter(Boolean);
        } else if (req.body.customerId || req.body.userId) {
          recipientUserIds = [String(req.body.customerId || req.body.userId)];
        }
      }

      if (recipientUserIds.length === 0) {
        if (target === 'ALL_FOLLOWERS') {
          throw new AppError('لا يوجد متابعون لمتجرك حتى الآن لمكافأتهم بالقسيمة.', 400);
        } else {
          throw new AppError('يرجى تحديد العملاء المستلمين للقسيمة.', 400);
        }
      }

      // Deduplicate recipient IDs and remove self
      recipientUserIds = Array.from(new Set(recipientUserIds)).filter((id) => id !== req.user!.userId);

      const storeName = store?.name || 'متجرنا';
      const discountText =
        voucher.discountType === 'PERCENTAGE'
          ? `${voucher.discountValue}%`
          : `${voucher.discountValue} ر.س`;

      const notificationTitleAr = `هدية حصرية من متجر ${storeName} 🎁`;
      const notificationTitleEn = `Exclusive Gift from ${storeName} 🎁`;
      const notificationBodyAr = customMessage
        ? `${customMessage} (كود القسيمة: ${voucher.code})`
        : `أهداك متجر ${storeName} قسيمة خصم بقيمة ${discountText} لمتابعتك المتجر! استخدم الرمز: ${voucher.code}`;
      const notificationBodyEn = `Store ${storeName} gifted you a ${discountText} discount voucher! Use code: ${voucher.code}`;

      // Batch grant CustomerVouchers & create Notifications
      for (const customerId of recipientUserIds) {
        try {
          // 1. Grant to wallet
          await prisma.customerVoucher.upsert({
            where: { customerId_voucherId: { customerId, voucherId: voucher.id } },
            update: { status: 'CLAIMED' },
            create: {
              customerId,
              voucherId: voucher.id,
              status: 'CLAIMED',
              claimSource: 'SELLER_FOLLOWERS',
              claimedAt: new Date(),
              expiresAt: voucher.endAt,
            },
          });

          // 2. Create in-app notification
          const notif = await prisma.notification.create({
            data: {
              userId: customerId,
              titleAr: notificationTitleAr,
              titleEn: notificationTitleEn,
              bodyAr: notificationBodyAr,
              bodyEn: notificationBodyEn,
              type: 'STORE_PROMOTION_TO_FOLLOWERS',
              data: JSON.stringify({
                type: 'VOUCHER_RECEIVED',
                voucherId: voucher.id,
                voucherCode: voucher.code,
                storeId: store?.id,
                storeSlug: store?.slug,
                storeName,
                discountText,
                discountValue: voucher.discountValue,
                discountType: voucher.discountType,
              }),
            },
          });

          // 3. Socket real-time push
          try {
            const socketSvc = (await import('../../../services/websocket/socket.service')).SocketService.get();
            socketSvc?.emitToUser(customerId, 'notification:new', notif);
            socketSvc?.emitToUser(customerId, 'voucher:received', {
              voucherId: voucher.id,
              voucherCode: voucher.code,
              storeName,
              discountText,
            });
          } catch (_) {}
        } catch (_) {}
      }

      // Update claimCount on voucher
      await prisma.voucher.update({
        where: { id: voucher.id },
        data: { claimCount: { increment: recipientUserIds.length } },
      });

      await invalidateStorefrontCache(sellerId);

      ResponseUtil.success(
        res,
        {
          voucherId: voucher.id,
          voucherCode: voucher.code,
          recipientCount: recipientUserIds.length,
          storeName,
        },
        `تم إرسال القسيمة بنجاح إلى ${recipientUserIds.length} من العملاء مع إشعار فوري 🎁`
      );
    } catch (error) {
      next(error);
    }
  }
);

export const sellerVoucherRoutes = router;
