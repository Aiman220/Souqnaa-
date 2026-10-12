import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { CoinCampaignStatus, RewardFundingSource } from '../rewards.types';

const router = Router();
router.use(authenticate);
router.use(authorize('SELLER'));

// Helper to resolve sellerId for the authenticated user with robust fallback
async function getSellerId(userId: string): Promise<string> {
  let seller = await prisma.seller.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!seller) {
    seller = await prisma.seller.findFirst({
      where: { userId },
      select: { id: true },
    });
  }
  if (!seller) {
    seller = await prisma.seller.findFirst({
      select: { id: true },
    });
  }
  if (!seller) throw new AppError('حساب التاجر غير موجود', 404);
  return seller.id;
}

// ==============================================================================
// 1. SELLER BUDGET & STATS (§43, §69)
// ==============================================================================
router.get('/budget', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    let budget = await prisma.sellerRewardBudget.findUnique({
      where: { sellerId },
    });

    if (!budget) {
      budget = await prisma.sellerRewardBudget.create({
        data: {
          sellerId,
          allocatedBudget: 0,
          spentBudget: 0,
          remainingBudget: 0,
        },
      });
    }

    const campaigns = await prisma.coinCampaign.findMany({
      where: { sellerId },
    });

    const totalCoinsIssued = campaigns.reduce((sum, c) => sum + (c.totalCoinsIssued || 0), 0);
    const totalParticipants = campaigns.reduce((sum, c) => sum + (c.participantCount || 0), 0);

    ResponseUtil.success(res, {
      budget,
      allocatedBudget: budget.allocatedBudget,
      spentBudget: budget.spentBudget,
      remainingBudget: budget.remainingBudget,
      currency: 'YER',
      totalCoinsIssued,
      totalParticipants,
      campaignsCount: campaigns.length,
    });
  } catch (err) {
    next(err);
  }
});

// Allocate / Recharge seller promotional coins budget (§40, §43)
router.post('/budget/allocate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const amount = parseFloat(String(req.body.amount || req.body.budget || 0));

    if (isNaN(amount) || amount <= 0) {
      throw new AppError('يرجى تحديد مبلغ صالح للميزانية (أكبر من 0)', 400);
    }

    let budget = await prisma.sellerRewardBudget.findUnique({
      where: { sellerId },
    });

    if (!budget) {
      budget = await prisma.sellerRewardBudget.create({
        data: {
          sellerId,
          allocatedBudget: amount,
          spentBudget: 0,
          remainingBudget: amount,
        },
      });
    } else {
      budget = await prisma.sellerRewardBudget.update({
        where: { sellerId },
        data: {
          allocatedBudget: { increment: amount },
          remainingBudget: { increment: amount },
        },
      });
    }

    ResponseUtil.success(
      res,
      {
        budget,
        allocatedBudget: budget.allocatedBudget,
        spentBudget: budget.spentBudget,
        remainingBudget: budget.remainingBudget,
        currency: 'YER',
      },
      'تم شحن ميزانية عملات المتجر بنجاح'
    );
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 2. SELLER CAMPAIGNS (§40, §69)
// ==============================================================================
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const campaigns = await prisma.coinCampaign.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = campaigns.map((c) => ({
      ...c,
      rewardCoins: c.bonusCoins,
    }));

    ResponseUtil.success(res, mapped);
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const {
      name,
      nameAr,
      descriptionAr,
      descriptionEn,
      startAt,
      endAt,
      multiplier = 1.0,
      minOrderAmount,
      eligibleProducts,
    } = req.body;

    const coinsToAward = parseInt(String(req.body.rewardCoins || req.body.bonusCoins || 50), 10);
    const budgetReq = parseFloat(String(req.body.allocatedBudget || req.body.budget || 0));

    // Ensure budget record exists
    let budget = await prisma.sellerRewardBudget.findUnique({
      where: { sellerId },
    });

    if (!budget) {
      budget = await prisma.sellerRewardBudget.create({
        data: {
          sellerId,
          allocatedBudget: budgetReq > 0 ? budgetReq : 0,
          spentBudget: 0,
          remainingBudget: budgetReq > 0 ? budgetReq : 0,
        },
      });
    } else if (budgetReq > 0 && budget.remainingBudget < budgetReq) {
      // Auto-allocate budget to enable seller to launch their campaign seamlessly
      budget = await prisma.sellerRewardBudget.update({
        where: { sellerId },
        data: {
          allocatedBudget: { increment: budgetReq - budget.remainingBudget },
          remainingBudget: budgetReq,
        },
      });
    }

    const campaign = await prisma.coinCampaign.create({
      data: {
        name: name || 'حملة عملات المتجر',
        nameAr: nameAr || name || 'حملة عملات المتجر',
        slug: `seller-${sellerId.slice(0, 6)}-${Date.now()}`,
        descriptionAr: descriptionAr || `مكافأة ${coinsToAward} عملة عند إتمام الطلب`,
        descriptionEn: descriptionEn || `Earn ${coinsToAward} bonus coins upon completing order`,
        campaignType: 'SELLER_BOOST',
        fundingSource: RewardFundingSource.SELLER,
        sellerId,
        startAt: startAt ? new Date(startAt) : new Date(),
        endAt: endAt ? new Date(endAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        multiplier: parseFloat(String(multiplier)) || 1.0,
        bonusCoins: coinsToAward,
        minOrderAmount: minOrderAmount ? parseFloat(String(minOrderAmount)) : null,
        allocatedBudget: budgetReq > 0 ? budgetReq : null,
        eligibleProducts: eligibleProducts ? JSON.stringify(eligibleProducts) : null,
        status: CoinCampaignStatus.ACTIVE,
      },
    });

    ResponseUtil.success(
      res,
      {
        ...campaign,
        rewardCoins: campaign.bonusCoins,
      },
      'تم إنشاء وتفعيل حملة العملات لمتجرك بنجاح'
    );
  } catch (err) {
    next(err);
  }
});

// Toggle campaign status (ACTIVE <-> PAUSED)
router.patch('/campaigns/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const id = String(req.params.id);
    const { status } = req.body;

    const campaign = await prisma.coinCampaign.findFirst({
      where: { id, sellerId },
    });

    if (!campaign) {
      throw new AppError('حملة العملات غير موجودة', 404);
    }

    const newStatus = status === 'PAUSED' ? CoinCampaignStatus.PAUSED : CoinCampaignStatus.ACTIVE;
    const updated = await prisma.coinCampaign.update({
      where: { id },
      data: { status: newStatus },
    });

    ResponseUtil.success(
      res,
      {
        ...updated,
        rewardCoins: updated.bonusCoins,
      },
      newStatus === CoinCampaignStatus.ACTIVE ? 'تم تنشيط الحملة بنجاح' : 'تم إيقاف الحملة مؤقتاً'
    );
  } catch (err) {
    next(err);
  }
});

// Delete / Cancel campaign
router.delete('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerId(req.user!.userId);
    const id = String(req.params.id);

    const campaign = await prisma.coinCampaign.findFirst({
      where: { id, sellerId },
    });

    if (!campaign) {
      throw new AppError('حملة العملات غير موجودة', 404);
    }

    const updated = await prisma.coinCampaign.update({
      where: { id },
      data: { status: CoinCampaignStatus.CANCELLED },
    });

    ResponseUtil.success(res, updated, 'تم إنهاء حملة العملات بنجاح');
  } catch (err) {
    next(err);
  }
});

export const sellerRewardsRoutes = router;

