import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { authenticate, authorize } from '../../middleware/auth.middleware';
import firstOrderShippingRouter from './routes/first-order-shipping.routes';
import universalShippingRouter from './routes/universal-shipping-promotion.routes';

const router = Router();

// Mount Universal Shipping Promotions Engine routes
router.use('/shipping', universalShippingRouter);
// Mount First-Order Free Shipping Engine routes
router.use('/', firstOrderShippingRouter);

// GET /api/v1/promotions/flash-sales
router.get('/flash-sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gt: now },
      },
      include: {
        items: {
          where: { status: 'ACTIVE' },
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true } },
                store: true,
                inventory: true,
              },
            },
            variant: true,
          },
        },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });

    const formattedFlashSales = campaigns.map((campaign) => {
      const mappedProducts = campaign.items
        .filter((item) => item.product != null)
        .map((item) => {
          const p = item.product;
          const finalPrice =
            item.flashSalePrice && item.flashSalePrice > 0
              ? item.flashSalePrice
              : item.originalPrice ?? p.price;

          return {
            ...p,
            name: p.nameAr || p.nameEn || p.slug || '',
            price: item.originalPrice ?? p.price,
            flashSalePrice: finalPrice,
            compareAtPrice: item.originalPrice ?? p.price,
            isFlashSale: true,
            allocatedStock: item.allocatedStock,
            soldStock: item.soldStock,
            remainingStock: item.remainingStock,
            perCustomerLimit: item.perCustomerLimit,
            images:
              p.images && p.images.length > 0
                ? p.images.map((img: any) => (typeof img === 'string' ? img : img.url))
                : (p as any).imageUrl
                ? [(p as any).imageUrl]
                : [],
          };
        });

      return {
        ...campaign,
        startsAt: campaign.startAt,
        endsAt: campaign.endAt,
        items: campaign.items,
        products: mappedProducts,
      };
    });

    ResponseUtil.success(res, {
      serverTime: now.toISOString(),
      flashSales: formattedFlashSales,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/promotions/banners
router.get('/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banners = await prisma.banner.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    ResponseUtil.success(res, banners);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/promotions/coupons/:code/validate
router.post('/coupons/:code/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const coupon = await prisma.coupon.findUnique({
      where: { code },
    });

    if (!coupon || !coupon.isActive || coupon.validUntil < new Date()) {
      throw new AppError('Coupon is invalid or expired', 400);
    }

    ResponseUtil.success(res, coupon);
  } catch (error) {
    next(error);
  }
});

export const promotionRoutes = router;

// ── Admin Banner CRUD ────────────────────────────────────────────────────────
// These are mounted at /api/v1/admin/promotions to handle the admin "Banners Tab"
// which manages the legacy `Banner` model (imageUrl, titleAr, targetId, sortOrder)
import { Router as AdminRouter } from 'express';
const adminPromotionRouter = AdminRouter();
adminPromotionRouter.use(authenticate);
adminPromotionRouter.use(authorize('ADMIN'));

// GET /api/v1/admin/promotions/banners
adminPromotionRouter.get('/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banners = await prisma.banner.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    ResponseUtil.success(res, banners);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/promotions/banners
adminPromotionRouter.post('/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { titleAr, titleEn, imageUrl, targetType, targetId, sortOrder, isActive } = req.body;
    const banner = await prisma.banner.create({
      data: {
        titleAr: titleAr || '',
        titleEn: titleEn || null,
        imageUrl: imageUrl || '',
        targetType: targetType || 'url',
        targetId: targetId || null,
        sortOrder: sortOrder ?? 0,
        isActive: isActive !== false,
      },
    });
    ResponseUtil.created(res, banner, 'تم إنشاء البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/admin/promotions/banners/:id
adminPromotionRouter.put('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { titleAr, titleEn, imageUrl, targetType, targetId, sortOrder, isActive } = req.body;
    const banner = await prisma.banner.update({
      where: { id: String(req.params.id) },
      data: {
        ...(titleAr !== undefined && { titleAr }),
        ...(titleEn !== undefined && { titleEn }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(targetType !== undefined && { targetType }),
        ...(targetId !== undefined && { targetId }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    ResponseUtil.success(res, banner, 'تم تعديل البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/promotions/banners/:id
adminPromotionRouter.delete('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.banner.delete({
      where: { id: String(req.params.id) },
    });
    ResponseUtil.success(res, null, 'تم حذف البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const adminPromotionRoutes = adminPromotionRouter;

