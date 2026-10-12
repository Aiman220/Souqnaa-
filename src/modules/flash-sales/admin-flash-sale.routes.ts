import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { flashSaleService } from './flash-sale.service';
import { FlashSaleStatus, FlashSaleDiscountType, FlashSaleItemStatus } from '@prisma/client';

const router = Router();
router.use(authenticate, requireAdmin);

// GET /api/v1/admin/flash-sales — List all campaigns with filters & metrics
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, search } = req.query;

    const where: any = {};
    if (status && typeof status === 'string') {
      where.status = status as FlashSaleStatus;
    }
    if (search && typeof search === 'string') {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const campaigns = await prisma.flashSaleCampaign.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        items: {
          include: {
            product: {
              select: { id: true, nameAr: true, nameEn: true, price: true },
            },
          },
        },
        submissions: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, price: true, sku: true } },
            seller: {
              select: {
                id: true,
                stores: { select: { name: true }, take: 1 },
                user: { select: { firstName: true, lastName: true, email: true } },
              },
            },
            variant: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: {
          select: {
            items: true,
            submissions: true,
            reservations: true,
          },
        },
      },
    });

    ResponseUtil.success(res, campaigns);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/flash-sales/submissions/pending — All pending submissions across campaigns
router.get('/submissions/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submissions = await prisma.flashSaleSellerSubmission.findMany({
      where: { status: 'PENDING_REVIEW' },
      include: {
        campaign: { select: { id: true, name: true, startAt: true, endAt: true, status: true } },
        product: { select: { id: true, nameAr: true, nameEn: true, price: true, sku: true } },
        seller: {
          select: {
            id: true,
            stores: { select: { name: true }, take: 1 },
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        variant: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, submissions);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales — Create campaign
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      title,
      titleAr,
      slug,
      description,
      bannerImage,
      mobileBanner,
      desktopBanner,
      campaignColor,
      campaignBadge,
      startAt,
      startsAt,
      endAt,
      endsAt,
      timezone,
      priority,
      displayOrder,
      maxProducts,
      isFeatured,
      customerEligibility,
      minimumAppVersion,
      termsAndConditions,
      couponPolicy,
      minimumOrderAmount,
      maximumOrders,
    } = req.body;

    const campaignName = name || titleAr || title;
    const campaignStart = startAt || startsAt;
    const campaignEnd = endAt || endsAt;

    if (!campaignName || !campaignStart || !campaignEnd) {
      throw new AppError('Campaign name, startAt, and endAt are required', 400);
    }

    const campaign = await flashSaleService.createCampaign({
      name: String(campaignName),
      slug: slug ? String(slug) : undefined,
      description: description ? String(description) : undefined,
      bannerImage: bannerImage ? String(bannerImage) : undefined,
      mobileBanner: mobileBanner ? String(mobileBanner) : undefined,
      desktopBanner: desktopBanner ? String(desktopBanner) : undefined,
      campaignColor: campaignColor ? String(campaignColor) : undefined,
      campaignBadge: campaignBadge ? String(campaignBadge) : undefined,
      startAt: new Date(campaignStart),
      endAt: new Date(campaignEnd),
      timezone: timezone ? String(timezone) : 'UTC',
      priority: priority !== undefined ? parseInt(String(priority), 10) : 0,
      displayOrder: displayOrder !== undefined ? parseInt(String(displayOrder), 10) : 0,
      maxProducts: maxProducts !== undefined ? parseInt(String(maxProducts), 10) : undefined,
      isFeatured: Boolean(isFeatured),
      customerEligibility: customerEligibility ? String(customerEligibility) : 'ALL',
      minimumAppVersion: minimumAppVersion ? String(minimumAppVersion) : undefined,
      termsAndConditions: termsAndConditions ? String(termsAndConditions) : undefined,
      couponPolicy: couponPolicy || undefined,
      minimumOrderAmount: minimumOrderAmount ? parseFloat(String(minimumOrderAmount)) : undefined,
      maximumOrders: maximumOrders ? parseInt(String(maximumOrders), 10) : undefined,
      createdBy: req.user!.userId,
    });

    ResponseUtil.success(res, campaign, 'Flash Sale campaign created successfully', 201);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/flash-sales/:id — Single campaign with items and submissions
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const campaign = await prisma.flashSaleCampaign.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, price: true, sku: true } },
            seller: { select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } } },
            variant: true,
          },
        },
        submissions: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, price: true } },
            seller: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    if (!campaign) throw new AppError('Campaign not found', 404);
    ResponseUtil.success(res, campaign);
  } catch (error) {
    next(error);
  }
});

