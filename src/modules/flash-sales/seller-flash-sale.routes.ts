import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireSeller } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { flashSaleService } from './flash-sale.service';
import { SocketService } from '../../services/websocket/socket.service';
import { FlashSaleStatus, FlashSaleSubmissionStatus } from '@prisma/client';

const router = Router();
router.use(authenticate, requireSeller);

// Helper to resolve seller ID
async function getSellerId(userId: string): Promise<string> {
  const seller = await prisma.seller.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!seller) {
    throw new AppError('Seller profile not found', 403);
  }
  return seller.id;
}

// GET /api/v1/seller/flash-sales — Available campaigns open for seller submissions
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);

    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: { in: [FlashSaleStatus.DRAFT, FlashSaleStatus.SCHEDULED, FlashSaleStatus.ACTIVE] },
      },
      orderBy: [{ priority: 'desc' }, { startAt: 'asc' }],
      include: {
        submissions: {
          where: { sellerId },
          include: { product: { select: { id: true, nameAr: true, nameEn: true, price: true } } },
        },
        _count: { select: { items: true } },
      },
    });

    ResponseUtil.success(res, {
      serverTime: new Date().toISOString(),
      campaigns,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/flash-sales/analytics — Seller own Flash Sale analytics
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const analytics = await flashSaleService.getSellerAnalytics(sellerId);
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/flash-sales/submissions — Seller's own submissions across all campaigns
router.get('/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const { status } = req.query;

    const where: any = { sellerId };
    if (status && typeof status === 'string' && status !== 'ALL') {
      where.status = status;
    }

    const submissions = await prisma.flashSaleSellerSubmission.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            price: true,
            images: true,
            inventory: { select: { quantity: true, reserved: true } },
          },
        },
        variant: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, { submissions });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/flash-sales/:id — Single campaign for seller
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const campaignId = String(req.params.id);

    const campaign = await prisma.flashSaleCampaign.findUnique({
      where: { id: campaignId },
      include: {
        submissions: {
          where: { sellerId },
          include: { product: true, variant: true },
        },
      },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404, 'FLASH_SALE_NOT_FOUND');
    }

    ResponseUtil.success(res, campaign);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/seller/flash-sales/:id/submissions — Seller's submissions for a campaign
router.get('/:id/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const campaignId = String(req.params.id);

    const submissions = await prisma.flashSaleSellerSubmission.findMany({
      where: { campaignId, sellerId },
      include: {
        product: { select: { id: true, nameAr: true, nameEn: true, price: true, sku: true } },
        variant: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, submissions);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/flash-sales/:id/submissions — Submit product
router.post('/:id/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const campaignId = String(req.params.id);
    const {
      productId,
      variantId,
      proposedPrice,
      salePrice,
      proposedStock,
      allocatedStock,
      proposedPurchaseLimit,
      perCustomerLimit,
      notes,
      sellerNotes,
    } = req.body;

    const actualPrice = proposedPrice ?? salePrice;
    const actualStock = proposedStock ?? allocatedStock;
    const actualLimit = proposedPurchaseLimit ?? perCustomerLimit;
    const actualNotes = notes ?? sellerNotes;

    if (!productId || actualPrice === undefined || actualStock === undefined) {
      throw new AppError('Product ID, proposed price, and proposed stock are required', 400);
    }

    const submission = await flashSaleService.submitProduct(sellerId, {
      campaignId,
      productId: String(productId),
      variantId: variantId ? String(variantId) : undefined,
      proposedPrice: parseFloat(String(actualPrice)),
      proposedStock: parseInt(String(actualStock), 10),
      proposedPurchaseLimit: actualLimit ? parseInt(String(actualLimit), 10) : 1,
      notes: actualNotes ? String(actualNotes) : undefined,
    });

    ResponseUtil.success(res, { submission }, 'Product submitted for admin review successfully');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/seller/flash-sales/submissions/:id — Update pending submission
router.patch('/submissions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const submissionId = String(req.params.id);
    const { proposedPrice, proposedStock, proposedPurchaseLimit, notes } = req.body;

    const existing = await prisma.flashSaleSellerSubmission.findUnique({
      where: { id: submissionId },
    });

    if (!existing || existing.sellerId !== sellerId) {
      throw new AppError('Submission not found', 404);
    }

    if (existing.status !== FlashSaleSubmissionStatus.PENDING_REVIEW) {
      throw new AppError('Only pending submissions can be modified', 400);
    }

    const updated = await prisma.flashSaleSellerSubmission.update({
      where: { id: submissionId },
      data: {
        proposedPrice: proposedPrice !== undefined ? parseFloat(String(proposedPrice)) : undefined,
        proposedStock: proposedStock !== undefined ? parseInt(String(proposedStock), 10) : undefined,
        proposedPurchaseLimit: proposedPurchaseLimit !== undefined ? parseInt(String(proposedPurchaseLimit), 10) : undefined,
        notes: notes !== undefined ? String(notes) : undefined,
      },
    });

    ResponseUtil.success(res, updated, 'Submission updated successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/seller/flash-sales/submissions/:id/withdraw — Withdraw submission
router.post('/submissions/:id/withdraw', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const submissionId = String(req.params.id);

    const existing = await prisma.flashSaleSellerSubmission.findUnique({
      where: { id: submissionId },
    });

    if (!existing || existing.sellerId !== sellerId) {
      throw new AppError('Submission not found', 404);
    }

    if (existing.status !== FlashSaleSubmissionStatus.PENDING_REVIEW) {
      throw new AppError('Only pending submissions can be withdrawn', 400);
    }

    const withdrawn = await prisma.flashSaleSellerSubmission.update({
      where: { id: submissionId },
      data: { status: FlashSaleSubmissionStatus.WITHDRAWN },
    });

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal('flashsale:submission:withdrawn', {
          submissionId,
          campaignId: existing.campaignId,
          sellerId,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (_) {}

    ResponseUtil.success(res, withdrawn, 'Submission withdrawn');
  } catch (error) {
    next(error);
  }
});

export const sellerFlashSaleRoutes = router;
