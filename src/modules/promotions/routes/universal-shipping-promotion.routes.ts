/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * API Routes
 * Version: 2.0.0
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { UniversalShippingPromotionService } from '../services/universal-shipping-promotion.service';
import {
  CreateShippingPromotionDto,
  UpdateShippingPromotionDto,
  ShippingPromotionType,
  ShippingFundingType,
  ShippingPromotionStatus,
} from '../universal-shipping-promotion.types';

const router = Router();

/**
 * POST /api/v1/promotions/shipping/evaluate
 * Public/Customer endpoint to evaluate available shipping promotions for cart or checkout.
 */
router.post('/evaluate', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    const {
      subtotal,
      itemCount,
      sellerDeliveries,
      originalShippingAmount,
      deliveryMethod,
      deliveryZone,
      productIds,
      categoryIds,
    } = req.body;

    // Fetch authoritative customer info
    const [user, completedOrderCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phone: true,
          email: true,
          isVerified: true,
          isActive: true,
          createdAt: true,
        },
      }),
      prisma.order.count({
        where: {
          userId,
          status: { in: ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        },
      }),
    ]);

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const now = new Date();
    const accountAgeDays = Math.floor(
      (now.getTime() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    // Build seller contexts if multi-seller deliveries are present
    const rawSellers: Array<{ sellerId: string; deliveryFee: number }> = Array.isArray(sellerDeliveries)
      ? sellerDeliveries
      : [];

    const sellerIds = [...new Set(rawSellers.map((s) => s.sellerId))];
    const sellerPreviousCounts = await Promise.all(
      sellerIds.map(async (sId) => {
        const count = await prisma.sellerOrder.count({
          where: {
            sellerId: sId,
            order: { userId, status: { in: ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] } },
          },
        });
        return { sellerId: sId, count };
      })
    );

    const sellerCountMap = new Map(sellerPreviousCounts.map((s) => [s.sellerId, s.count]));

    const sellersContext = sellerIds.map((sId) => ({
      id: sId,
      previousOrderCountFromSeller: sellerCountMap.get(sId) ?? 0,
      isActive: true,
      isPromotionEnabled: true,
    }));

    const result = await UniversalShippingPromotionService.evaluateCheckout({
      context: {
        customer: {
          id: userId,
          completedOrderCount,
          accountAgeDays,
          isPhoneVerified: Boolean(user.phone && user.isVerified),
          isEmailVerified: Boolean(user.email && user.isVerified),
          isRestricted: !user.isActive,
          ipAddress: req.ip,
        },
        order: {
          subtotal: Number(subtotal) || 0,
          itemCount: Number(itemCount) || 1,
          sellerCount: sellerIds.length || 1,
          productIds: Array.isArray(productIds) ? productIds : [],
          categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
        },
        delivery: {
          deliveryMethod: deliveryMethod || 'standard',
          deliveryZone,
          originalShippingAmount: Number(originalShippingAmount) || 0,
          sellerDeliveries: rawSellers,
        },
        sellers: sellersContext,
        time: { now },
      },
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Evaluation error' });
  }
});

/**
 * GET /api/v1/promotions/shipping
 * List all universal shipping promotions.
 */
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const statusQuery = typeof req.query.status === 'string' ? (req.query.status as ShippingPromotionStatus) : undefined;
    const typeQuery = typeof req.query.type === 'string' ? (req.query.type as ShippingPromotionType) : undefined;
    const fundingTypeQuery = typeof req.query.fundingType === 'string' ? (req.query.fundingType as ShippingFundingType) : undefined;
    const campaignIdQuery = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;

    const where: any = {};
    if (statusQuery) where.status = statusQuery;
    if (typeQuery) where.type = typeQuery;
    if (fundingTypeQuery) where.fundingType = fundingTypeQuery;
    if (campaignIdQuery) where.campaignId = campaignIdQuery;

    const promotions = await prisma.shippingPromotion.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        campaign: { select: { id: true, name: true, slug: true } },
      },
    });

    res.status(200).json({
      success: true,
      data: promotions,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/promotions/shipping/:id
 * Retrieve a single shipping promotion.
 */
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const promo = await prisma.shippingPromotion.findUnique({
      where: { id },
      include: {
        campaign: true,
      },
    });

    if (!promo) {
      res.status(404).json({ success: false, error: 'Promotion not found' });
      return;
    }

    res.status(200).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/promotions/shipping/:id/analytics
 * Retrieve aggregated analytics for a promotion.
 */
router.get('/:id/analytics', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const analytics = await UniversalShippingPromotionService.getPromotionAnalytics(id);
    res.status(200).json({ success: true, data: analytics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/promotions/shipping
 * Admin create a new promotion.
 */
router.post('/', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const actorId = (req as any).user.userId || (req as any).user.id;
    const dto: CreateShippingPromotionDto = req.body;

    const promo = await UniversalShippingPromotionService.createPromotion(dto, actorId);
    res.status(201).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/v1/promotions/shipping/:id
 * Admin update a promotion.
 */
router.put('/:id', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const actorId = (req as any).user.userId || (req as any).user.id;
    const dto: UpdateShippingPromotionDto = req.body;

    const promo = await UniversalShippingPromotionService.updatePromotion(id, dto, actorId);
    res.status(200).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/promotions/shipping/:id/pause
 */
router.post('/:id/pause', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const actorId = (req as any).user.userId || (req as any).user.id;
    const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
    const promo = await UniversalShippingPromotionService.setStatus(id, 'PAUSED', actorId, reason);
    res.status(200).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/promotions/shipping/:id/resume
 */
router.post('/:id/resume', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const actorId = (req as any).user.userId || (req as any).user.id;
    const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
    const promo = await UniversalShippingPromotionService.setStatus(id, 'ACTIVE', actorId, reason);
    res.status(200).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/promotions/shipping/:id/cancel
 */
router.post('/:id/cancel', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const actorId = (req as any).user.userId || (req as any).user.id;
    const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
    const promo = await UniversalShippingPromotionService.setStatus(id, 'CANCELLED', actorId, reason);
    res.status(200).json({ success: true, data: promo });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

export default router;
