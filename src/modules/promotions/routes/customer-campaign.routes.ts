import { Router, Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../../../utils/response.util';
import { optionalAuth, authenticate } from '../../../middleware/auth.middleware';
import { campaignService } from '../services/campaign.service';
import { prisma } from '../../../database/prisma';

const router = Router();
router.use(optionalAuth);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/campaigns
// Active and upcoming platform & mega campaigns for customer discovery
// ────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, limit } = req.query;
    const now = new Date();

    const where: any = {
      status: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gt: now },
    };

    if (type) {
      where.campaignType = String(type).toUpperCase();
    }

    const campaigns = await prisma.campaign.findMany({
      where,
      take: limit ? Math.min(Number(limit), 20) : 10,
      orderBy: [{ priority: 'desc' }, { startAt: 'asc' }],
      include: {
        badgeAssets: true,
        promotionalBanners: {
          where: { status: { in: ['APPROVED', 'ACTIVE'] }, isActive: true },
          include: { placement: true },
          take: 10,
        },
      },
    });

    ResponseUtil.success(res, {
      items: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        nameAr: c.nameAr || c.name,
        nameEn: c.nameEn || c.name,
        slug: c.slug,
        description: c.description,
        campaignType: c.campaignType,
        status: c.status,
        isLive: c.status === 'ACTIVE' && now >= c.startAt && now <= c.endAt,
        startAt: c.startAt,
        endAt: c.endAt,
        priority: c.priority,
        badgeEnabled: c.badgeEnabled,
        badge: c.badgeEnabled && c.badgeAssets.length > 0 ? {
          visible: true,
          imageUrl: c.badgeAssets[0].mobileUrl || c.badgeAssets[0].assetUrl,
          position: c.badgePosition,
          assetVersion: c.badgeAssets[0].assetVersion,
          altText: c.badgeAssets[0].altTextAr || c.badgeAssets[0].altText || c.name,
        } : null,
        heroAsset: c.heroAsset,
        mobileAsset: c.mobileAsset,
        tabletAsset: c.tabletAsset,
        desktopAsset: c.desktopAsset,
        banners: c.promotionalBanners,
      })),
      total: campaigns.length,
    });
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/campaigns/:slug
// Full Mega Campaign Landing Page payload (hero, countdown, vouchers, flash sales, mega deals, categories, stores)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const landingPageData = await campaignService.getCampaignLandingPage(String(req.params.slug));
    ResponseUtil.success(res, landingPageData);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/campaigns/:slug/sections
// Modular campaign section configurations
// ────────────────────────────────────────────────────────────────────────────
router.get('/:slug/sections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await campaignService.getCampaignBySlugOrId(String(req.params.slug));
    const config = (campaign.landingPageConfig as any) || {};

    ResponseUtil.success(res, {
      campaignId: campaign.id,
      slug: campaign.slug,
      sections: config.sections || [
        { type: 'HERO', enabled: true, priority: 1 },
        { type: 'COUNTDOWN', enabled: true, priority: 2 },
        { type: 'VOUCHERS', enabled: true, priority: 3 },
        { type: 'FLASH_SALE', enabled: true, priority: 4 },
        { type: 'MEGA_DEALS', enabled: true, priority: 5 },
        { type: 'FEATURED_STORES', enabled: true, priority: 6 },
        { type: 'CATEGORIES', enabled: true, priority: 7 },
        { type: 'PRODUCT_GRID', enabled: true, priority: 8 },
      ],
      theme: config.theme || {
        primaryColor: '#D97706',
        secondaryColor: '#B45309',
        badgeText: campaign.nameAr || campaign.name || '🌟 MEGA CAMPAIGN',
      },
    });
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/campaigns/:slug/products
// Cursor-paginated campaign products with category tabs, search & sorting (Clause 6, 51)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:slug/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { categoryId, brandId, search, sortBy, cursor, limit } = req.query;

    const result = await campaignService.getCampaignProducts(String(req.params.slug), {
      categoryId: categoryId as string,
      brandId: brandId as string,
      search: search as string,
      sortBy: sortBy as any,
      cursor: cursor as string,
      limit: limit ? Number(limit) : 20,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/campaigns/products/:id/reserve
// Concurrency-safe atomic stock reservation for checkout
// ────────────────────────────────────────────────────────────────────────────
router.post('/products/:id/reserve', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quantity = Number(req.body.quantity) || 1;
    const reserved = await campaignService.reserveCampaignStock(String(req.params.id), quantity);
    ResponseUtil.success(res, reserved, 'تم حجز كمية المنتج ضمن الحملة');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/campaigns/products/:id/release
// Release reserved campaign stock on cart abandon / order cancel
// ────────────────────────────────────────────────────────────────────
router.post('/products/:id/release', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quantity = Number(req.body.quantity) || 1;
    await campaignService.releaseCampaignStock(String(req.params.id), quantity);
    ResponseUtil.success(res, null, 'تم تحرير كمية المنتج المحجوزة');
  } catch (error) {
    next(error);
  }
});

export const customerCampaignRoutes = router;