// PUT & PATCH /api/v1/admin/flash-sales/:id — Edit campaign
const handleUpdateCampaign = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.updateCampaign(id, req.body, req.user!.userId);
    ResponseUtil.success(res, updated, 'Campaign updated successfully');
  } catch (error) {
    next(error);
  }
};
router.put('/:id', handleUpdateCampaign);
router.patch('/:id', handleUpdateCampaign);

// DELETE /api/v1/admin/flash-sales/:id — Delete campaign and cascade children
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.$transaction(async (tx) => {
      await tx.flashSaleReservation.deleteMany({ where: { campaignId: id } });
      await tx.flashSaleItem.deleteMany({ where: { campaignId: id } });
      await tx.flashSaleSellerSubmission.deleteMany({ where: { campaignId: id } });
      await tx.flashSaleCampaign.delete({ where: { id } });
    });
    ResponseUtil.success(res, null, 'Campaign deleted successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/items — Add product directly to campaign
router.post('/:id/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = String(req.params.id);
    const {
      productId,
      variantId,
      flashPrice,
      discountPrice,
      discountType,
      discountValue,
      allocatedStock,
      perCustomerLimit,
      minimumPurchaseQuantity,
      maximumPurchaseQuantity,
    } = req.body;

    if (!productId) throw new AppError('productId is required', 400);

    const campaign = await prisma.flashSaleCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const product = await prisma.product.findUnique({
      where: { id: String(productId).trim() },
      include: { store: true },
    });
    if (!product) throw new AppError('Product not found with id: ' + productId, 404);

    let seller = await prisma.seller.findFirst({
      where: { stores: { some: { id: product.storeId } } },
    });
    if (!seller) {
      seller = await prisma.seller.findFirst();
    }
    if (!seller) throw new AppError('Seller not found', 404);

    const price = flashPrice !== undefined
      ? parseFloat(String(flashPrice))
      : (discountPrice !== undefined ? parseFloat(String(discountPrice)) : product.price * 0.8);
    const stock = allocatedStock !== undefined ? parseInt(String(allocatedStock), 10) : 10;
    const limit = perCustomerLimit !== undefined ? parseInt(String(perCustomerLimit), 10) : 2;

    const item = await prisma.flashSaleItem.create({
      data: {
        campaignId,
        sellerId: seller.id,
        productId: product.id,
        variantId: variantId || null,
        originalPrice: product.price,
        flashSalePrice: price,
        discountType: discountType === 'PERCENTAGE'
          ? FlashSaleDiscountType.PERCENTAGE
          : (discountType === 'SPECIAL_PRICE' ? FlashSaleDiscountType.SPECIAL_PRICE : FlashSaleDiscountType.FIXED),
        discountValue: discountValue !== undefined ? parseFloat(String(discountValue)) : price,
        allocatedStock: stock,
        reservedStock: 0,
        soldStock: 0,
        remainingStock: stock,
        perCustomerLimit: limit,
        minimumPurchaseQuantity: minimumPurchaseQuantity ? parseInt(String(minimumPurchaseQuantity), 10) : 1,
        maximumPurchaseQuantity: maximumPurchaseQuantity ? parseInt(String(maximumPurchaseQuantity), 10) : limit,
        status: FlashSaleItemStatus.ACTIVE,
        approvedAt: new Date(),
      },
      include: {
        product: { select: { id: true, nameAr: true, nameEn: true, price: true } },
      },
    });

    ResponseUtil.created(res, item, 'Product added to Flash Sale campaign successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/schedule — Schedule campaign
router.post('/:id/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.SCHEDULED,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign scheduled successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/publish — Publish & activate campaign
router.post('/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.ACTIVE,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign published and live');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/pause — Pause campaign
router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.PAUSED,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign paused');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/resume — Resume campaign
router.post('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.ACTIVE,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign resumed');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/cancel — Cancel campaign
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.CANCELLED,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign cancelled');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/:id/end — End campaign
router.post('/:id/end', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await flashSaleService.setCampaignStatus(
      id,
      FlashSaleStatus.ENDED,
      req.user!.userId
    );
    ResponseUtil.success(res, updated, 'Campaign ended');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/flash-sales/:id/submissions — View submissions queue
router.get('/:id/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = String(req.params.id);
    const submissions = await prisma.flashSaleSellerSubmission.findMany({
      where: { campaignId },
      include: {
        product: { select: { id: true, nameAr: true, nameEn: true, price: true, sku: true } },
        variant: true,
        seller: { select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, submissions);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/submissions/:id/approve — Approve submission
router.post('/submissions/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submissionId = String(req.params.id);
    const rawPrice = req.body.overridePrice ?? req.body.approvedPrice;
    const rawStock = req.body.overrideStock ?? req.body.approvedStock;
    const rawLimit = req.body.overrideLimit ?? req.body.approvedLimit;
    const { discountType } = req.body;

    const result = await flashSaleService.reviewSubmission(
      submissionId,
      'APPROVE',
      {
        overridePrice: rawPrice !== undefined ? parseFloat(String(rawPrice)) : undefined,
        overrideStock: rawStock !== undefined ? parseInt(String(rawStock), 10) : undefined,
        overrideLimit: rawLimit !== undefined ? parseInt(String(rawLimit), 10) : undefined,
        discountType: discountType as FlashSaleDiscountType | undefined,
      },
      req.user!.userId
    );

    ResponseUtil.success(res, result, 'Submission approved and product added to campaign');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/flash-sales/submissions/:id/reject — Reject submission
router.post('/submissions/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submissionId = String(req.params.id);
    const rejectionReason = req.body.rejectionReason ?? req.body.reason;

    const result = await flashSaleService.reviewSubmission(
      submissionId,
      'REJECT',
      { rejectionReason: rejectionReason ? String(rejectionReason) : undefined },
      req.user!.userId
    );

    ResponseUtil.success(res, result, 'Submission rejected');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/flash-sales/:id/items/:itemId and /items/:itemId — Remove product from campaign
const handleDeleteItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const itemId = String(req.params.itemId);
    await prisma.flashSaleItem.delete({
      where: { id: itemId },
    });
    ResponseUtil.success(res, null, 'Product removed from campaign');
  } catch (error) {
    next(error);
  }
};
router.delete('/:id/items/:itemId', handleDeleteItem);
router.delete('/items/:itemId', handleDeleteItem);

// GET /api/v1/admin/flash-sales/:id/analytics — Campaign analytics
router.get('/:id/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = String(req.params.id);
    const analytics = await flashSaleService.getAdminCampaignAnalytics(campaignId);
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/flash-sales/:id/stock — Live stock monitor
router.get('/:id/stock', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = String(req.params.id);
    const items = await prisma.flashSaleItem.findMany({
      where: { campaignId },
      include: {
        product: { select: { id: true, nameAr: true, nameEn: true, price: true } },
        seller: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
      },
    });

    const stockMonitor = items.map((i) => {
      const remaining = i.allocatedStock - i.reservedStock - i.soldStock;
      const sellThrough = i.allocatedStock > 0 ? Math.round((i.soldStock / i.allocatedStock) * 100) : 0;
      return {
        id: i.id,
        productId: i.productId,
        productName: i.product.nameAr,
        sellerName: `${i.seller.user.firstName} ${i.seller.user.lastName}`,
        originalPrice: i.originalPrice,
        flashSalePrice: i.flashSalePrice,
        allocatedStock: i.allocatedStock,
        reservedStock: i.reservedStock,
        soldStock: i.soldStock,
        remainingStock: Math.max(0, remaining),
        sellThroughRate: sellThrough,
        status: i.status,
        isSoldOut: remaining <= 0 || i.status === FlashSaleItemStatus.SOLD_OUT,
      };
    });

    ResponseUtil.success(res, {
      campaignId,
      serverTime: new Date().toISOString(),
      items: stockMonitor,
    });
  } catch (error) {
    next(error);
  }
});

export const adminFlashSaleRoutes = router;
