import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ResponseUtil } from '../../../utils/response.util';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { campaignService } from '../services/campaign.service';
import { bannerService } from '../services/banner.service';
import { placementService } from '../services/placement.service';
import { deepLinkService } from '../services/deep-link.service';
import { bannerAnalyticsService } from '../services/banner-analytics.service';
import { campaignBadgeService } from '../services/campaign-badge.service';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';

const router = Router();
router.use(authenticate);
router.use(authorize('ADMIN'));

const badgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ── Campaigns ───────────────────────────────────────────────────────────────

// GET /api/v1/admin/campaigns
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, ownerType, ownerId, search } = req.query;
    const campaigns = await campaignService.getCampaigns({
      status: status as any,
      ownerType: ownerType as string,
      ownerId: ownerId as string,
      search: search as string,
    });
    ResponseUtil.success(res, campaigns);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/check-conflicts
router.post('/campaigns/check-conflicts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await campaignService.checkCampaignConflicts(req.body);
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns
router.post('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const campaign = await campaignService.createCampaign({
      ...req.body,
      ownerType: 'ADMIN',
      createdBy: user?.userId,
    });
    ResponseUtil.created(res, campaign, 'تم إنشاء الحملة التسويقية بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/campaigns/analytics
router.get('/campaigns/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = req.query.campaignId as string;
    const analytics = await bannerAnalyticsService.getAdminAnalytics(campaignId);
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/campaigns/:id
router.get('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await campaignService.getCampaignById(String(req.params.id));
    ResponseUtil.success(res, campaign);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/campaigns/:id  (also accept PUT for client compatibility)
router.patch('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await campaignService.updateCampaign(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});
router.put('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await campaignService.updateCampaign(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/publish
router.post('/campaigns/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const approved = await campaignService.approveCampaign(String(req.params.id), user?.userId || 'ADMIN');
    ResponseUtil.success(res, approved, 'تم اعتماد ونشر الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/pause
router.post('/campaigns/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paused = await campaignService.pauseCampaign(String(req.params.id));
    ResponseUtil.success(res, paused, 'تم إيقاف الحملة مؤقتاً');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/resume
router.post('/campaigns/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resumed = await campaignService.resumeCampaign(String(req.params.id));
    ResponseUtil.success(res, resumed, 'تم استئناف الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/archive
router.post('/campaigns/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const archived = await campaignService.archiveCampaign(String(req.params.id));
    ResponseUtil.success(res, archived, 'تم أرشفة الحملة');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/campaigns/:id
router.delete('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await campaignService.archiveCampaign(String(req.params.id));
    ResponseUtil.success(res, null, 'تم حذف الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/reject
router.post('/campaigns/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { reason } = req.body;
    const rejected = await campaignService.rejectCampaign(String(req.params.id), user?.userId || 'ADMIN', reason);
    ResponseUtil.success(res, rejected, 'تم رفض الحملة');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/campaigns/:id/products
router.get('/campaigns/:id/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, page, limit } = req.query;
    const result = await campaignService.getCampaignProductsForAdmin(String(req.params.id), {
      status: status as any,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 20,
    });
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/products/:productId/approve
router.post('/campaigns/:id/products/:productId/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { note } = req.body;
    const approved = await campaignService.approveCampaignProduct(
      String(req.params.productId),
      user?.userId || 'ADMIN',
      note
    );
    ResponseUtil.success(res, approved, 'تمت الموافقة على المنتج للمشاركة في الحملة');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/campaigns/:id/products/:productId/reject
router.post('/campaigns/:id/products/:productId/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { reason } = req.body;
    const rejected = await campaignService.rejectCampaignProduct(
      String(req.params.productId),
      user?.userId || 'ADMIN',
      reason
    );
    ResponseUtil.success(res, rejected, 'تم رفض مشاركة المنتج في الحملة');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/campaigns/:id/analytics
router.get('/campaigns/:id/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const analytics = await bannerAnalyticsService.getAdminAnalytics(String(req.params.id));
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// ── Campaign Badge Management ───────────────────────────────────────────────

// POST /api/v1/admin/campaigns/:id/badge
router.post('/campaigns/:id/badge', badgeUpload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError('ملف صورة الشارة مطلوب', 400);
    const user = (req as any).user;
    const { locale, altText, altTextAr, altTextEn, position, clickable, landingPageUri } = req.body;
    const asset = await campaignBadgeService.uploadBadgeAsset({
      campaignId: String(req.params.id),
      file: req.file,
      locale: locale || 'UNIVERSAL',
      altText,
      altTextAr,
      altTextEn,
      position,
      clickable: clickable !== undefined ? clickable === 'true' || clickable === true : undefined,
      landingPageUri,
      actorUserId: user?.userId,
    });
    ResponseUtil.created(res, asset, 'تم رفع وتحديث شارة الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/campaigns/:id/badge
router.delete('/campaigns/:id/badge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const assetId = req.query.assetId as string;
    await campaignBadgeService.removeBadgeAsset(String(req.params.id), assetId, user?.userId);
    ResponseUtil.success(res, null, 'تم إزالة شارة الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/campaigns/:id/badge/toggle
router.patch('/campaigns/:id/badge/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { enabled } = req.body;
    if (enabled === undefined) throw new AppError('حالة التفعيل مطلوبة', 400);
    const updated = await campaignBadgeService.toggleBadge(String(req.params.id), Boolean(enabled), user?.userId);
    ResponseUtil.success(res, updated, enabled ? 'تم تفعيل شارة الحملة' : 'تم تعطيل شارة الحملة');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/campaigns/:id/badge/config
router.patch('/campaigns/:id/badge/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const updated = await campaignBadgeService.updateBadgeConfig(String(req.params.id), req.body, user?.userId);
    ResponseUtil.success(res, updated, 'تم تعديل إعدادات عرض الشارة بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/campaigns/:id/preview
router.get('/campaigns/:id/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await campaignService.getCampaignById(String(req.params.id));
    const sampleProduct = await prisma.product.findFirst({
      where: { isActive: true },
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        price: true,
        images: { take: 1, select: { url: true } },
        store: { select: { id: true, name: true, sellerId: true } },
        categoryId: true,
        brandId: true,
      },
    });

    const activeList = await campaignBadgeService.getActiveCampaignsWithBadges();
    const thisCampaignActive = activeList.find((c) => c.id === campaign.id);

    let presentation: any = null;
    if (thisCampaignActive && sampleProduct) {
      presentation = campaignBadgeService.resolvePresentationForProduct(
        sampleProduct as any,
        [thisCampaignActive],
        'ar'
      );
    } else if (campaign.badgeAssets && campaign.badgeAssets.length > 0 && sampleProduct) {
      const asset = campaign.badgeAssets[0];
      presentation = {
        campaignId: campaign.id,
        campaignType: campaign.campaignType,
        campaignName: campaign.nameAr || campaign.name,
        campaignNameAr: campaign.nameAr || campaign.name,
        campaignNameEn: campaign.nameEn || campaign.name,
        priority: campaign.priority,
        badge: {
          visible: true,
          imageUrl: asset.mobileUrl || asset.assetUrl,
          thumbnailUrl: asset.thumbnailUrl || asset.assetUrl,
          position: campaign.badgePosition || 'BOTTOM_LEFT',
          assetVersion: asset.assetVersion || 'v1',
          altText: asset.altTextAr || asset.altText || campaign.name,
          clickable: campaign.badgeClickable !== false,
          landingPageUri: campaign.landingPageUri || `/campaigns/${campaign.slug}`,
        },
      };
    }

    ResponseUtil.success(res, {
      campaign,
      previewPresentation: presentation,
      sampleProduct,
    });
  } catch (error) {
    next(error);
  }
});

// ── Banners ─────────────────────────────────────────────────────────────────

// GET /api/v1/admin/banners
router.get('/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campaignId, placementKey, status, sellerId, search } = req.query;
    const banners = await bannerService.getBanners({
      campaignId: campaignId as string,
      placementKey: placementKey as string,
      status: status as any,
      sellerId: sellerId as string,
      search: search as string,
    });
    ResponseUtil.success(res, { banners, items: banners, total: banners.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners
router.post('/banners', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const banner = await bannerService.createBanner({
      ...req.body,
      createdBy: user?.userId,
    });
    ResponseUtil.created(res, banner, 'تم إنشاء البانر الإعلاني بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/banners/:id
router.get('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banner = await bannerService.getBannerById(String(req.params.id));
    ResponseUtil.success(res, banner);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/banners/:id
router.patch('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await bannerService.updateBanner(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/admin/banners/:id
router.put('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await bannerService.updateBanner(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/banners/:id
router.delete('/banners/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await bannerService.deleteBanner(String(req.params.id));
    ResponseUtil.success(res, null, 'تم حذف البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/publish
router.post('/banners/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approved = await bannerService.approveBanner(String(req.params.id));
    ResponseUtil.success(res, approved, 'تم نشر البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/pause
router.post('/banners/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paused = await bannerService.pauseBanner(String(req.params.id));
    ResponseUtil.success(res, paused, 'تم إيقاف البانر مؤقتاً');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/approve
router.post('/banners/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approved = await bannerService.approveBanner(String(req.params.id));
    ResponseUtil.success(res, approved, 'تمت الموافقة على البانر');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/resume
router.post('/banners/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approved = await bannerService.approveBanner(String(req.params.id));
    ResponseUtil.success(res, approved, 'تمت إعادة تفعيل البانر');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/reactivate
router.post('/banners/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approved = await bannerService.approveBanner(String(req.params.id));
    ResponseUtil.success(res, approved, 'تمت إعادة تفعيل البانر');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/reject
router.post('/banners/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;
    const rejected = await bannerService.rejectBanner(String(req.params.id), reason);
    ResponseUtil.success(res, rejected, 'تم رفض البانر');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/banners/:id/archive
router.post('/banners/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await prisma.promotionalBanner.update({
      where: { id: String(req.params.id) },
      data: { status: 'ARCHIVED', isActive: false },
    });
    ResponseUtil.success(res, updated, 'تم أرشفة البانر');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/banners/:id/analytics
router.get('/banners/:id/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id: String(req.params.id) },
      include: {
        analyticsEvents: { take: 100, orderBy: { createdAt: 'desc' } },
        attributions: { take: 50, orderBy: { convertedAt: 'desc' } },
      },
    });
    ResponseUtil.success(res, banner);
  } catch (error) {
    next(error);
  }
});

// ── Placements ──────────────────────────────────────────────────────────────

// GET /api/v1/admin/placements
router.get('/placements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const placements = await placementService.getAllPlacements();
    ResponseUtil.success(res, placements);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/placements
router.post('/placements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const created = await placementService.createPlacement(req.body);
    ResponseUtil.created(res, created, 'تم إنشاء موضع البانرات بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/placements/seed
router.post('/placements/seed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await placementService.seedDefaultPlacements();
    const placements = await placementService.getAllPlacements();
    ResponseUtil.success(res, placements, 'تم تهيئة المواضع الافتراضية بنجاح');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/admin/placements/:id
router.patch('/placements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await placementService.updatePlacement(String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تحديث الموضع بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/placements/:id
router.delete('/placements/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await placementService.deletePlacement(String(req.params.id));
    ResponseUtil.success(res, null, 'تم حذف موضع البانر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── Deep Links ──────────────────────────────────────────────────────────────

// GET /api/v1/admin/deep-links
router.get('/deep-links', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deepLinks = await prisma.deepLink.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    ResponseUtil.success(res, deepLinks);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/deep-links
router.post('/deep-links', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const created = await deepLinkService.createDeepLink(req.body);
    ResponseUtil.created(res, created, 'تم إنشاء الرابط المباشر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const adminCampaignBannerRoutes = router;
