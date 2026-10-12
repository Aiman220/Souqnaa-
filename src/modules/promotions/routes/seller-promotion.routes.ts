import { Router, Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../../../utils/response.util';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { requireSeller } from '../../../middleware/rbac.middleware';
import { sellerPromotionService } from '../services/seller-promotion.service';
import { campaignService } from '../services/campaign.service';
import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { SellerPromotionType } from '@prisma/client';
import { SocketService } from '../../../services/websocket/socket.service';

const router = Router();
router.use(authenticate, requireSeller);

// Helper: resolve sellerId from authenticated user
async function getSellerId(req: Request): Promise<string> {
  const userId = (req as any).user?.userId;
  const seller = await prisma.seller.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (!seller) throw new AppError('ملف البائع غير موجود', 403);
  if (seller.status !== 'ACTIVE') throw new AppError('حساب البائع غير نشط', 403);
  return seller.id;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing
// Seller marketing dashboard overview
// ────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const dashboard = await sellerPromotionService.getSellerDashboard(sellerId);
    ResponseUtil.success(res, dashboard);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/packages
// Available advertising packages (seller read-only)
// ────────────────────────────────────────────────────────────────────────────
router.get('/packages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = req.query.type as any;
    const placementKey = req.query.placementKey as string | undefined;
    const packages = await sellerPromotionService.getActivePackages(type, placementKey);
    ResponseUtil.success(res, packages);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/campaigns
// Open campaigns available for seller participation
// ────────────────────────────────────────────────────────────────────────────
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const campaigns = await campaignService.getAvailableCampaignsForSeller(sellerId);
    ResponseUtil.success(res, campaigns);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/campaigns/:id/apply
// Register store for campaign participation
// ────────────────────────────────────────────────────────────────────────────
router.post('/campaigns/:id/apply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const { storeId } = req.body;
    let targetStoreId = storeId;
    if (!targetStoreId) {
      const store = await prisma.store.findFirst({ where: { sellerId } });
      if (!store) throw new AppError('لا يوجد متجر مرتبط بحسابك', 400);
      targetStoreId = store.id;
    }
    const result = await campaignService.applySellerToCampaign(String(req.params.id), sellerId, targetStoreId);
    ResponseUtil.success(res, result, 'تم الانضمام إلى الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/campaigns/:id/products
// Submit product for campaign participation
// ────────────────────────────────────────────────────────────────────────────
router.post('/campaigns/:id/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const { productId, variantId, storeId, campaignPrice, campaignStock, purchaseLimit } = req.body;

    if (!productId) throw new AppError('يرجى تحديد المنتج', 400);
    if (!campaignPrice || Number(campaignPrice) <= 0) throw new AppError('يرجى تحديد سعر العرض في الحملة', 400);
    if (!campaignStock || Number(campaignStock) <= 0) throw new AppError('يرجى تحديد الكمية المخصصة للحملة', 400);

    let targetStoreId = storeId;
    if (!targetStoreId) {
      const store = await prisma.store.findFirst({ where: { sellerId } });
      targetStoreId = store?.id || '';
    }

    const submission = await campaignService.submitCampaignProduct({
      campaignId: String(req.params.id),
      sellerId,
      storeId: targetStoreId,
      productId,
      variantId,
      campaignPrice: Number(campaignPrice),
      campaignStock: Number(campaignStock),
      purchaseLimit: purchaseLimit ? Number(purchaseLimit) : 1,
    });

    ResponseUtil.created(res, submission, 'تم تقديم المنتج للمشاركة في الحملة. بانتظار مراجعة الإدارة');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/campaigns/:id/products
// List seller's submitted products for a campaign
// ────────────────────────────────────────────────────────────────────────────
router.get('/campaigns/:id/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const products = await campaignService.getSellerCampaignProducts(String(req.params.id), sellerId);
    ResponseUtil.success(res, products);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/seller/marketing/campaigns/:id/products/:productId
// Withdraw product submission from campaign
// ────────────────────────────────────────────────────────────────────────────
router.delete('/campaigns/:id/products/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    await campaignService.withdrawCampaignProduct(String(req.params.productId), sellerId);
    ResponseUtil.success(res, null, 'تم سحب المنتج من الحملة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/my-products
// Seller's own products eligible for promotion
// ────────────────────────────────────────────────────────────────────────────
router.get('/my-products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const { search } = req.query;
    const products = await sellerPromotionService.getSellerProducts(sellerId, search as string);
    ResponseUtil.success(res, products);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/promotions
// List seller's promotions (with optional status filter)
// ────────────────────────────────────────────────────────────────────────────
router.get('/promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const { status, page, limit } = req.query;
    const result = await sellerPromotionService.getSellerPromotions(sellerId, {
      status: status as any,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 20,
    });
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/promotions
// Create a new promotion (DRAFT state — not yet paid)
// ────────────────────────────────────────────────────────────────────────────
router.post('/promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const {
      packageId,
      promotionType,
      items,
      mobileImageUrl,
      tabletImageUrl,
      desktopImageUrl,
      customCreativeEnabled,
      deepLinkType,
      deepLinkTargetId,
      deepLinkPath,
    } = req.body;

    if (!packageId) throw new AppError('يرجى اختيار باقة الترويج', 400);
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('يرجى اختيار منتج أو متجر للترويج', 400);
    }

    const validTypes: SellerPromotionType[] = ['PRODUCT', 'STORE', 'COLLECTION', 'CAMPAIGN'];
    const type: SellerPromotionType =
      validTypes.includes(promotionType) ? promotionType : 'PRODUCT';

    const promotion = await sellerPromotionService.createPromotion({
      sellerId,
      packageId,
      promotionType: type,
      items,
      mobileImageUrl,
      tabletImageUrl,
      desktopImageUrl,
      customCreativeEnabled,
      deepLinkType,
      deepLinkTargetId,
      deepLinkPath,
    });

    ResponseUtil.created(res, promotion, 'تم إنشاء الحملة الإعلانية. يرجى المتابعة للدفع');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/seller/marketing/promotions/:id
// Promotion detail with analytics
// ────────────────────────────────────────────────────────────────────────────
router.get('/promotions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const promotion = await sellerPromotionService.getPromotionDetail(String(req.params.id));
    if (promotion.sellerId !== sellerId) {
      throw new AppError('غير مسموح', 403);
    }
    ResponseUtil.success(res, promotion);
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/promotions/:id/pay
// Submit promotion for payment from SellerBalance and send to admin review
// ────────────────────────────────────────────────────────────────────────────
router.post('/promotions/:id/pay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const promotion = await sellerPromotionService.submitAndPay(
      String(req.params.id),
      sellerId,
    );
    SocketService.get()?.emitGlobal('admin:seller_promotion_created', promotion);
    SocketService.get()?.emitGlobal('seller:promotion_created', promotion);
    ResponseUtil.success(res, promotion, 'تم الدفع بنجاح. حملتك قيد المراجعة من قبل الإدارة');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/promotions/:id/cancel
// Cancel a promotion (with automatic refund for eligible statuses)
// ────────────────────────────────────────────────────────────────────────────
router.post('/promotions/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req);
    const result = await sellerPromotionService.cancelPromotion(
      String(req.params.id),
      sellerId,
    );
    ResponseUtil.success(res, result, 'تم إلغاء الحملة. سيتم استرداد المبلغ إلى محفظتك');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/seller/marketing/promotions/:id/track
// Track impression/click/add-to-cart events (fire-and-forget from client)
// ────────────────────────────────────────────────────────────────────────────
router.post('/promotions/:id/track', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventType, sessionId, customerId, anonymousId, platform, productId, idempotencyKey } =
      req.body;

    if (!['IMPRESSION', 'CLICK', 'ADD_TO_CART', 'PURCHASE'].includes(eventType)) {
      return ResponseUtil.success(res, null); // Silently ignore invalid events
    }

    // Fire and forget — don't await
    sellerPromotionService
      .trackEvent({
        promotionId: String(req.params.id),
        eventType,
        sessionId,
        customerId: (req as any).user?.userId || customerId,
        anonymousId,
        platform,
        productId,
        idempotencyKey,
      })
      .catch(() => {});

    ResponseUtil.success(res, null);
  } catch (error) {
    next(error);
  }
});

export const sellerMarketingRoutes = router;
