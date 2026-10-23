import { Router, Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../../../utils/response.util';
import { optionalAuth } from '../../../middleware/auth.middleware';
import { bannerRecommendationService } from '../services/banner-recommendation.service';
import { bannerAnalyticsService } from '../services/banner-analytics.service';
import { deepLinkService } from '../services/deep-link.service';
import { campaignService } from '../services/campaign.service';
import { CustomerEvaluationContext } from '../services/targeting.service';
import { placementService } from '../services/placement.service';

const router = Router();
router.use(optionalAuth);

function extractClientContext(req: Request): CustomerEvaluationContext {
  const user = (req as any).user;
  const platformHeader = (req.headers['x-platform'] as string) || (req.query.platform as string) || 'MOBILE';
  const localeHeader = (req.headers['x-locale'] as string) || (req.query.locale as string) || 'ar';
  const cityHeader = (req.headers['x-city'] as string) || (req.query.city as string);
  const countryHeader = (req.headers['x-country'] as string) || (req.query.country as string) || 'YE';

  return {
    userId: user?.userId || null,
    isGuest: !user || !user.userId,
    language: localeHeader,
    platform: platformHeader,
    city: cityHeader,
    country: countryHeader,
    orderCount: user?.orderCount,
    cartValue: user?.cartValue,
  };
}

// GET /api/v1/banners (general banner endpoint, supports ?placement=HOME_HERO)
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const placementKey = (req.query.placement as string) || 'HOME_HERO';
    const context = extractClientContext(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await bannerRecommendationService.getEligibleBannersForPlacement(
      placementKey,
      context,
      { limit }
    );

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/banners/placements/:placementKey
router.get('/placements/:placementKey', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const placementKey = String(req.params.placementKey).toUpperCase();
    const context = extractClientContext(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await bannerRecommendationService.getEligibleBannersForPlacement(
      placementKey,
      context,
      { limit }
    );

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/banners/home (aggregated home placements)
router.get('/home', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const context = extractClientContext(req);

    const [hero, secondary, voucherStrip, flashSale] = await Promise.all([
      bannerRecommendationService.getEligibleBannersForPlacement('HOME_HERO', context, { limit: 10 }),
      bannerRecommendationService.getEligibleBannersForPlacement('HOME_SECONDARY', context, { limit: 8 }),
      bannerRecommendationService.getEligibleBannersForPlacement('HOME_VOUCHER', context, { limit: 8 }),
      bannerRecommendationService.getEligibleBannersForPlacement('HOME_FLASH_SALE', context, { limit: 8 }),
    ]);

    ResponseUtil.success(res, {
      hero,
      secondary,
      voucherStrip,
      flashSale,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/campaigns/:id
router.get('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await campaignService.getCampaignLandingPage(String(req.params.id));
    ResponseUtil.success(res, campaign);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/banners/:id/impression
router.post('/:id/impression', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { sessionId, anonymousId, platform, deviceType, locale, metadata } = req.body;

    const recorded = await bannerAnalyticsService.trackEvent({
      bannerId: String(req.params.id),
      eventType: 'IMPRESSION',
      customerId: user?.userId,
      sessionId,
      anonymousId,
      platform: platform || (req.headers['x-platform'] as string) || 'MOBILE',
      deviceType,
      locale: locale || (req.headers['x-locale'] as string) || 'ar',
      ipAddress: req.ip,
      metadata,
    });

    ResponseUtil.success(res, { recorded });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/banners/:id/click
router.post('/:id/click', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { sessionId, anonymousId, platform, deviceType, locale, metadata } = req.body;

    await bannerAnalyticsService.trackEvent({
      bannerId: String(req.params.id),
      eventType: 'CLICK',
      customerId: user?.userId,
      sessionId,
      anonymousId,
      platform: platform || (req.headers['x-platform'] as string) || 'MOBILE',
      deviceType,
      locale: locale || (req.headers['x-locale'] as string) || 'ar',
      ipAddress: req.ip,
      metadata,
    });

    ResponseUtil.success(res, { recorded: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/banners/:id/conversion
router.post('/:id/conversion', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const { orderId, sessionId, revenue, currency, attributionWindowDays } = req.body;

    await bannerAnalyticsService.trackConversion({
      bannerId: String(req.params.id),
      orderId,
      customerId: user?.userId,
      sessionId,
      revenue: Number(revenue) || 0,
      currency: currency || 'YER',
      attributionWindowDays: attributionWindowDays ? parseInt(attributionWindowDays, 10) : 7,
    });

    ResponseUtil.success(res, { recorded: true });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/deep-links/:id
router.get('/deep-links/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await deepLinkService.resolveDeepLink(String(req.params.id));
    ResponseUtil.success(res, resolved);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/banners/sponsored-products
// Customer-facing sponsored product cards (served by seller promotion engine)
router.get('/sponsored-products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sellerPromotionService } = await import('../services/seller-promotion.service');
    const context = extractClientContext(req);
    const placementKey = (req.query.placement as string) || 'SPONSORED_PRODUCTS';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 8;

    const results = await sellerPromotionService.getActiveSponsoredProducts(placementKey, {
      customerId: context.userId || undefined,
      sessionId: req.query.sessionId as string | undefined,
      limit,
    });

    ResponseUtil.success(res, { items: results, total: results.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/banners/sponsored-products/:id/track
// Public customer tracking for seller sponsored products (impressions, clicks, conversions)
router.post('/sponsored-products/:id/track', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sellerPromotionService } = await import('../services/seller-promotion.service');
    const { eventType, sessionId, customerId, anonymousId, platform, productId, idempotencyKey, revenue } =
      req.body;

    if (!['IMPRESSION', 'CLICK', 'ADD_TO_CART', 'PURCHASE'].includes(eventType)) {
      return ResponseUtil.success(res, { tracked: false });
    }

    sellerPromotionService
      .trackEvent({
        promotionId: String(req.params.id),
        eventType,
        sessionId,
        customerId: (req as any).user?.userId || customerId,
        anonymousId,
        platform: platform || (req.headers['x-platform'] as string) || 'MOBILE',
        productId,
        idempotencyKey,
        revenue,
      })
      .catch((err) => {
        console.error('[TrackEvent Error]:', err);
      });

    ResponseUtil.success(res, { tracked: true });
  } catch (error) {
    next(error);
  }
});

export const customerBannerRoutes = router;
