import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate, authorize } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { RewardsConfigService } from '../services/rewards-config.service';
import { RewardsLedgerService } from '../services/rewards-ledger.service';
import { RewardsExpirationService } from '../services/rewards-expiration.service';
import { RewardsNotificationService } from '../services/rewards-notification.service';
import { remoteConfigService } from '../../remote-config/remote-config.service';
import {
  RewardTxType,
  RewardTxSource,
  CoinCampaignStatus,
  MissionStatus,
  CoinLotStatus,
} from '../rewards.types';

const router = Router();
router.use(authenticate);
router.use(authorize('ADMIN'));

// ==============================================================================
// 1. OVERVIEW & ANALYTICS (§63, §86, §87)
// ==============================================================================
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalAccounts,
      flaggedAccounts,
      aggregates,
      todayCheckins,
      activeCampaignsCount,
      activeMissionsCount,
      reversedAggregates,
      rules,
    ] = await Promise.all([
      prisma.rewardAccount.count(),
      prisma.rewardAccount.count({ where: { riskFlag: true } }),
      prisma.rewardAccount.aggregate({
        _sum: {
          availableCoins: true,
          lifetimeEarned: true,
          lifetimeRedeemed: true,
          lifetimeExpired: true,
        },
      }),
      prisma.dailyCheckin.count({
        where: {
          checkinDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date()),
        },
      }),
      prisma.coinCampaign.count({ where: { status: CoinCampaignStatus.ACTIVE } }),
      prisma.rewardMission.count({ where: { status: MissionStatus.ACTIVE } }),
      prisma.coinTransaction.aggregate({
        where: { type: RewardTxType.REVERSE },
        _sum: { coins: true },
      }),
      RewardsConfigService.getRules(),
    ]);

    const totalIssued = aggregates._sum.lifetimeEarned || 0;
    const totalRedeemed = aggregates._sum.lifetimeRedeemed || 0;
    const totalExpired = aggregates._sum.lifetimeExpired || 0;
    const currentInCirculation = aggregates._sum.availableCoins || 0;
    const totalReversed = Math.abs(reversedAggregates._sum.coins || 0);
    const redemptionRate = totalIssued > 0 ? parseFloat(((totalRedeemed / totalIssued) * 100).toFixed(1)) : 0;
    const circulationValueInYER = parseFloat((currentInCirculation / (rules.redemptionRatio || 100)).toFixed(2));

    ResponseUtil.success(res, {
      totalAccounts,
      activeRewardUsers: totalAccounts,
      flaggedAccounts,
      totalIssued,
      totalCoinsIssued: totalIssued,
      totalRedeemed,
      totalCoinsRedeemed: totalRedeemed,
      totalExpired,
      totalCoinsExpired: totalExpired,
      totalCoinsReversed: totalReversed,
      currentInCirculation,
      coinsInCirculation: currentInCirculation,
      circulationValueInYER,
      redemptionRate,
      todayCheckins,
      activeCampaignsCount,
      activeMissionsCount,
    });
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 2. RULES CONFIGURATION (§64, §112)
// ==============================================================================
router.get('/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await RewardsConfigService.getRules();
    ResponseUtil.success(res, rules);
  } catch (err) {
    next(err);
  }
});

router.put('/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await RewardsConfigService.updateRules(req.body, req.user!.userId);
    ResponseUtil.success(res, updated, 'تم تحديث قواعد ونسب العملات بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 3. FEATURE FLAGS & EMERGENCY KILL SWITCH (§106, §107, §108, §109)
// ==============================================================================
router.get('/feature-flags', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const flags = await RewardsConfigService.getFeatureFlags();
    ResponseUtil.success(res, flags);
  } catch (err) {
    next(err);
  }
});

router.put('/feature-flags', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const flags = await RewardsConfigService.updateFeatureFlags(req.body, req.user!.userId);
    if (req.body.flagKey === 'rewards_coins.enabled') {
      try {
        await prisma.featureFlag.upsert({
          where: { key: 'coins_rewards' },
          update: { enabled: req.body.enabled },
          create: {
            key: 'coins_rewards',
            enabled: req.body.enabled,
            displayNameAr: 'مكافآت وعملات سوقناا',
            displayNameEn: 'Coins & Rewards System',
            platforms: JSON.stringify(['android', 'ios', 'web']),
          },
        });
        remoteConfigService.invalidateCache();
      } catch (_) {}
    }
    ResponseUtil.success(res, flags, 'تم تحديث إعدادات ميزات ومفاتيح نظام العملات');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 4. MISSIONS MANAGEMENT (§65)
// ==============================================================================
router.get('/missions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const missions = await prisma.rewardMission.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { progressRecords: true } },
      },
    });
    ResponseUtil.success(res, missions);
  } catch (err) {
    next(err);
  }
});

