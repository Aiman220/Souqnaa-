import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  RewardTxType,
  RewardTxSource,
  RewardFundingSource,
  MissionType,
  MissionStatus,
  CoinCampaignStatus,
  DailyCheckinStatus,
  MissionWithProgress,
  ReferralRecordStatus,
} from '../rewards.types';
import { RewardsConfigService } from './rewards-config.service';
import { RewardsLedgerService } from './rewards-ledger.service';
import { RewardsNotificationService } from './rewards-notification.service';
import { MembershipBenefitEngine } from '../../membership/membership-benefit.engine';

export class RewardsEarningService {
  /**
   * Helper to format server date string in Asia/Aden timezone (YYYY-MM-DD).
   */
  static getTodayDateStr(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date());
  }

  // ============================================================================
  // 1. PURCHASE REWARDS (§19, §20, §37, §38, §39, §40, §41, §42, §43, §44)
  // ============================================================================

  static async onOrderDelivered(params: {
    orderId: string;
    userId: string;
    orderNumber: string;
    subtotal: number;
    sellerId?: string;
    externalTx?: any;
  }) {
    const { orderId, userId, orderNumber, subtotal, externalTx } = params;

    const isEnabled = await RewardsConfigService.isEnabled('rewards_purchase_rewards.enabled');
    if (!isEnabled) return null;

    const rules = await RewardsConfigService.getRules();

    if (subtotal < rules.minPurchaseForReward) {
      return null;
    }

    // 1. Resolve sellerId if not explicitly provided
    let sellerId: string | null = params.sellerId || null;
    if (!sellerId && orderId) {
      try {
        const sellerOrder = await prisma.sellerOrder.findFirst({
          where: { orderId },
          select: { sellerId: true },
        });
        if (sellerOrder?.sellerId) {
          sellerId = sellerOrder.sellerId;
        }
      } catch (_) {}
    }

    // 2. Calculate Base Coins
    let earnedCoins = Math.floor(subtotal * rules.purchaseRewardRate);
    let fundingSource: RewardFundingSource = RewardFundingSource.PLATFORM;
    let campaignId: string | null = null;
    let multiplier = 1.0;

    // 3. Check for Active Coin Campaigns: Prioritize Seller-funded campaigns (§40, §43), fallback to Platform (§37)
    const now = new Date();
    let activeCampaign = null;

    if (sellerId) {
      activeCampaign = await prisma.coinCampaign.findFirst({
        where: {
          sellerId,
          status: CoinCampaignStatus.ACTIVE,
          startAt: { lte: now },
          endAt: { gte: now },
          OR: [
            { minOrderAmount: null },
            { minOrderAmount: { lte: subtotal } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!activeCampaign) {
      activeCampaign = await prisma.coinCampaign.findFirst({
        where: {
          fundingSource: RewardFundingSource.PLATFORM,
          status: CoinCampaignStatus.ACTIVE,
          startAt: { lte: now },
          endAt: { gte: now },
          OR: [
            { minOrderAmount: null },
            { minOrderAmount: { lte: subtotal } },
          ],
        },
        orderBy: { multiplier: 'desc' },
      });
    }

    if (activeCampaign) {
      multiplier = activeCampaign.multiplier || 1.0;
      earnedCoins = Math.floor(earnedCoins * multiplier) + (activeCampaign.bonusCoins || 0);
      campaignId = activeCampaign.id;
      fundingSource = activeCampaign.fundingSource;
      sellerId = activeCampaign.sellerId || sellerId;
    }

    // 3.1 Apply Membership Tier Coins Multiplier (e.g. VIP 1.2x, VIP+ 1.35x) (§53)
    try {
      const membershipCtx = await MembershipBenefitEngine.getMembershipContext(userId);
      if (membershipCtx && membershipCtx.coinsMultiplier > 1.0) {
        multiplier *= membershipCtx.coinsMultiplier;
        earnedCoins = Math.floor(earnedCoins * membershipCtx.coinsMultiplier);
      }
    } catch (_) {}

    // Enforce max reward per order (§44)
    earnedCoins = Math.min(earnedCoins, rules.maxRewardPerOrder);

    if (earnedCoins <= 0) return null;

    // 3. If Seller-funded, verify and debit seller promotional budget (§40, §43)
    if (fundingSource === RewardFundingSource.SELLER && sellerId) {
      const budget = await prisma.sellerRewardBudget.findUnique({
        where: { sellerId },
      });

      if (!budget || !budget.isActive || budget.remainingBudget <= 0) {
        // Fallback to platform-funded if seller budget depleted
        fundingSource = RewardFundingSource.PLATFORM;
      } else {
        const estimatedCost = earnedCoins / (rules.redemptionRatio || 100);
        if (budget.remainingBudget < estimatedCost) {
          earnedCoins = Math.floor(budget.remainingBudget * rules.redemptionRatio);
        }
        await prisma.sellerRewardBudget.update({
          where: { sellerId },
          data: {
            spentBudget: { increment: estimatedCost },
            remainingBudget: { decrement: estimatedCost },
          },
        });
      }
    }

    // 4. Credit coins with idempotency key
    const idempotencyKey = `orderDeliveredReward:${orderId}`;
    const result = await RewardsLedgerService.creditCoins(
      {
        customerId: userId,
        coins: earnedCoins,
        type: RewardTxType.PURCHASE_REWARD,
        source: RewardTxSource.PURCHASE,
        fundingSource,
        campaignId: campaignId || undefined,
        sellerId: sellerId || undefined,
        referenceType: 'ORDER',
        referenceId: orderId,
        idempotencyKey,
        descriptionAr: `مكافأة إتمام الطلب #${orderNumber} (${earnedCoins} عملة${multiplier > 1 ? ` - مضاعف ${multiplier}x` : ''})`,
        descriptionEn: `Reward for completing order #${orderNumber} (${earnedCoins} coins${multiplier > 1 ? ` - ${multiplier}x multiplier` : ''})`,
        metadata: {
          orderId,
          orderNumber,
          subtotal,
          multiplier,
          campaignId,
        },
      },
      externalTx
    );

    if (!result.isDuplicate) {
      // 5. Send Notification
      await RewardsNotificationService.notifyCoinsEarned({
        customerId: userId,
        coins: earnedCoins,
        reasonAr: `من طلبك رقم #${orderNumber}`,
        reasonEn: `from your order #${orderNumber}`,
        referenceId: orderId,
      });

      // 6. Update Campaign stats if applicable
      if (campaignId) {
        await prisma.coinCampaign.update({
          where: { id: campaignId },
          data: {
            totalCoinsIssued: { increment: earnedCoins },
            participantCount: { increment: 1 },
          },
        });
      }

      // 7. Increment Mission Progress for purchase count & amount
      await this.incrementMissionProgress(userId, MissionType.ORDER_COMPLETION, 1);
      await this.incrementMissionProgress(userId, MissionType.PURCHASE_COUNT, 1);
      await this.incrementMissionProgress(userId, MissionType.PURCHASE_AMOUNT, Math.floor(subtotal));

      // 8. Check for First Order Referral Qualification (§35, §36)
      await this.onFirstOrderCompleted({ refereeId: userId, orderId, orderAmount: subtotal });
    }

    return result;
  }

  // ============================================================================
  // 2. REVIEW REWARDS (§32, §33, §34)
  // ============================================================================

  static async onReviewCreated(params: {
    reviewId: string;
    userId: string;
    productId: string;
    hasPhoto?: boolean;
    hasVideo?: boolean;
  }) {
    const { reviewId, userId, productId, hasPhoto = false, hasVideo = false } = params;

    const isEnabled = await RewardsConfigService.isEnabled('rewards_review_rewards.enabled');
    if (!isEnabled) return null;

    const rules = await RewardsConfigService.getRules();
    let rewardCoins = rules.reviewTextReward;

    const isPhotoEnabled = await RewardsConfigService.isEnabled('rewards_photo_review_rewards.enabled');
    const isVideoEnabled = await RewardsConfigService.isEnabled('rewards_video_review_rewards.enabled');

    if (hasVideo && isVideoEnabled) {
      rewardCoins = rules.reviewVideoReward;
    } else if (hasPhoto && isPhotoEnabled) {
      rewardCoins = rules.reviewPhotoReward;
    }

    if (rewardCoins <= 0) return null;

    const idempotencyKey = `reviewReward:${reviewId}`;
    const result = await RewardsLedgerService.creditCoins({
      customerId: userId,
      coins: rewardCoins,
      type: RewardTxType.REVIEW_REWARD,
      source: RewardTxSource.REVIEW,
      referenceType: 'REVIEW',
      referenceId: reviewId,
      idempotencyKey,
      descriptionAr: `مكافأة تقييم منتج (${hasVideo ? 'فيديو' : hasPhoto ? 'صورة' : 'نصي'})`,
      descriptionEn: `Reward for product review (${hasVideo ? 'video' : hasPhoto ? 'photo' : 'text'})`,
      metadata: { reviewId, productId, hasPhoto, hasVideo },
    });

    if (!result.isDuplicate) {
      await RewardsNotificationService.notifyCoinsEarned({
        customerId: userId,
        coins: rewardCoins,
        reasonAr: 'لكتابة تقييم ومشاركة تجربتك',
        reasonEn: 'for writing a product review',
        referenceId: reviewId,
      });

      // Increment mission progress for reviews
      await this.incrementMissionProgress(userId, MissionType.REVIEW, 1);
      if (hasPhoto) {
        await this.incrementMissionProgress(userId, MissionType.PHOTO_REVIEW, 1);
      }
      if (hasVideo) {
        await this.incrementMissionProgress(userId, MissionType.VIDEO_REVIEW, 1);
      }
    }

    return result;
  }

  // ============================================================================
  // 3. DAILY CHECK-IN (§24, §25, §26, §27)
  // ============================================================================

  static async getDailyCheckinStatus(customerId: string): Promise<DailyCheckinStatus> {
    const account = await RewardsLedgerService.getOrCreateAccount(customerId);
    const todayStr = this.getTodayDateStr();

    // Check if claimed today
    const todayCheckin = await prisma.dailyCheckin.findUnique({
      where: {
        customerId_checkinDate: {
          customerId,
          checkinDate: todayStr,
        },
      },
    });

    const hasClaimedToday = !!todayCheckin;

    // Load 7-day schedule (create default if missing)
    let schedules = await prisma.dailyCheckinSchedule.findMany({
      orderBy: { dayNumber: 'asc' },
    });

    if (schedules.length < 7) {
      const defaultDays = [
        { dayNumber: 1, rewardCoins: 10, bonusCoins: 0, labelAr: 'اليوم 1', labelEn: 'Day 1' },
        { dayNumber: 2, rewardCoins: 15, bonusCoins: 0, labelAr: 'اليوم 2', labelEn: 'Day 2' },
        { dayNumber: 3, rewardCoins: 20, bonusCoins: 0, labelAr: 'اليوم 3', labelEn: 'Day 3' },
        { dayNumber: 4, rewardCoins: 25, bonusCoins: 0, labelAr: 'اليوم 4', labelEn: 'Day 4' },
        { dayNumber: 5, rewardCoins: 30, bonusCoins: 0, labelAr: 'اليوم 5', labelEn: 'Day 5' },
        { dayNumber: 6, rewardCoins: 40, bonusCoins: 0, labelAr: 'اليوم 6', labelEn: 'Day 6' },
        { dayNumber: 7, rewardCoins: 100, bonusCoins: 50, labelAr: 'اليوم 7', labelEn: 'Day 7' },
      ];

      for (const d of defaultDays) {
        await prisma.dailyCheckinSchedule.upsert({
          where: { dayNumber: d.dayNumber },
          update: {},
          create: d,
        });
      }

      schedules = await prisma.dailyCheckinSchedule.findMany({
        orderBy: { dayNumber: 'asc' },
      });
    }

    // Determine current dayIndex (1..7) based on streak
    let streak = account.currentStreak;
    let dayIndex = (streak % 7);
    if (!hasClaimedToday) {
      dayIndex = dayIndex + 1;
    }
    if (dayIndex > 7) dayIndex = 1;
    if (dayIndex === 0) dayIndex = 7;

    const todaySchedule = schedules.find((s) => s.dayNumber === dayIndex) || schedules[0];
    const todayRewardCoins = todaySchedule.rewardCoins + todaySchedule.bonusCoins;

    const formattedSchedule = schedules.map((s) => {
      const isClaimed = s.dayNumber < dayIndex || (s.dayNumber === dayIndex && hasClaimedToday);
      const isToday = s.dayNumber === dayIndex;
      const isMissed = false;

      return {
        dayNumber: s.dayNumber,
        coins: s.rewardCoins,
        bonusCoins: s.bonusCoins,
        labelAr: s.labelAr,
        labelEn: s.labelEn,
        isToday,
        isClaimed,
        isMissed,
      };
    });

    return {
      todayDate: todayStr,
      hasClaimedToday,
      currentStreak: account.currentStreak,
      longestStreak: account.longestStreak,
      todayRewardCoins,
      schedule: formattedSchedule,
    };
  }

  static async claimDailyCheckin(customerId: string) {
    const isEnabled = await RewardsConfigService.isEnabled('rewards_daily_checkin.enabled');
    if (!isEnabled) {
      throw new AppError('مكافآت تسجيل الدخول اليومي غير مفعلة حالياً', 400);
    }

    const todayStr = this.getTodayDateStr();

    return prisma.$transaction(async (tx) => {
      // 1. Anti-Abuse: Prevent multiple check-ins per day using unique constraint & row lock
      const existing = await tx.dailyCheckin.findUnique({
        where: {
          customerId_checkinDate: {
            customerId,
            checkinDate: todayStr,
          },
        },
      });

      if (existing) {
        throw new AppError('لقد حصلت على مكافأة تسجيل الدخول لليوم بالفعل!', 400, 'ALREADY_CLAIMED');
      }

      const account = await RewardsLedgerService.getOrCreateAccount(customerId, tx);

      // 2. Server-side timezone-aware streak calculation (§25, §26)
      // Yesterday in Asia/Aden timezone
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(yesterday);

      let newStreak = 1;
      if (account.lastCheckInDate === yesterdayStr) {
        newStreak = account.currentStreak + 1;
      } else if (account.lastCheckInDate === todayStr) {
        throw new AppError('تم تسجيل الدخول مسبقاً اليوم', 400);
      }

      const longestStreak = Math.max(account.longestStreak, newStreak);
      const dayIndex = ((newStreak - 1) % 7) + 1;

      // 3. Fetch schedule reward
      const schedule = await tx.dailyCheckinSchedule.findUnique({
        where: { dayNumber: dayIndex },
      });

      const coinsAwarded = schedule ? schedule.rewardCoins + schedule.bonusCoins : (10 * dayIndex);

      // 4. Create authoritative ledger credit
      const idempotencyKey = `checkin:${customerId}:${todayStr}`;
      const creditRes = await RewardsLedgerService.creditCoins(
        {
          customerId,
          coins: coinsAwarded,
          type: RewardTxType.CHECK_IN,
          source: RewardTxSource.CHECK_IN,
          referenceType: 'CHECK_IN',
          referenceId: todayStr,
          idempotencyKey,
          descriptionAr: `مكافأة تسجيل الدخول اليومي - اليوم ${dayIndex} (سلسلة ${newStreak} أيام)`,
          descriptionEn: `Daily check-in reward - Day ${dayIndex} (${newStreak}-day streak)`,
          metadata: { streak: newStreak, dayIndex, checkinDate: todayStr },
        },
        tx
      );

      // 5. Create DailyCheckin record
      const checkin = await tx.dailyCheckin.create({
        data: {
          customerId,
          checkinDate: todayStr,
          dayIndex,
          coinsAwarded,
          streakCount: newStreak,
          rewardTransactionId: creditRes.transaction.id,
        },
      });

      // 6. Update RewardAccount streak
      await tx.rewardAccount.update({
        where: { id: account.id },
        data: {
          currentStreak: newStreak,
          longestStreak,
          lastCheckInDate: todayStr,
          lastCheckInAt: new Date(),
        },
      });

      // 7. Send notification
      await RewardsNotificationService.notifyCheckinClaimed({
        customerId,
        coins: coinsAwarded,
        streak: newStreak,
      });

      return {
        checkin,
        coinsAwarded,
        streak: newStreak,
        longestStreak,
      };
    });
  }

  // ============================================================================
  // 4. MISSIONS ENGINE (§28, §29, §30, §31, §65)
  // ============================================================================

  static async getMissionsForCustomer(customerId: string): Promise<MissionWithProgress[]> {
    const now = new Date();
    let missions = await prisma.rewardMission.findMany({
      where: {
        status: MissionStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gte: now },
      },
      include: {
        progressRecords: {
          where: { customerId },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (missions.length === 0) {
      const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      const defaultMissions = [
        {
          titleAr: 'إكمال أول طلب تسوق',
          titleEn: 'Complete Your First Order',
          descriptionAr: 'اطلب أي منتج من سوقناا واستمتع بمكافأة ترحيبية فورية',
          descriptionEn: 'Order any product on Souqnaa and get an instant welcome reward',
          type: MissionType.ORDER_COMPLETION,
          target: 1,
          rewardCoins: 150,
          badgeIcon: 'shopping_bag',
          startAt: now,
          endAt: oneYearLater,
          status: MissionStatus.ACTIVE,
        },
        {
          titleAr: 'تقييم المنتجات المشتراة',
          titleEn: 'Review Purchased Products',
          descriptionAr: 'أضف 3 تقييمات لمنتجات قمت بشرائها مع كتابة رأيك الصادق',
          descriptionEn: 'Add 3 reviews for purchased items with your honest experience',
          type: MissionType.REVIEW,
          target: 3,
          rewardCoins: 90,
          badgeIcon: 'rate_review',
          startAt: now,
          endAt: oneYearLater,
          status: MissionStatus.ACTIVE,
        },
        {
          titleAr: 'دعوة صديق للتسوق',
          titleEn: 'Invite a Friend',
          descriptionAr: 'شارك كود الدعوة الخاص بك واكسب عملات عند تسجيل صديقك',
          descriptionEn: 'Share your referral code and earn coins when your friend registers',
          type: MissionType.REFERRAL,
          target: 1,
          rewardCoins: 100,
          badgeIcon: 'group_add',
          startAt: now,
          endAt: oneYearLater,
          status: MissionStatus.ACTIVE,
        },
        {
          titleAr: 'إضافة منتجات للمفضلة',
          titleEn: 'Add Items to Wishlist',
          descriptionAr: 'احفظ 5 منتجات تعجبك في قائمة أمنياتك للرجوع إليها لاحقاً',
          descriptionEn: 'Save 5 products you like to your wishlist for later',
          type: MissionType.WISHLIST_ADD,
          target: 5,
          rewardCoins: 50,
          badgeIcon: 'favorite',
          startAt: now,
          endAt: oneYearLater,
          status: MissionStatus.ACTIVE,
        },
        {
          titleAr: 'مشتري مميز',
          titleEn: 'Prime Shopper Quest',
          descriptionAr: 'تسوق بقيمة إجمالية تصل إلى 15,000 ريال يمني',
          descriptionEn: 'Shop for a total of 15,000 YER or more on Souqnaa',
          type: MissionType.PURCHASE_AMOUNT,
          target: 15000,
          rewardCoins: 250,
          badgeIcon: 'loyalty',
          startAt: now,
          endAt: oneYearLater,
          status: MissionStatus.ACTIVE,
        },
      ];

      for (const m of defaultMissions) {
        await prisma.rewardMission.create({ data: m }).catch(() => null);
      }

      missions = await prisma.rewardMission.findMany({
        where: {
          status: MissionStatus.ACTIVE,
          startAt: { lte: now },
          endAt: { gte: now },
        },
        include: {
          progressRecords: {
            where: { customerId },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    return missions.map((m) => {
      const p = m.progressRecords[0];
      const progress = p ? p.progress : 0;
      const completed = p ? p.completed : false;
      const claimed = p ? p.claimed : false;
      const diffMs = m.endAt.getTime() - now.getTime();
      const expiresInHours = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));

      return {
        id: m.id,
        titleAr: m.titleAr,
        titleEn: m.titleEn,
        descriptionAr: m.descriptionAr,
        descriptionEn: m.descriptionEn,
        type: m.type,
        target: m.target,
        rewardCoins: m.rewardCoins,
        badgeIcon: m.badgeIcon,
        progress,
        completed,
        claimed,
        completedAt: p?.completedAt ? p.completedAt.toISOString() : null,
        claimedAt: p?.claimedAt ? p.claimedAt.toISOString() : null,
        startAt: m.startAt.toISOString(),
        endAt: m.endAt.toISOString(),
        expiresInHours,
      };
    });
  }

  static async incrementMissionProgress(customerId: string, type: MissionType, amount = 1) {
    const isEnabled = await RewardsConfigService.isEnabled('rewards_missions.enabled');
    if (!isEnabled) return;

    const now = new Date();
    const activeMissions = await prisma.rewardMission.findMany({
      where: {
        type,
        status: MissionStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gte: now },
      },
    });

    for (const mission of activeMissions) {
      // Check global limit
      if (mission.maxCompletions && mission.currentCompletions >= mission.maxCompletions) {
        continue;
      }

      await prisma.$transaction(async (tx) => {
        let record = await tx.customerMissionProgress.findUnique({
          where: {
            customerId_missionId: { customerId, missionId: mission.id },
          },
        });

        if (!record) {
          record = await tx.customerMissionProgress.create({
            data: {
              customerId,
              missionId: mission.id,
              progress: 0,
              target: mission.target,
              completed: false,
            },
          });
        }

        if (record.completed) return; // Already completed

        const newProgress = record.progress + amount;
        const completed = newProgress >= mission.target;

        await tx.customerMissionProgress.update({
          where: { id: record.id },
          data: {
            progress: newProgress,
            completed,
            completedAt: completed ? new Date() : null,
          },
        });

        if (completed) {
          await tx.rewardMission.update({
            where: { id: mission.id },
            data: { currentCompletions: { increment: 1 } },
          });

          await RewardsNotificationService.notifyMissionCompleted({
            customerId,
            missionTitleAr: mission.titleAr,
            missionTitleEn: mission.titleEn,
            rewardCoins: mission.rewardCoins,
          });
        }
      });
    }
  }

  static async claimMissionReward(customerId: string, missionId: string) {
    const isEnabled = await RewardsConfigService.isEnabled('rewards_missions.enabled');
    if (!isEnabled) {
      throw new AppError('المهمات والمكافآت غير مفعلة حالياً', 400);
    }

    return prisma.$transaction(async (tx) => {
      const record = await tx.customerMissionProgress.findUnique({
        where: {
          customerId_missionId: { customerId, missionId },
        },
        include: { mission: true },
      });

      if (!record) {
        throw new AppError('المهمة غير موجودة', 404);
      }

      if (!record.completed) {
        throw new AppError('لم تكتمل أهداف هذه المهمة بعد', 400);
      }

      if (record.claimed) {
        throw new AppError('تمت المطالبة بمكافأة هذه المهمة مسبقاً', 400, 'ALREADY_CLAIMED');
      }

      const rewardCoins = record.mission.rewardCoins;
      const idempotencyKey = `missionReward:${customerId}:${missionId}`;

      const creditRes = await RewardsLedgerService.creditCoins(
        {
          customerId,
          coins: rewardCoins,
          type: RewardTxType.MISSION_REWARD,
          source: RewardTxSource.MISSION,
          missionId,
          referenceType: 'MISSION',
          referenceId: missionId,
          idempotencyKey,
          descriptionAr: `مكافأة إنجاز مهمة: ${record.mission.titleAr}`,
          descriptionEn: `Reward for completing mission: ${record.mission.titleEn}`,
        },
        tx
      );

      await tx.customerMissionProgress.update({
        where: { id: record.id },
        data: {
          claimed: true,
          claimedAt: new Date(),
          rewardTransactionId: creditRes.transaction.id,
        },
      });

      return {
        claimed: true,
        coins: rewardCoins,
        missionTitle: record.mission.titleAr,
      };
    });
  }

  // ============================================================================
  // 5. REFERRAL SYSTEM (§35, §36)
  // ============================================================================

  static async applyReferralCode(refereeId: string, referralCode: string) {
    const isEnabled = await RewardsConfigService.isEnabled('rewards_referrals.enabled');
    if (!isEnabled) {
      throw new AppError('نظام الإحالة غير مفعل حالياً', 400);
    }

    const cleanCode = referralCode.trim().toUpperCase();

    // 1. Look up referrer by code
    const referrerAccount = await prisma.rewardAccount.findUnique({
      where: { referralCode: cleanCode },
    });

    if (!referrerAccount) {
      throw new AppError('كود الإحالة غير صحيح أو غير موجود', 404);
    }

    if (referrerAccount.customerId === refereeId) {
      throw new AppError('لا يمكنك استخدام كود الإحالة الخاص بك!', 400, 'SELF_REFERRAL_FORBIDDEN');
    }

    // Check if referee already was referred
    const existing = await prisma.referralRecord.findUnique({
      where: { refereeId },
    });

    if (existing) {
      throw new AppError('لقد قمت بربط كود إحالة مسبقاً', 400, 'ALREADY_REFERRED');
    }

    const rules = await RewardsConfigService.getRules();

    const record = await prisma.referralRecord.create({
      data: {
        referrerId: referrerAccount.customerId,
        refereeId,
        referralCode: cleanCode,
        status: ReferralRecordStatus.FIRST_ORDER_PENDING,
        referrerRewardCoins: rules.referralReferrerReward,
        refereeRewardCoins: rules.referralRefereeReward,
      },
    });

    return record;
  }

  static async onFirstOrderCompleted(params: {
    refereeId: string;
    orderId: string;
    orderAmount: number;
  }) {
    const { refereeId, orderId, orderAmount } = params;

    const referral = await prisma.referralRecord.findUnique({
      where: { refereeId },
    });

    if (!referral || referral.status !== ReferralRecordStatus.FIRST_ORDER_PENDING) {
      return;
    }

    const rules = await RewardsConfigService.getRules();
    if (orderAmount < rules.referralMinOrderAmount) {
      return; // Order did not meet minimum qualifying amount
    }

    await prisma.$transaction(async (tx) => {
      // Award Referrer
      const referrerTx = await RewardsLedgerService.creditCoins(
        {
          customerId: referral.referrerId,
          coins: referral.referrerRewardCoins,
          type: RewardTxType.REFERRAL_REWARD,
          source: RewardTxSource.REFERRAL,
          referenceType: 'REFERRAL',
          referenceId: referral.id,
          idempotencyKey: `refReward:referrer:${referral.id}`,
          descriptionAr: `مكافأة دعوة صديق أتم أول طلب (${referral.referralCode})`,
          descriptionEn: `Reward for referring a friend who completed first order (${referral.referralCode})`,
        },
        tx
      );

      // Award Referee
      const refereeTx = await RewardsLedgerService.creditCoins(
        {
          customerId: refereeId,
          coins: referral.refereeRewardCoins,
          type: RewardTxType.REFERRAL_REWARD,
          source: RewardTxSource.REFERRAL,
          referenceType: 'REFERRAL',
          referenceId: referral.id,
          idempotencyKey: `refReward:referee:${referral.id}`,
          descriptionAr: 'مكافأة ترحيبية لاستخدام كود إحالة وإتمام أول طلب',
          descriptionEn: 'Welcome bonus for using a referral code and completing first order',
        },
        tx
      );

      await tx.referralRecord.update({
        where: { id: referral.id },
        data: {
          status: ReferralRecordStatus.COMPLETED,
          firstOrderId: orderId,
          firstOrderAmount: orderAmount,
          completedAt: new Date(),
          referrerRewardTxId: referrerTx.transaction.id,
          refereeRewardTxId: refereeTx.transaction.id,
        },
      });

      // Send notifications
      await RewardsNotificationService.notifyReferralReward({
        customerId: referral.referrerId,
        coins: referral.referrerRewardCoins,
        isReferrer: true,
      });

      await RewardsNotificationService.notifyReferralReward({
        customerId: refereeId,
        coins: referral.refereeRewardCoins,
        isReferrer: false,
      });

      // Increment mission progress for referral
      await this.incrementMissionProgress(referral.referrerId, MissionType.REFERRAL, 1);
    });
  }
}
