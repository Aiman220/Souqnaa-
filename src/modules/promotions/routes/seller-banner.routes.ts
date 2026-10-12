import { Router, Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../../../utils/response.util';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { bannerService } from '../services/banner.service';
import { bannerAnalyticsService } from '../services/banner-analytics.service';
import { campaignService } from '../services/campaign.service';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';

const router = Router();
router.use(authenticate);
router.use(authorize('SELLER', 'ADMIN'));

// Helper to get seller profile from authenticated user
async function getSellerId(req: Request): Promise<string> {
  const userId = (req as any).user?.userId;
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
    throw new AppError('Seller profile not found for user', 403);
  }
  return seller.id;
}

// GET /api/v1/seller/banners
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const banners = await bannerService.getBanners({ sellerId });
    ResponseUtil.success(res, { banners, items: banners, total: banners.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/banners
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const {
      campaignId,
      name,
      title,
      subtitle,
      description,
      // Accept both mobileImageUrl (canonical) and imageUrl (legacy alias from Dart client)
      mobileImageUrl: _mobileImageUrl,
      imageUrl: _imageUrlAlias,
      desktopImageUrl,
      tabletImageUrl,
      placementKey,
      ctaText,
      ctaType,
      deepLinkUri,
      status,
      startAt: _startAt,
      startsAt: _startsAt,
      endAt: _endAt,
      endsAt: _endsAt,
      translations,
    } = req.body;

    const mobileImageUrl = _mobileImageUrl || _imageUrlAlias;

    if (!mobileImageUrl) {
      throw new AppError('يرجى رفع صورة البانر أولاً (mobileImageUrl is required)', 400);
    }

    const startAt = _startAt || _startsAt;
    const endAt = _endAt || _endsAt;

    // If campaignId is not provided, automatically find or create a default Store Campaign for this seller
    let targetCampaignId = campaignId;
    if (!targetCampaignId) {
      const defaultCampaign = await prisma.campaign.findFirst({
        where: { ownerType: 'SELLER', ownerId: sellerId, status: { not: 'ARCHIVED' } },
        orderBy: { createdAt: 'desc' },
      });

      if (defaultCampaign) {
        targetCampaignId = defaultCampaign.id;
      } else {
        const createdCampaign = await campaignService.createCampaign({
          name: `حملة المتجر الترويجية - ${sellerId.slice(0, 6)}`,
          ownerType: 'SELLER',
          ownerId: sellerId,
          startAt: startAt ? new Date(startAt) : new Date(),
          endAt: endAt ? new Date(endAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          campaignType: 'SELLER',
          createdBy: (req as any).user?.userId,
        });
        targetCampaignId = createdCampaign.id;
      }
    }

    const banner = await bannerService.createBanner(
      {
        campaignId: targetCampaignId,
        name: name || title || 'بانر المتجر الترويجي',
        title,
        subtitle,
        description,
        mobileImageUrl,
        desktopImageUrl,
        tabletImageUrl,
        placementKey: placementKey || 'STORE_TOP',
        ctaText: ctaText || 'عرض المتجر',
        ctaType: ctaType || 'VIEW_STORE',
        deepLinkUri: deepLinkUri || `souqnaa://seller/${sellerId}`,
        status: status || 'SUBMITTED',
        startAt,
        endAt,
        createdBy: (req as any).user?.userId,
        translations,
      },
      { sellerId }
    );

    ResponseUtil.created(res, banner, 'تم إنشاء طلب البانر الترويجي بنجاح وهو قيد المراجعة');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/banners/analytics
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const analytics = await bannerAnalyticsService.getSellerAnalytics(sellerId);
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/banners/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const banner = await bannerService.getBannerById(String(req.params.id));

    if (banner.campaign.ownerType !== 'SELLER' || banner.campaign.ownerId !== sellerId) {
      throw new AppError('Unauthorized: cannot view another seller banner', 403);
    }

    ResponseUtil.success(res, banner);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/seller/banners/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const updated = await bannerService.updateBanner(String(req.params.id), req.body, { sellerId });
    ResponseUtil.success(res, updated, 'تم تعديل البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/seller/banners/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    await bannerService.deleteBanner(String(req.params.id), { sellerId });
    ResponseUtil.success(res, null, 'تم حذف البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/banners/:id/submit
router.post('/:id/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const submitted = await bannerService.submitBannerForApproval(String(req.params.id), sellerId);
    ResponseUtil.success(res, submitted, 'تم إرسال البانر للمراجعة والاعتماد');
  } catch (error) {
    next(error);
  }
});

export const sellerBannerRoutes = router;
