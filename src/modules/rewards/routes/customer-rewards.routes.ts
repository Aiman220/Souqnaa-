import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { RewardsLedgerService } from '../services/rewards-ledger.service';
import { RewardsQuoteService } from '../services/rewards-quote.service';
import { RewardsEarningService } from '../services/rewards-earning.service';
import { RewardsConfigService } from '../services/rewards-config.service';
import { CoinCampaignStatus, RewardTxType } from '../rewards.types';
import { requireFeature } from '../../remote-config/remote-config.middleware';

const router = Router();
router.use(
  authenticate,
  requireFeature('coins_rewards', 'برنامج مكافآت وعملات سوقناا معطل حالياً لأعمال الصيانة الدورية.')
);

// ==============================================================================
// 1. CUSTOMER BALANCE & REWARDS SUMMARY (GET /api/v1/rewards/balance)
// ==============================================================================
router.get('/balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await RewardsLedgerService.getBalanceSummary(req.user!.userId);
    ResponseUtil.success(res, summary);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 2. TRANSACTION HISTORY (GET /api/v1/rewards/history)
// ==============================================================================
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const skip = req.query.offset !== undefined
      ? Math.max(0, parseInt(req.query.offset as string, 10) || 0)
      : (page - 1) * limit;
    const type = req.query.type as string | undefined;

    const where: any = { customerId: req.user!.userId };
    if (type && type !== 'ALL') {
      if (type === 'EARN') {
        where.coins = { gt: 0 };
      } else if (type === 'REDEEM') {
        where.OR = [
          { coins: { lt: 0 }, type: { not: 'EXPIRE' } },
          { type: 'REDEEM' },
        ];
      } else if (type === 'EXPIRE') {
        where.type = 'EXPIRE';
      } else {
        where.type = type;
      }
    }

    const [total, transactions] = await Promise.all([
      prisma.coinTransaction.count({ where }),
      prisma.coinTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    ResponseUtil.success(res, {
      transactions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 3. ACTIVE COIN LOTS (GET /api/v1/rewards/lots)
// ==============================================================================
router.get('/lots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lots = await prisma.coinLot.findMany({
      where: {
        customerId: req.user!.userId,
        status: 'ACTIVE',
        remainingCoins: { gt: 0 },
      },
      orderBy: { expiresAt: 'asc' },
    });
    ResponseUtil.success(res, lots);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 4. DAILY CHECK-IN STATUS (GET /api/v1/rewards/check-in)
// ==============================================================================
router.get('/check-in', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await RewardsEarningService.getDailyCheckinStatus(req.user!.userId);
    ResponseUtil.success(res, status);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 5. CLAIM DAILY CHECK-IN (POST /api/v1/rewards/check-in/claim)
// ==============================================================================
router.post('/check-in/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await RewardsEarningService.claimDailyCheckin(req.user!.userId);
    ResponseUtil.success(res, result, 'تم استلام مكافأة تسجيل الدخول اليومي بنجاح!');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 6. MISSIONS & TASKS (GET /api/v1/rewards/missions)
// ==============================================================================
router.get('/missions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const missions = await RewardsEarningService.getMissionsForCustomer(req.user!.userId);
    ResponseUtil.success(res, missions);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 7. CLAIM MISSION REWARD (POST /api/v1/rewards/missions/:id/claim)
// ==============================================================================
router.post('/missions/:id/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const missionId = String(req.params.id);
    const result = await RewardsEarningService.claimMissionReward(req.user!.userId, missionId);
    ResponseUtil.success(res, result, 'تم استلام مكافأة المهمة بنجاح!');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 8. REFERRAL SUMMARY (GET /api/v1/rewards/referrals)
// ==============================================================================
router.get('/referrals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await RewardsLedgerService.getOrCreateAccount(req.user!.userId);
    const rules = await RewardsConfigService.getRules();

    const records = await prisma.referralRecord.findMany({
      where: { referrerId: req.user!.userId },
      include: {
        referee: { select: { firstName: true, lastName: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalInvited = records.length;
    const completedRecords = records.filter((r) => r.status === 'COMPLETED');
    const totalCompleted = completedRecords.length;
    const totalCoinsEarned = completedRecords.reduce((sum, r) => sum + r.referrerRewardCoins, 0);

    const shareUrl = `https://souqnaa.app/ref/${account.referralCode}`;

    ResponseUtil.success(res, {
      referralCode: account.referralCode,
      shareUrl,
      referrerRewardCoins: rules.referralReferrerReward,
      refereeRewardCoins: rules.referralRefereeReward,
      minOrderAmount: rules.referralMinOrderAmount,
      totalInvited,
      totalCompleted,
      totalCoinsEarned,
      records: records.map((r) => ({
        id: r.id,
        refereeName: `${r.referee.firstName} ${r.referee.lastName.charAt(0)}.`,
        status: r.status,
        rewardEarned: r.status === 'COMPLETED' ? r.referrerRewardCoins : 0,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 9. APPLY REFERRAL CODE (POST /api/v1/rewards/referrals/apply)
// ==============================================================================
router.post('/referrals/apply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) {
      throw new AppError('يرجى إدخال كود الإحالة', 400);
    }
    const record = await RewardsEarningService.applyReferralCode(req.user!.userId, referralCode);
    ResponseUtil.success(res, record, 'تم ربط كود الإحالة بنجاح!');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 10. ACTIVE COIN CAMPAIGNS (GET /api/v1/rewards/campaigns)
// ==============================================================================
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const campaigns = await prisma.coinCampaign.findMany({
      where: {
        status: CoinCampaignStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gte: now },
      },
      orderBy: { multiplier: 'desc' },
    });
    ResponseUtil.success(res, campaigns);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 11. REWARDS TERMS & FAQ (GET /api/v1/rewards/terms)
// ==============================================================================
router.get('/terms', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await RewardsConfigService.getRules();
    ResponseUtil.success(res, {
      rules,
      termsAr: [
        'عملات سوقناا هي مكافأة ترويجية مخصصة للخصومات ولا تعتبر رصيداً نقدياً قابلاً للسحب.',
        `الحد الأقصى للخصم بالعملات هو ${Math.round(rules.maxOrderPercentage * 100)}% من قيمة سلة المشتريات.`,
        `كل ${rules.redemptionRatio} عملة تعادل 1 ريال يمني عند الدفع.`,
        `تنتهي صلاحية العملات بعد ${rules.defaultExpirationDays} يوماً من تاريخ اكتسابها إذا لم تُستخدم.`,
        'في حال إلغاء الطلب، يتم استرجاع العملات المستخدمة تلقائياً إلى حسابك.',
      ],
      termsEn: [
        'SOUQNAA Coins are promotional rewards usable for discounts and cannot be withdrawn as cash.',
        `Coins can cover up to ${Math.round(rules.maxOrderPercentage * 100)}% of your order subtotal.`,
        `Every ${rules.redemptionRatio} coins equals 1 YER discount at checkout.`,
        `Coins expire after ${rules.defaultExpirationDays} days if unused.`,
        'If an order is cancelled, any coins used are automatically refunded to your balance.',
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 12. CHECKOUT COINS QUOTE (POST /api/v1/rewards/checkout/quote)
// ==============================================================================
router.post('/checkout/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderSubtotal, coinsRequested = 0, currency = 'YER' } = req.body;
    if (typeof orderSubtotal !== 'number' || orderSubtotal < 0) {
      throw new AppError('قيمة الطلب غير صالحة', 400);
    }

    const quote = await RewardsQuoteService.calculateQuote({
      customerId: req.user!.userId,
      orderSubtotal,
      coinsRequested: parseInt(String(coinsRequested), 10) || 0,
      currency,
    });

    ResponseUtil.success(res, quote);
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 13. CHECKOUT COINS RESERVE (POST /api/v1/rewards/checkout/reserve)
// ==============================================================================
router.post('/checkout/reserve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quoteId, coins, discountAmount, quoteVersion, orderId } = req.body;
    const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;

    const reservation = await RewardsQuoteService.reserveCoins({
      customerId: req.user!.userId,
      coins: parseInt(String(coins), 10),
      discountAmount: parseFloat(String(discountAmount)),
      quoteVersion: String(quoteVersion || '1.0.0'),
      orderId,
      idempotencyKey,
    });

    ResponseUtil.success(res, reservation, 'تم حجز العملات لجلسة الدفع بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 14. CHECKOUT COINS RELEASE (POST /api/v1/rewards/checkout/release)
// ==============================================================================
router.post('/checkout/release', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reservationId } = req.body;
    if (!reservationId) {
      throw new AppError('معرف الحجز مطلوب', 400);
    }
    await RewardsQuoteService.releaseReservation(reservationId);
    ResponseUtil.success(res, null, 'تم تحرير حجز العملات بنجاح');
  } catch (err) {
    next(err);
  }
});

export const customerRewardsRoutes = router;