router.post('/missions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      titleAr,
      titleEn,
      descriptionAr,
      descriptionEn,
      type,
      target = 1,
      rewardCoins,
      startAt,
      endAt,
      status = 'ACTIVE',
      badgeIcon,
      maxCompletions,
      perCustomerLimit = 1,
    } = req.body;

    if (!titleAr || !type || !rewardCoins || !startAt || !endAt) {
      throw new AppError('يرجى ملء جميع الحقول المطلوبة للمهمة', 400);
    }

    const mission = await prisma.rewardMission.create({
      data: {
        titleAr,
        titleEn: titleEn || titleAr,
        descriptionAr: descriptionAr || titleAr,
        descriptionEn: descriptionEn || titleEn || titleAr,
        type,
        target: parseInt(String(target), 10) || 1,
        rewardCoins: parseInt(String(rewardCoins), 10),
        startAt: new Date(startAt),
        endAt: new Date(endAt),
        status,
        badgeIcon,
        maxCompletions: maxCompletions ? parseInt(String(maxCompletions), 10) : null,
        perCustomerLimit: parseInt(String(perCustomerLimit), 10) || 1,
      },
    });

    ResponseUtil.success(res, mission, 'تم إنشاء المهمة بنجاح');
  } catch (err) {
    next(err);
  }
});

router.put('/missions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mission = await prisma.rewardMission.update({
      where: { id: String(req.params.id) },
      data: req.body,
    });
    ResponseUtil.success(res, mission, 'تم تحديث المهمة بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 5. DAILY CHECK-IN SCHEDULE CONFIGURATION (§66)
// ==============================================================================
router.get('/check-in/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schedule = await prisma.dailyCheckinSchedule.findMany({
      orderBy: { dayNumber: 'asc' },
    });
    ResponseUtil.success(res, schedule);
  } catch (err) {
    next(err);
  }
});

router.put('/check-in/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days: any[] = req.body.days;
    if (!Array.isArray(days)) {
      throw new AppError('صيغة الجدول غير صالحة', 400);
    }

    for (const d of days) {
      await prisma.dailyCheckinSchedule.upsert({
        where: { dayNumber: d.dayNumber },
        update: {
          rewardCoins: d.rewardCoins,
          bonusCoins: d.bonusCoins || 0,
          labelAr: d.labelAr,
          labelEn: d.labelEn,
        },
        create: {
          dayNumber: d.dayNumber,
          rewardCoins: d.rewardCoins,
          bonusCoins: d.bonusCoins || 0,
          labelAr: d.labelAr || `اليوم ${d.dayNumber}`,
          labelEn: d.labelEn || `Day ${d.dayNumber}`,
        },
      });
    }

    const updated = await prisma.dailyCheckinSchedule.findMany({
      orderBy: { dayNumber: 'asc' },
    });
    ResponseUtil.success(res, updated, 'تم تحديث جدول مكافآت تسجيل الدخول اليومي');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 6. CAMPAIGNS CREATION & MANAGEMENT (§67, §68)
// ==============================================================================
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaigns = await prisma.coinCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        seller: { select: { id: true, stores: { select: { name: true } } } },
      },
    });
    ResponseUtil.success(res, campaigns);
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      nameAr,
      slug,
      descriptionAr,
      descriptionEn,
      campaignType = 'MEGA_CAMPAIGN',
      fundingSource = 'PLATFORM',
      sellerId,
      startAt,
      endAt,
      multiplier = 1.0,
      bonusCoins = 0,
      minOrderAmount,
      maxRewardPerOrder,
      allocatedBudget,
      status = 'ACTIVE',
    } = req.body;

    const campaign = await prisma.coinCampaign.create({
      data: {
        name,
        nameAr: nameAr || name,
        slug: slug || `campaign-${Date.now()}`,
        descriptionAr,
        descriptionEn,
        campaignType,
        fundingSource,
        sellerId,
        startAt: new Date(startAt),
        endAt: new Date(endAt),
        multiplier: parseFloat(String(multiplier)) || 1.0,
        bonusCoins: parseInt(String(bonusCoins), 10) || 0,
        minOrderAmount: minOrderAmount ? parseFloat(String(minOrderAmount)) : null,
        maxRewardPerOrder: maxRewardPerOrder ? parseInt(String(maxRewardPerOrder), 10) : null,
        allocatedBudget: allocatedBudget ? parseFloat(String(allocatedBudget)) : null,
        status,
      },
    });

    ResponseUtil.success(res, campaign, 'تم إنشاء حملة العملات بنجاح');
  } catch (err) {
    next(err);
  }
});

router.put('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await prisma.coinCampaign.update({
      where: { id: String(req.params.id) },
      data: req.body,
    });
    ResponseUtil.success(res, updated, 'تم تحديث الحملة بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 7. SELLER REWARDS BUDGETS (§40, §43, §69)
// ==============================================================================
router.get('/sellers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const budgets = await prisma.sellerRewardBudget.findMany({
      include: {
        seller: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true, email: true } },
            stores: { select: { name: true, logo: true } },
          },
        },
      },
    });
    ResponseUtil.success(res, budgets);
  } catch (err) {
    next(err);
  }
});

router.post('/sellers/:id/budget', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = String(req.params.id);
    const { allocatedBudget, maxRewardPerCustomer, maxRewardPerOrder, isActive = true } = req.body;

    const existing = await prisma.sellerRewardBudget.findUnique({ where: { sellerId } });
    const additional = parseFloat(String(allocatedBudget || 0));

    const budget = await prisma.sellerRewardBudget.upsert({
      where: { sellerId },
      update: {
        allocatedBudget: (existing?.allocatedBudget || 0) + additional,
        remainingBudget: (existing?.remainingBudget || 0) + additional,
        maxRewardPerCustomer: maxRewardPerCustomer ? parseInt(String(maxRewardPerCustomer), 10) : undefined,
        maxRewardPerOrder: maxRewardPerOrder ? parseInt(String(maxRewardPerOrder), 10) : undefined,
        isActive,
      },
      create: {
        sellerId,
        allocatedBudget: additional,
        spentBudget: 0,
        remainingBudget: additional,
        maxRewardPerCustomer: maxRewardPerCustomer ? parseInt(String(maxRewardPerCustomer), 10) : 500,
        maxRewardPerOrder: maxRewardPerOrder ? parseInt(String(maxRewardPerOrder), 10) : 200,
        isActive,
      },
    });

    ResponseUtil.success(res, budget, 'تم تخصيص ميزانية مكافآت المتجر بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 8. GLOBAL AUDIT TRANSACTIONS LEDGER (§73)
// ==============================================================================
router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const { customerId, type, referenceType, referenceId } = req.query;
    const where: any = {};
    if (customerId) where.customerId = String(customerId);
    if (type) where.type = type as RewardTxType;
    if (referenceType) where.referenceType = String(referenceType);
    if (referenceId) where.referenceId = String(referenceId);

    const [total, transactions] = await Promise.all([
      prisma.coinTransaction.count({ where }),
      prisma.coinTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
        },
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
// 9. CUSTOMER LOOKUP & DETAIL (§72)
// ==============================================================================
router.get('/customer/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawQuery = String(req.params.customerId).trim();
    let targetCustomerId = rawQuery;

    // Try finding user by id, email, phone, or referral code
    const foundUser = await prisma.user.findFirst({
      where: {
        OR: [
          { id: rawQuery },
          { email: { equals: rawQuery, mode: 'insensitive' } },
          { phone: rawQuery },
          { phone: `+967${rawQuery.replace(/^0+/, '')}` },
        ],
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });

    if (foundUser) {
      targetCustomerId = foundUser.id;
    } else {
      // Check if rawQuery is a referral code
      const accountByCode = await prisma.rewardAccount.findUnique({
        where: { referralCode: rawQuery.toUpperCase() },
        select: { customerId: true },
      });
      if (accountByCode) {
        targetCustomerId = accountByCode.customerId;
      }
    }

    const [account, authoritativeBalance, recentTransactions, activeLots, auditLogs, customerUser] = await Promise.all([
      RewardsLedgerService.getOrCreateAccount(targetCustomerId),
      RewardsLedgerService.getAuthoritativeBalance(targetCustomerId),
      prisma.coinTransaction.findMany({
        where: { customerId: targetCustomerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.coinLot.findMany({
        where: { customerId: targetCustomerId, status: CoinLotStatus.ACTIVE, remainingCoins: { gt: 0 } },
        orderBy: { expiresAt: 'asc' },
      }),
      prisma.rewardAuditLog.findMany({
        where: { targetCustomerId: targetCustomerId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { admin: { select: { firstName: true, lastName: true } } },
      }),
      foundUser
        ? Promise.resolve(foundUser)
        : prisma.user.findUnique({
            where: { id: targetCustomerId },
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          }),
    ]);

    ResponseUtil.success(res, {
      account,
      authoritativeBalance,
      customer: customerUser,
      recentTransactions,
      activeLots,
      auditLogs,
    });
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 10. MANUAL COIN ADJUSTMENT WITH MANDATORY AUDIT TRAIL (§71)
// ==============================================================================
router.post('/adjust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customerId, action, coins, reason } = req.body;

    if (!customerId || !action || !coins || !reason) {
      throw new AppError('جميع الحقول (العميل، العملية، العملات، وسبب التعديل) إلزامية', 400);
    }

    const coinsNum = Math.abs(parseInt(String(coins), 10));
    if (coinsNum <= 0) {
      throw new AppError('عدد العملات يجب أن يكون أكبر من الصفر', 400);
    }

    let result;
    if (action === 'CREDIT' || action === 'ADD') {
      result = await RewardsLedgerService.creditCoins({
        customerId,
        coins: coinsNum,
        type: RewardTxType.ADMIN_ADJUSTMENT,
        source: RewardTxSource.ADMIN,
        descriptionAr: `تعديل يدوي من الإدارة: ${reason}`,
        descriptionEn: `Manual admin credit: ${reason}`,
        createdBy: req.user!.userId,
      });

      await RewardsNotificationService.notifyCoinsEarned({
        customerId,
        coins: coinsNum,
        reasonAr: `كإضافة خاصة من إدارة سوقناا (${reason})`,
        reasonEn: `as a special credit from SOUQNAA Admin (${reason})`,
      });
    } else if (action === 'DEBIT' || action === 'DEDUCT') {
      result = await RewardsLedgerService.debitCoinsFIFO({
        customerId,
        coins: coinsNum,
        type: RewardTxType.ADMIN_ADJUSTMENT,
        source: RewardTxSource.ADMIN,
        descriptionAr: `خصم يدوي من الإدارة: ${reason}`,
        descriptionEn: `Manual admin debit: ${reason}`,
        createdBy: req.user!.userId,
        allowNegative: true,
      });

      await RewardsNotificationService.notifyCoinsReversed({
        customerId,
        coins: coinsNum,
        reasonAr: `كتعديل إداري (${reason})`,
        reasonEn: `as an administrative adjustment (${reason})`,
      });
    } else {
      throw new AppError('نوع العملية غير مدعوم. اختر CREDIT أو DEBIT', 400);
    }

    // Record mandatory RewardAuditLog (§71)
    await prisma.rewardAuditLog.create({
      data: {
        adminId: req.user!.userId,
        action: action === 'CREDIT' ? 'MANUAL_CREDIT' : 'MANUAL_DEBIT',
        resource: 'rewards_adjustment',
        targetCustomerId: customerId,
        details: JSON.stringify({ coins: coinsNum, reason, action }),
        ipAddress: req.ip,
      },
    });

    ResponseUtil.success(res, result, 'تم تنفيذ التعديل وتسجيله في سجل التدقيق بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 11. FRAUD & RISK ACCOUNTS (§74)
// ==============================================================================
router.get('/fraud', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const flagged = await prisma.rewardAccount.findMany({
      where: { riskFlag: true },
      include: {
        customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
    ResponseUtil.success(res, flagged);
  } catch (err) {
    next(err);
  }
});

router.post('/fraud/:customerId/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = String(req.params.customerId);
    const { resolveRisk = true, note } = req.body;
    const account = await prisma.rewardAccount.update({
      where: { customerId },
      data: {
        riskFlag: !resolveRisk,
        riskReason: resolveRisk ? null : note,
      },
    });

    await prisma.rewardAuditLog.create({
      data: {
        adminId: req.user!.userId,
        action: resolveRisk ? 'RISK_FLAG_CLEARED' : 'RISK_FLAG_SET',
        resource: 'fraud_prevention',
        targetCustomerId: customerId,
        details: JSON.stringify({ resolveRisk, note }),
      },
    });

    ResponseUtil.success(res, account, 'تم تحديث حالة المخاطر للحساب بنجاح');
  } catch (err) {
    next(err);
  }
});

// ==============================================================================
// 12. MANUAL BACKGROUND JOBS TRIGGER (§84, §85)
// ==============================================================================
router.post('/jobs/expire-now', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await RewardsExpirationService.expireCoins();
    ResponseUtil.success(res, result, 'تم تشغيل مهمة انتهاء صلاحية العملات بنجاح');
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/reconcile-now', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await RewardsExpirationService.reconcileBalances();
    ResponseUtil.success(res, result, 'تم تشغيل مهمة مطابقة الأرصدة بنجاح');
  } catch (err) {
    next(err);
  }
});

export const adminRewardsRoutes = router;
