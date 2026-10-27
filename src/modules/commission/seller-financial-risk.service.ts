/**
 * SOUQNAA Marketplace — Authoritative Seller Financial Risk, Reserve & Debt Recovery Engine
 * Production-grade engine for Seller COD eligibility, Platform Commission Collection,
 * Risk-Based Reserve Holding, Outstanding Debt Recovery, Configurable Exposure Limits,
 * Automatic Restrictions (New Orders & Withdrawals), and Multi-Vendor Reconciliation.
 * Version: 2.1.0
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { remoteConfigService } from '../remote-config/remote-config.service';

export interface FinancialRiskThresholds {
  warningThreshold: number;        // e.g. 5,000 YER
  criticalThreshold: number;       // e.g. 8,000 YER
  blockThreshold: number;          // e.g. 10,000 YER
  unblockThreshold: number;        // e.g. 4,000 YER
  blockingEnabled: boolean;
  warningEnabled: boolean;
  autoUnblockEnabled: boolean;
  partialDepositEnabled: boolean;
  baseReservePercentage: number;   // e.g. 0.10 (10% baseline)
  reserveHoldingDays: number;      // e.g. 30 days
  maxReservePercentage: number;    // e.g. 0.30 (30% cap)
  maxExposureLimit: number;        // e.g. 50,000 YER
  autoPauseNewOrders: boolean;     // e.g. true
  withdrawalRestrictionEnabled: boolean; // e.g. true
  automaticDebtRecoveryEnabled: boolean; // e.g. true
}

export interface SellerFinancialStanding {
  sellerId: string;
  storeName?: string;
  storeLogo?: string | null;
  ownerName?: string;
  phone?: string;
  email?: string | null;
  commissionRate?: number;
  totalSales?: number;
  totalCommission?: number;
  totalPayout?: number;
  ordersCount?: number;
  availableBalance: number;
  withdrawableBalance: number;
  pendingBalance: number;
  withdrawnBalance: number;
  outstandingCommission: number;
  totalReservedBalance: number;
  unsecuredExposure: number;
  currency: string;
  isFinanciallyRestricted: boolean;
  financialRestrictionLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'RESTRICTED';
  financialRestrictionReason: string | null;
  financialRestrictedAt: Date | null;
  cashOnDeliveryEnabled: boolean;
  newOrdersPaused: boolean;
  withdrawalsRestricted: boolean;
  riskTier: 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'UNDER_REVIEW';
  riskScore: number;
  reservePercentage: number;
  reserveHoldingDays: number;
  thresholds: FinancialRiskThresholds;
  amountNeededToUnblock: number;
  openOutstandingsCount: number;
  activeRestrictions?: Array<{
    id: string;
    restrictionType: string;
    reasonCode: string;
    status: string;
    triggeredAt: Date;
    metadata?: any;
  }>;
  reserveAllocations?: Array<{
    id: string;
    amount: number;
    currency: string;
    reservePercentage: number;
    riskTier: string;
    holdingDays: number;
    releaseEligibleAt: Date;
    status: string;
    reason?: string | null;
  }>;
  debtRecoveryAllocations?: Array<{
    id: string;
    amount: number;
    currency: string;
    recoveredFrom: string;
    createdAt: Date;
    notes?: string | null;
  }>;
  openOutstandings: Array<{
    id: string;
    sourceType: string;
    sourceReference: string | null;
    amount: number;
    paidAmount: number;
    remainingAmount: number;
    currency: string;
    status: string;
    warningLevel: string;
    createdAt: Date;
  }>;
  allOutstandings?: Array<{
    id: string;
    sourceType: string;
    sourceReference: string | null;
    amount: number;
    paidAmount: number;
    remainingAmount: number;
    currency: string;
    status: string;
    warningLevel: string;
    createdAt: Date;
  }>;
  recentOrders?: Array<{
    id: string;
    orderNumber: string;
    subtotal: number;
    commissionAmount: number;
    sellerPayout: number;
    paymentMethod: string;
    status: string;
    createdAt: Date;
  }>;
}

export class SellerFinancialRiskService {
  private static readonly DEFAULT_THRESHOLDS: FinancialRiskThresholds = {
    warningThreshold: 5000,
    criticalThreshold: 8000,
    blockThreshold: 10000,
    unblockThreshold: 4000,
    blockingEnabled: true,
    warningEnabled: true,
    autoUnblockEnabled: true,
    partialDepositEnabled: true,
    baseReservePercentage: 0.10,     // 10% baseline
    reserveHoldingDays: 30,          // 30 days baseline
    maxReservePercentage: 0.30,      // 30% cap
    maxExposureLimit: 50000,         // 50,000 YER cap
    autoPauseNewOrders: true,
    withdrawalRestrictionEnabled: true,
    automaticDebtRecoveryEnabled: true,
  };

  /**
   * Retrieves authoritative marketplace risk thresholds from Remote Config / DB
   */
  public static async getRiskThresholds(): Promise<FinancialRiskThresholds> {
    try {
      const [
        warningSetting,
        criticalSetting,
        blockSetting,
        unblockSetting,
        baseReserveSetting,
        holdingDaysSetting,
        maxReserveSetting,
        maxExposureSetting,
      ] = await Promise.all([
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_warning_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_critical_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_block_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_unblock_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_base_reserve_percentage' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_reserve_holding_days' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_max_reserve_percentage' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_max_exposure_limit' } }),
      ]);

      const isBlockingActive = await remoteConfigService.isFeatureActive('seller_outstanding_blocking_enabled');
      const isWarningActive = await remoteConfigService.isFeatureActive('seller_outstanding_warning_enabled');
      const isAutoUnblockActive = await remoteConfigService.isFeatureActive('seller_deposit_auto_unblock_enabled');
      const isPartialActive = await remoteConfigService.isFeatureActive('seller_partial_deposit_enabled');
      const isAutoPauseOrders = await remoteConfigService.isFeatureActive('seller_auto_pause_new_orders');
      const isWithdrawalRestriction = await remoteConfigService.isFeatureActive('seller_withdrawal_restriction_enabled');
      const isAutoDebtRecovery = await remoteConfigService.isFeatureActive('seller_automatic_debt_recovery_enabled');

      return {
        warningThreshold: warningSetting ? parseFloat(warningSetting.value) : this.DEFAULT_THRESHOLDS.warningThreshold,
        criticalThreshold: criticalSetting ? parseFloat(criticalSetting.value) : this.DEFAULT_THRESHOLDS.criticalThreshold,
        blockThreshold: blockSetting ? parseFloat(blockSetting.value) : this.DEFAULT_THRESHOLDS.blockThreshold,
        unblockThreshold: unblockSetting ? parseFloat(unblockSetting.value) : this.DEFAULT_THRESHOLDS.unblockThreshold,
        blockingEnabled: isBlockingActive,
        warningEnabled: isWarningActive,
        autoUnblockEnabled: isAutoUnblockActive,
        partialDepositEnabled: isPartialActive,
        baseReservePercentage: baseReserveSetting ? parseFloat(baseReserveSetting.value) : this.DEFAULT_THRESHOLDS.baseReservePercentage,
        reserveHoldingDays: holdingDaysSetting ? parseInt(holdingDaysSetting.value, 10) : this.DEFAULT_THRESHOLDS.reserveHoldingDays,
        maxReservePercentage: maxReserveSetting ? parseFloat(maxReserveSetting.value) : this.DEFAULT_THRESHOLDS.maxReservePercentage,
        maxExposureLimit: maxExposureSetting ? parseFloat(maxExposureSetting.value) : this.DEFAULT_THRESHOLDS.maxExposureLimit,
        autoPauseNewOrders: isAutoPauseOrders,
        withdrawalRestrictionEnabled: isWithdrawalRestriction,
        automaticDebtRecoveryEnabled: isAutoDebtRecovery,
      };
    } catch (_) {
      return this.DEFAULT_THRESHOLDS;
    }
  }

  /**
   * Deterministic, explainable risk tier calculation based on verified marketplace signals.
   */
  public static scoreRiskFactors(params: {
    accountAgeDays: number;
    completedOrdersCount: number;
    totalSales: number;
    totalRefunded: number;
    openDisputesCount: number;
    confirmedDebt: number;
    thresholds?: FinancialRiskThresholds;
  }): {
    compositeScore: number;
    riskTier: 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'UNDER_REVIEW';
    reservePercentage: number;
    holdingDays: number;
  } {
    const thresholds = params.thresholds || this.DEFAULT_THRESHOLDS;

    // 1. Account Age Signal
    let ageScore = 0;
    if (params.accountAgeDays < 30) {
      ageScore = 20;
    } else if (params.accountAgeDays < 90) {
      ageScore = 10;
    }

    // 2. Completed Orders & Volume Signal
    let volumeScore = 0;
    if (params.completedOrdersCount < 5) {
      volumeScore = 20;
    } else if (params.completedOrdersCount < 20) {
      volumeScore = 10;
    }

    // 3. Historical Refund Ratio Signal
    const refundRatio = params.totalSales > 0 ? params.totalRefunded / params.totalSales : 0;
    let refundScore = 0;
    if (refundRatio > 0.15) {
      refundScore = 30;
    } else if (refundRatio > 0.08) {
      refundScore = 15;
    } else if (refundRatio > 0.03) {
      refundScore = 5;
    }

    // 4. Dispute Signal
    const disputeScore = Math.min(25, params.openDisputesCount * 15);

    // 5. Outstanding Debt Signal
    let debtScore = 0;
    if (params.confirmedDebt >= thresholds.blockThreshold) {
      debtScore = 40;
    } else if (params.confirmedDebt >= thresholds.criticalThreshold) {
      debtScore = 25;
    } else if (params.confirmedDebt >= thresholds.warningThreshold) {
      debtScore = 10;
    }

    const compositeScore = Math.min(100, ageScore + volumeScore + refundScore + disputeScore + debtScore);

    let riskTier: 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'UNDER_REVIEW' = 'NORMAL';
    let reservePercentage = thresholds.baseReservePercentage;

    if (compositeScore >= 85 || params.confirmedDebt >= thresholds.blockThreshold) {
      riskTier = 'CRITICAL';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.25);
    } else if (compositeScore >= 65 || params.confirmedDebt >= thresholds.criticalThreshold) {
      riskTier = 'HIGH';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.20);
    } else if (compositeScore >= 45 || params.confirmedDebt >= thresholds.warningThreshold) {
      riskTier = 'ELEVATED';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.15);
    } else if (compositeScore <= 20 && params.completedOrdersCount >= 25 && params.accountAgeDays >= 60) {
      riskTier = 'LOW';
      reservePercentage = Math.max(0.05, thresholds.baseReservePercentage * 0.5);
    } else {
      riskTier = 'NORMAL';
      reservePercentage = thresholds.baseReservePercentage;
    }

    return {
      compositeScore,
      riskTier,
      reservePercentage,
      holdingDays: thresholds.reserveHoldingDays,
    };
  }

  /**
   * Deterministic, explainable risk tier calculation based on verified marketplace signals.
   */
  public static async calculateSellerRiskProfile(sellerId: string, tx?: any): Promise<any> {
    const db = tx || prisma;
    const thresholds = await this.getRiskThresholds();

    const seller = await db.seller.findUnique({
      where: { id: sellerId },
      include: {
        balance: true,
        riskProfile: true,
        outstandings: {
          where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        },
        reserveAllocations: {
          where: { status: 'RESERVED' },
        },
        sellerOrders: {
          select: { id: true, subtotal: true, status: true },
        },
        refundRequests: {
          select: { id: true, requestedAmount: true, status: true },
        },
        disputes: {
          where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
        },
      },
    });

    if (!seller) {
      throw new AppError('حساب البائع غير موجود', 404);
    }

    // 1. Account Age Signal
    const daysSinceCreation = Math.max(
      0,
      Math.floor((Date.now() - new Date(seller.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    );
    let ageScore = 0;
    if (daysSinceCreation < 30) {
      ageScore = 20; // New seller
    } else if (daysSinceCreation < 90) {
      ageScore = 10;
    }

    // 2. Completed Orders & Volume Signal
    const completedOrders = seller.sellerOrders.filter((so: any) => so.status === 'DELIVERED');
    let volumeScore = 0;
    if (completedOrders.length < 5) {
      volumeScore = 20;
    } else if (completedOrders.length < 20) {
      volumeScore = 10;
    }

    // 3. Historical Refund Ratio Signal
    const totalSales = completedOrders.reduce((sum: number, so: any) => sum + (so.subtotal || 0), 0);
    const completedRefunds = seller.refundRequests.filter(
      (r: any) => r.status === 'REFUND_COMPLETED' || r.status === 'ADMIN_APPROVED'
    );
    const totalRefunded = completedRefunds.reduce((sum: number, r: any) => sum + (r.requestedAmount || 0), 0);
    const refundRatio = totalSales > 0 ? totalRefunded / totalSales : 0;
    let refundScore = 0;
    if (refundRatio > 0.15) {
      refundScore = 30;
    } else if (refundRatio > 0.08) {
      refundScore = 15;
    } else if (refundRatio > 0.03) {
      refundScore = 5;
    }

    // 4. Dispute Signal
    const openDisputes = seller.disputes.length;
    const disputeScore = Math.min(25, openDisputes * 15);

    // 5. Outstanding Debt Signal
    const confirmedDebt = seller.outstandings.reduce(
      (sum: number, o: any) => sum + (o.remainingAmount || 0),
      0
    );
    let debtScore = 0;
    if (confirmedDebt >= thresholds.blockThreshold) {
      debtScore = 40;
    } else if (confirmedDebt >= thresholds.criticalThreshold) {
      debtScore = 25;
    } else if (confirmedDebt >= thresholds.warningThreshold) {
      debtScore = 10;
    }

    // Composite Risk Score (0 - 100)
    const compositeScore = Math.min(100, ageScore + volumeScore + refundScore + disputeScore + debtScore);

    // Map to Risk Tier & Effective Reserve Percentage
    let riskTier: 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'UNDER_REVIEW' = 'NORMAL';
    let reservePercentage = thresholds.baseReservePercentage; // baseline 10%

    if (compositeScore >= 85 || confirmedDebt >= thresholds.blockThreshold) {
      riskTier = 'CRITICAL';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.25);
    } else if (compositeScore >= 65 || confirmedDebt >= thresholds.criticalThreshold) {
      riskTier = 'HIGH';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.20);
    } else if (compositeScore >= 45 || confirmedDebt >= thresholds.warningThreshold) {
      riskTier = 'ELEVATED';
      reservePercentage = Math.min(thresholds.maxReservePercentage, 0.15);
    } else if (compositeScore <= 20 && completedOrders.length >= 25 && daysSinceCreation >= 60) {
      riskTier = 'LOW';
      reservePercentage = Math.max(0.05, thresholds.baseReservePercentage * 0.5); // 5% for low risk
    } else {
      riskTier = 'NORMAL';
      reservePercentage = thresholds.baseReservePercentage; // 10%
    }

    // Sum active reserves
    const totalReservedBalance = seller.reserveAllocations.reduce(
      (sum: number, r: any) => sum + (r.amount || 0),
      0
    );

    // Sum pending refund exposure
    const pendingRefunds = seller.refundRequests.filter(
      (r: any) => r.status === 'SUBMITTED' || r.status === 'UNDER_SELLER_REVIEW' || r.status === 'ADMIN_REVIEW'
    );
    const pendingExposure = pendingRefunds.reduce((sum: number, r: any) => sum + (r.requestedAmount || 0), 0);
    const totalUnsecuredExposure = Math.max(0, confirmedDebt + pendingExposure - totalReservedBalance);

    const shouldPauseOrders =
      (confirmedDebt >= thresholds.blockThreshold || totalUnsecuredExposure >= thresholds.maxExposureLimit) &&
      thresholds.autoPauseNewOrders;

    const shouldRestrictWithdrawals =
      (confirmedDebt >= thresholds.warningThreshold || totalUnsecuredExposure >= thresholds.maxExposureLimit) &&
      thresholds.withdrawalRestrictionEnabled;

    const profile = await db.sellerRiskProfile.upsert({
      where: { sellerId },
      create: {
        sellerId,
        riskTier,
        riskScore: compositeScore,
        reservePercentage,
        reserveHoldingDays: thresholds.reserveHoldingDays,
        maxReservePercentage: thresholds.maxReservePercentage,
        maxExposureLimit: thresholds.maxExposureLimit,
        totalReservedBalance,
        totalUnsecuredExposure,
        newOrdersPaused: shouldPauseOrders,
        withdrawalsRestricted: shouldRestrictWithdrawals,
        lastEvaluatedAt: new Date(),
        evaluationNotes: `تقييم تلقائي: نقاط المخاطر ${compositeScore}/100، المديونية القائمة: ${confirmedDebt} ر.ي، الاحتياطي المحجوز: ${totalReservedBalance} ر.ي`,
      },
      update: {
        riskTier,
        riskScore: compositeScore,
        reservePercentage,
        reserveHoldingDays: thresholds.reserveHoldingDays,
        maxReservePercentage: thresholds.maxReservePercentage,
        maxExposureLimit: thresholds.maxExposureLimit,
        totalReservedBalance,
        totalUnsecuredExposure,
        newOrdersPaused: shouldPauseOrders,
        withdrawalsRestricted: shouldRestrictWithdrawals,
        lastEvaluatedAt: new Date(),
        evaluationNotes: `تقييم تلقائي: نقاط المخاطر ${compositeScore}/100، المديونية القائمة: ${confirmedDebt} ر.ي، الاحتياطي المحجوز: ${totalReservedBalance} ر.ي`,
      },
    });

    return {
      profile,
      riskTier,
      riskScore: compositeScore,
      reservePercentage,
      totalReservedBalance,
      totalUnsecuredExposure,
      shouldPauseOrders,
      shouldRestrictWithdrawals,
    };
  }

  /**
   * Atomic evaluation and application of financial restrictions on a seller.
   */
  public static async evaluateAndApplyRestrictions(
    tx: any,
    sellerId: string
  ): Promise<{
    isRestricted: boolean;
    newOrdersPaused: boolean;
    withdrawalsRestricted: boolean;
    restrictionLevel: string;
    totalRemainingDebt: number;
  }> {
    const thresholds = await this.getRiskThresholds();

    // Fetch active outstandings
    const activeOutstandings = await tx.sellerOutstanding.findMany({
      where: { sellerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      select: { remainingAmount: true },
    });
    const totalRemaining = activeOutstandings.reduce(
      (sum: number, o: { remainingAmount: number }) => sum + o.remainingAmount,
      0
    );

    // Recalculate risk profile
    const riskData = await this.calculateSellerRiskProfile(sellerId, tx);

    let isRestricted = false;
    let restrictionLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'RESTRICTED' = 'NORMAL';

    if (
      (totalRemaining >= thresholds.blockThreshold || riskData.totalUnsecuredExposure >= thresholds.maxExposureLimit) &&
      thresholds.blockingEnabled
    ) {
      isRestricted = true;
      restrictionLevel = 'RESTRICTED';

      await tx.seller.update({
        where: { id: sellerId },
        data: {
          isFinanciallyRestricted: true,
          financialRestrictionLevel: 'RESTRICTED',
          financialRestrictionReason: `تجاوز الحد الأقصى للمديونية (${totalRemaining} / ${thresholds.blockThreshold} ر.ي)`,
          financialRestrictedAt: new Date(),
        },
      });

      // Record structured FinancialRestrictions
      await tx.financialRestriction.upsert({
        where: { id: `RES-ORD-${sellerId}` },
        create: {
          id: `RES-ORD-${sellerId}`,
          sellerId,
          restrictionType: 'NEW_ORDERS_PAUSED',
          reasonCode: 'OUTSTANDING_REFUND_DEBT',
          status: 'ACTIVE',
          metadata: JSON.stringify({ totalRemaining, blockThreshold: thresholds.blockThreshold }),
        },
        update: {
          status: 'ACTIVE',
          releasedAt: null,
          metadata: JSON.stringify({ totalRemaining, blockThreshold: thresholds.blockThreshold }),
        },
      });

      await tx.financialRestriction.upsert({
        where: { id: `RES-WTH-${sellerId}` },
        create: {
          id: `RES-WTH-${sellerId}`,
          sellerId,
          restrictionType: 'WITHDRAWAL_PAUSED',
          reasonCode: 'OUTSTANDING_REFUND_DEBT',
          status: 'ACTIVE',
          metadata: JSON.stringify({ totalRemaining, blockThreshold: thresholds.blockThreshold }),
        },
        update: {
          status: 'ACTIVE',
          releasedAt: null,
          metadata: JSON.stringify({ totalRemaining, blockThreshold: thresholds.blockThreshold }),
        },
      });
    } else if (totalRemaining <= thresholds.unblockThreshold && thresholds.autoUnblockEnabled) {
      // Auto-unblock if below unblock threshold and no other restriction applies
      await tx.seller.update({
        where: { id: sellerId },
        data: {
          isFinanciallyRestricted: false,
          financialRestrictionLevel: totalRemaining >= thresholds.warningThreshold ? 'WARNING' : 'NORMAL',
          financialRestrictionReason: null,
          financialRestrictedAt: null,
        },
      });

      await tx.financialRestriction.updateMany({
        where: { sellerId, status: 'ACTIVE' },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releaseReason: `سداد المديونية تلقائياً إلى ما دون حد فك التقييد (${totalRemaining} <= ${thresholds.unblockThreshold} ر.ي)`,
        },
      });

      await tx.sellerRiskProfile.updateMany({
        where: { sellerId },
        data: {
          newOrdersPaused: false,
          withdrawalsRestricted: false,
        },
      });
    } else if (totalRemaining >= thresholds.criticalThreshold) {
      restrictionLevel = 'CRITICAL';
      await tx.seller.update({
        where: { id: sellerId },
        data: { financialRestrictionLevel: 'CRITICAL' },
      });
    } else if (totalRemaining >= thresholds.warningThreshold && thresholds.warningEnabled) {
      restrictionLevel = 'WARNING';
      await tx.seller.update({
        where: { id: sellerId },
        data: { financialRestrictionLevel: 'WARNING' },
      });
    }

    return {
      isRestricted,
      newOrdersPaused: riskData.shouldPauseOrders || isRestricted,
      withdrawalsRestricted: riskData.shouldRestrictWithdrawals || isRestricted,
      restrictionLevel,
      totalRemainingDebt: totalRemaining,
    };
  }

  /**
   * Computes authoritative financial standing, reserve breakdown, and restrictions for a seller.
   */
  public static async getSellerFinancialStanding(sellerId: string): Promise<SellerFinancialStanding> {
    const seller: any = await prisma.seller.findUnique({
      where: { id: sellerId },
      include: {
        stores: { select: { id: true, name: true, logo: true } },
        user: { select: { firstName: true, lastName: true, phone: true, email: true } },
        balance: true,
        riskProfile: true,
        financialRestrictions: {
          where: { status: 'ACTIVE' },
          orderBy: { triggeredAt: 'desc' },
        },
        reserveAllocations: {
          orderBy: { createdAt: 'desc' },
        },
        debtRecoveryAllocations: {
          orderBy: { createdAt: 'desc' },
          take: 15,
        },
        outstandings: {
          orderBy: { createdAt: 'desc' },
        },
        sellerOrders: {
          select: {
            id: true,
            subtotal: true,
            commissionAmount: true,
            sellerPayout: true,
            status: true,
            order: {
              select: {
                orderNumber: true,
                createdAt: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        refundRequests: {
          select: { id: true, requestedAmount: true, status: true },
        },
      },
    });

    if (!seller) {
      throw new AppError('حساب البائع غير موجود', 404);
    }

    const thresholds = await this.getRiskThresholds();

    // Calculate sum of active outstanding liabilities
    const openOutstandings = seller.outstandings.filter(
      (o: any) => o.status === 'OPEN' || o.status === 'PARTIALLY_PAID'
    );
    const authoritativeOutstanding = openOutstandings.reduce(
      (sum: number, item: any) => sum + item.remainingAmount,
      0
    );

    // Sync SellerBalance if any drift exists
    if (seller.balance && Math.abs(seller.balance.outstandingCommission - authoritativeOutstanding) > 0.01) {
      await prisma.sellerBalance.update({
        where: { id: seller.balance.id },
        data: { outstandingCommission: authoritativeOutstanding },
      });
      seller.balance.outstandingCommission = authoritativeOutstanding;
    }

    const availableBal = seller.balance?.availableBalance ?? 0;
    const pendingBal = seller.balance?.pendingBalance ?? 0;
    const withdrawnBal = seller.balance?.withdrawnBalance ?? 0;
    const currency = seller.balance?.currency || 'YER';

    // Calculate total reserved balance from active allocations
    const activeReserves = (seller.reserveAllocations || []).filter((r: any) => r.status === 'RESERVED');
    const totalReservedBalance = activeReserves.reduce((sum: number, r: any) => sum + (r.amount || 0), 0);

    // Withdrawable balance is available balance minus locked reserves
    const withdrawableBalance = Math.max(0, availableBal - totalReservedBalance);

    // Unsecured exposure calculation
    const pendingRefunds = (seller.refundRequests || []).filter(
      (r: any) => r.status === 'SUBMITTED' || r.status === 'UNDER_SELLER_REVIEW' || r.status === 'ADMIN_REVIEW'
    );
    const pendingExposure = pendingRefunds.reduce((sum: number, r: any) => sum + (r.requestedAmount || 0), 0);
    const unsecuredExposure = Math.max(0, authoritativeOutstanding + pendingExposure - totalReservedBalance);

    // Authoritative calculate amount needed to unblock
    const amountNeededToUnblock = Math.max(0, authoritativeOutstanding - thresholds.unblockThreshold);

    let calculatedLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'RESTRICTED' = 'NORMAL';
    if (seller.isFinanciallyRestricted || authoritativeOutstanding >= thresholds.blockThreshold) {
      calculatedLevel = 'RESTRICTED';
    } else if (authoritativeOutstanding >= thresholds.criticalThreshold) {
      calculatedLevel = 'CRITICAL';
    } else if (authoritativeOutstanding >= thresholds.warningThreshold) {
      calculatedLevel = 'WARNING';
    }

    const totalSales = seller.sellerOrders.reduce((sum: number, so: any) => sum + (so.subtotal || 0), 0);
    const totalCommission = seller.sellerOrders.reduce((sum: number, so: any) => sum + (so.commissionAmount || 0), 0);
    const totalPayout = seller.sellerOrders.reduce((sum: number, so: any) => sum + (so.sellerPayout || 0), 0);
    const storeName = seller.stores[0]?.name || (seller.user ? `${seller.user.firstName || ''} ${seller.user.lastName || ''}`.trim() : '') || 'متجر سوقنا';
    const ownerName = `${seller.user?.firstName || ''} ${seller.user?.lastName || ''}`.trim();

    const riskTier = (seller.riskProfile?.riskTier as any) || (calculatedLevel === 'RESTRICTED' ? 'CRITICAL' : calculatedLevel);
    const riskScore = seller.riskProfile?.riskScore ?? 0;
    const reservePercentage = seller.riskProfile?.reservePercentage ?? thresholds.baseReservePercentage;
    const reserveHoldingDays = seller.riskProfile?.reserveHoldingDays ?? thresholds.reserveHoldingDays;
    const newOrdersPaused = seller.riskProfile?.newOrdersPaused ?? seller.isFinanciallyRestricted;
    const withdrawalsRestricted = seller.riskProfile?.withdrawalsRestricted ?? seller.isFinanciallyRestricted;

    return {
      sellerId: seller.id,
      storeName,
      storeLogo: seller.stores[0]?.logo || null,
      ownerName,
      phone: seller.user?.phone || 'غير مسجل',
      email: seller.user?.email || null,
      commissionRate: seller.commissionRate !== null && seller.commissionRate !== undefined ? seller.commissionRate : 0.10,
      totalSales,
      totalCommission,
      totalPayout,
      ordersCount: seller.sellerOrders.length,
      availableBalance: availableBal,
      withdrawableBalance,
      pendingBalance: pendingBal,
      withdrawnBalance: withdrawnBal,
      outstandingCommission: authoritativeOutstanding,
      totalReservedBalance,
      unsecuredExposure,
      currency,
      isFinanciallyRestricted: seller.isFinanciallyRestricted,
      financialRestrictionLevel: calculatedLevel,
      financialRestrictionReason: seller.financialRestrictionReason,
      financialRestrictedAt: seller.financialRestrictedAt,
      cashOnDeliveryEnabled: seller.cashOnDeliveryEnabled,
      newOrdersPaused,
      withdrawalsRestricted,
      riskTier,
      riskScore,
      reservePercentage,
      reserveHoldingDays,
      thresholds,
      amountNeededToUnblock,
      openOutstandingsCount: openOutstandings.length,
      activeRestrictions: (seller.financialRestrictions || []).map((r: any) => ({
        id: r.id,
        restrictionType: r.restrictionType,
        reasonCode: r.reasonCode,
        status: r.status,
        triggeredAt: r.triggeredAt,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      })),
      reserveAllocations: (seller.reserveAllocations || []).map((ra: any) => ({
        id: ra.id,
        amount: ra.amount,
        currency: ra.currency,
        reservePercentage: ra.reservePercentage,
        riskTier: ra.riskTier,
        holdingDays: ra.holdingDays,
        releaseEligibleAt: ra.releaseEligibleAt,
        status: ra.status,
        reason: ra.reason,
      })),
      debtRecoveryAllocations: (seller.debtRecoveryAllocations || []).map((dra: any) => ({
        id: dra.id,
        amount: dra.amount,
        currency: dra.currency,
        recoveredFrom: dra.recoveredFrom,
        createdAt: dra.createdAt,
        notes: dra.notes,
      })),
      openOutstandings: openOutstandings.map((o: any) => ({
        id: o.id,
        sourceType: o.sourceType,
        sourceReference: o.sourceReference,
        amount: o.amount,
        paidAmount: o.paidAmount,
        remainingAmount: o.remainingAmount,
        currency: o.currency,
        status: o.status,
        warningLevel: o.warningLevel,
        createdAt: o.createdAt,
      })),
      allOutstandings: seller.outstandings.map((o: any) => ({
        id: o.id,
        sourceType: o.sourceType,
        sourceReference: o.sourceReference,
        amount: o.amount,
        paidAmount: o.paidAmount,
        remainingAmount: o.remainingAmount,
        currency: o.currency,
        status: o.status,
        warningLevel: o.warningLevel,
        createdAt: o.createdAt,
      })),
      recentOrders: seller.sellerOrders.slice(0, 15).map((so: any) => ({
        id: so.id,
        orderNumber: so.order?.orderNumber || '—',
        subtotal: so.subtotal || 0,
        commissionAmount: so.commissionAmount || 0,
        sellerPayout: so.sellerPayout || 0,
        paymentMethod: so.order?.paymentMethod || 'COD',
        status: so.status,
        createdAt: so.order?.createdAt,
      })),
    };
  }

  /**
   * Evaluates COD eligibility across a list of seller IDs for checkout.
   */
  public static async evaluateCodEligibility(params: {
    sellerIds: string[];
    customerId?: string;
    governorate?: string;
  }): Promise<{
    isCodAvailable: boolean;
    reason?: string;
    sellerStatus: Record<string, { enabled: boolean; restricted: boolean }>;
  }> {
    const isPlatformCodActive = await remoteConfigService.isFeatureActive('cash_on_delivery');
    if (!isPlatformCodActive) {
      return {
        isCodAvailable: false,
        reason: 'خدمة الدفع عند الاستلام معطلة مؤقتاً على مستوى المنصة',
        sellerStatus: {},
      };
    }

    if (!params.sellerIds || params.sellerIds.length === 0) {
      return { isCodAvailable: false, reason: 'لا توجد متاجر في سلة الشراء', sellerStatus: {} };
    }

    const sellers = await prisma.seller.findMany({
      where: { id: { in: params.sellerIds } },
      select: {
        id: true,
        status: true,
        cashOnDeliveryEnabled: true,
        isFinanciallyRestricted: true,
        financialRestrictionReason: true,
      },
    });

    const sellerStatus: Record<string, { enabled: boolean; restricted: boolean }> = {};
    let allEligible = true;
    let failureReason: string | undefined;

    for (const s of sellers) {
      sellerStatus[s.id] = {
        enabled: s.cashOnDeliveryEnabled,
        restricted: s.isFinanciallyRestricted,
      };

      if (s.status !== 'ACTIVE') {
        allEligible = false;
        failureReason = 'أحد المتاجر غير مفعّل حالياً في المنصة';
        break;
      }

      if (!s.cashOnDeliveryEnabled) {
        allEligible = false;
        failureReason = 'أحد المتاجر لا يوفر خيار الدفع عند الاستلام (COD)';
        break;
      }

      if (s.isFinanciallyRestricted) {
        allEligible = false;
        failureReason = 'خدمة الدفع عند الاستلام غير متاحة لأحد المتاجر بسبب قيود مالية معلقة';
        break;
      }
    }

    if (sellers.length < params.sellerIds.length) {
      allEligible = false;
      failureReason = 'أحد المتاجر المطلوبة غير موجود';
    }

    return {
      isCodAvailable: allEligible,
      reason: failureReason,
      sellerStatus,
    };
  }

  /**
   * Transactional commission collection on Order Delivery.
   */
  public static async processDeliveredOrderCommission(
    tx: any,
    params: {
      sellerOrderId: string;
      orderNumber: string;
      sellerId: string;
      commissionAmount: number;
      isCod: boolean;
    }
  ): Promise<{
    collectedAmount: number;
    outstandingAmount: number;
    sellerBalance: any;
    isRestricted: boolean;
  }> {
    const { sellerOrderId, orderNumber, sellerId, commissionAmount, isCod } = params;

    // Idempotency guard: Verify commission record doesn't already exist
    const existingCommission = await tx.commission.findUnique({
      where: { sellerOrderId },
    });

    if (existingCommission) {
      const bal = await tx.sellerBalance.findUnique({ where: { sellerId } });
      const seller = await tx.seller.findUnique({ where: { id: sellerId } });
      return {
        collectedAmount: existingCommission.amount,
        outstandingAmount: 0,
        sellerBalance: bal,
        isRestricted: seller?.isFinanciallyRestricted || false,
      };
    }

    await tx.commission.create({
      data: {
        sellerOrderId,
        rate: 0.10,
        amount: commissionAmount,
      },
    });

    if (commissionAmount <= 0) {
      const bal = await tx.sellerBalance.findUnique({ where: { sellerId } });
      return {
        collectedAmount: 0,
        outstandingAmount: 0,
        sellerBalance: bal,
        isRestricted: false,
      };
    }

    let balance = await tx.sellerBalance.findUnique({
      where: { sellerId },
    });

    if (!balance) {
      balance = await tx.sellerBalance.create({
        data: {
          sellerId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          outstandingCommission: 0,
          currency: 'YER',
        },
      });
    }

    let collectedAmount = 0;
    let outstandingAmount = 0;

    if (!isCod) {
      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: -commissionAmount,
          type: 'COMMISSION',
          referenceId: sellerOrderId,
          description: `خصم عمولة المنصة للطلب المدفوع إلكترونياً #${orderNumber}`,
        },
      });
      return {
        collectedAmount: commissionAmount,
        outstandingAmount: 0,
        sellerBalance: balance,
        isRestricted: false,
      };
    }

    // CASH ON DELIVERY (COD)
    if (balance.availableBalance >= commissionAmount) {
      collectedAmount = commissionAmount;
      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: { availableBalance: { decrement: commissionAmount } },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: -commissionAmount,
          type: 'COMMISSION',
          referenceId: sellerOrderId,
          description: `خصم عمولة منصة سوقناا لطلب الدفع عند الاستلام #${orderNumber}`,
        },
      });
    } else {
      const availablePortion = Math.max(0, balance.availableBalance);
      collectedAmount = availablePortion;
      outstandingAmount = commissionAmount - availablePortion;

      if (availablePortion > 0) {
        await tx.sellerBalance.update({
          where: { id: balance.id },
          data: { availableBalance: 0 },
        });

        await tx.sellerTransaction.create({
          data: {
            sellerBalanceId: balance.id,
            amount: -availablePortion,
            type: 'COMMISSION',
            referenceId: sellerOrderId,
            description: `خصم جزء متاح من عمولة المنصة لطلب الدفع عند الاستلام #${orderNumber}`,
          },
        });
      }

      await tx.sellerOutstanding.create({
        data: {
          sellerId,
          sourceType: 'ORDER_COMMISSION',
          sourceReference: sellerOrderId,
          amount: outstandingAmount,
          paidAmount: 0,
          remainingAmount: outstandingAmount,
          currency: 'YER',
          status: 'OPEN',
          warningLevel: 'NORMAL',
          metadata: JSON.stringify({
            orderNumber,
            totalCommission: commissionAmount,
            collectedPortion: availablePortion,
            createdAt: new Date().toISOString(),
          }),
        },
      });

      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: { outstandingCommission: { increment: outstandingAmount } },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: 0,
          type: 'DEBIT',
          referenceId: sellerOrderId,
          description: `تسجيل مديونية عمولة منصة لطلب الدفع عند الاستلام #${orderNumber} (${outstandingAmount} ر.ي مستحقة)`,
        },
      });
    }

    // Re-evaluate restrictions
    const restrictionResult = await this.evaluateAndApplyRestrictions(tx, sellerId);

    // Broadcast real-time events to seller
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { userId: true } });
    if (seller?.userId) {
      SocketService.get()?.emitToUser(seller.userId, 'seller:finance_updated', {
        outstandingCommission: restrictionResult.totalRemainingDebt,
        financialRestrictionLevel: restrictionResult.restrictionLevel,
        isFinanciallyRestricted: restrictionResult.isRestricted,
        newOrdersPaused: restrictionResult.newOrdersPaused,
      });

      if (restrictionResult.isRestricted) {
        const thresholds = await this.getRiskThresholds();
        SocketService.get()?.emitToUser(seller.userId, 'seller:account_restricted', {
          reason: `تجاوز الحد الأقصى للمديونية (${restrictionResult.totalRemainingDebt} ر.ي)`,
          outstanding: restrictionResult.totalRemainingDebt,
          blockThreshold: thresholds.blockThreshold,
          unblockThreshold: thresholds.unblockThreshold,
          amountNeededToUnblock: Math.max(0, restrictionResult.totalRemainingDebt - thresholds.unblockThreshold),
        });
      }
    }

    return {
      collectedAmount,
      outstandingAmount,
      sellerBalance: balance,
      isRestricted: restrictionResult.isRestricted,
    };
  }

  /**
   * Atomic, Idempotent Admin Deposit Approval Flow.
   * Applies approved funds to FIFO outstanding liabilities, records DebtRecoveryAllocation,
   * updates ledger, credits surplus, and automatically evaluates unblocking condition.
   */
  public static async approveSellerDeposit(
    tx: any,
    params: {
      depositId: string;
      adminUserId: string;
      approvedAmount?: number;
      adminNote?: string;
    }
  ): Promise<{
    deposit: any;
    outstandingBefore: number;
    outstandingAfter: number;
    isAutoUnblocked: boolean;
    surplusCredited: number;
  }> {
    const { depositId, adminUserId, approvedAmount, adminNote } = params;

    const deposit = await tx.walletDeposit.findUnique({
      where: { id: depositId },
      include: { seller: true, user: true },
    });

    if (!deposit) {
      throw new AppError('طلب الإيداع غير موجود', 404);
    }

    if (deposit.status !== 'PENDING') {
      throw new AppError('تم البت في طلب الإيداع هذا مسبقاً ولا يمكن تكرار اعتماده', 400);
    }

    if (deposit.userType !== 'SELLER' || !deposit.sellerId) {
      throw new AppError('هذا الإيداع لا يتبع حساب بائع', 400);
    }

    const sellerId = deposit.sellerId;
    const effectiveApprovedAmount =
      approvedAmount !== undefined && approvedAmount > 0 ? approvedAmount : deposit.amount;

    if (effectiveApprovedAmount > deposit.amount) {
      throw new AppError('المبلغ المعتمد لا يمكن أن يتجاوز مبلغ الحوالة المقدم', 400);
    }

    let balance = await tx.sellerBalance.findUnique({
      where: { sellerId },
    });

    if (!balance) {
      balance = await tx.sellerBalance.create({
        data: {
          sellerId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          outstandingCommission: 0,
          currency: 'YER',
        },
      });
    }

    // Fetch all open outstandings sorted FIFO (oldest first)
    const openOutstandings = await tx.sellerOutstanding.findMany({
      where: { sellerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      orderBy: { createdAt: 'asc' },
    });

    const outstandingBefore = openOutstandings.reduce(
      (sum: number, o: { remainingAmount: number }) => sum + o.remainingAmount,
      0
    );

    let unallocatedAmount = effectiveApprovedAmount;
    let totalDebtPaid = 0;

    for (const out of openOutstandings) {
      if (unallocatedAmount <= 0) break;

      const toPay = Math.min(unallocatedAmount, out.remainingAmount);
      const newPaid = out.paidAmount + toPay;
      const newRemaining = out.remainingAmount - toPay;
      const newStatus = newRemaining <= 0.001 ? 'PAID' : 'PARTIALLY_PAID';

      await tx.sellerOutstanding.update({
        where: { id: out.id },
        data: {
          paidAmount: newPaid,
          remainingAmount: Math.max(0, newRemaining),
          status: newStatus,
          warningLevel: 'NORMAL',
        },
      });

      // Record authoritative DebtRecoveryAllocation
      await tx.debtRecoveryAllocation.create({
        data: {
          sellerId,
          depositId: deposit.id,
          outstandingId: out.id,
          amount: toPay,
          currency: deposit.currency,
          recoveredFrom: 'DEPOSIT',
          transactionRef: deposit.transferReference,
          notes: `سداد مديونية عبر إيداع محفظة (${deposit.walletProvider} - مرجع: ${deposit.transferReference})`,
        },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: toPay,
          type: 'OUTSTANDING_PAYMENT',
          referenceId: deposit.id,
          description: `سداد مديونية عمولة منصة عبر إيداع محفظة (${deposit.walletProvider} - مرجع: ${deposit.transferReference})`,
        },
      });

      totalDebtPaid += toPay;
      unallocatedAmount -= toPay;
    }

    let surplusCredited = 0;
    if (unallocatedAmount > 0) {
      surplusCredited = unallocatedAmount;
      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: {
          availableBalance: { increment: surplusCredited },
          outstandingCommission: { decrement: totalDebtPaid },
        },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: surplusCredited,
          type: 'CREDIT',
          referenceId: deposit.id,
          description: `شحن رصيد إضافي بعد سداد المديونية عبر ${deposit.walletProvider} - مرجع: ${deposit.transferReference}`,
        },
      });
    } else {
      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: {
          outstandingCommission: { decrement: totalDebtPaid },
        },
      });
    }

    const outstandingAfter = Math.max(0, outstandingBefore - totalDebtPaid);
    const isPartial = effectiveApprovedAmount < deposit.amount;

    const updatedDeposit = await tx.walletDeposit.update({
      where: { id: deposit.id },
      data: {
        status: isPartial ? 'PARTIALLY_APPROVED' : 'APPROVED',
        approvedAmount: effectiveApprovedAmount,
        outstandingBefore,
        outstandingAfter,
        reviewedByAdminId: adminUserId,
        reviewedAt: new Date(),
        completedAt: new Date(),
        adminNote: adminNote || `تم اعتماد وتأكيد الإيداع بمبلغ ${effectiveApprovedAmount} ر.ي`,
      },
    });

    // Re-evaluate restrictions
    const restrictionResult = await this.evaluateAndApplyRestrictions(tx, sellerId);
    const isAutoUnblocked = !restrictionResult.isRestricted && deposit.seller?.isFinanciallyRestricted;

    // Publish notification
    try {
      notificationEventBus.publish(
        NotificationEventFactory.walletEvent({
          eventType: 'WALLET_TOPUP_APPROVED',
          recipientId: deposit.userId,
          amount: effectiveApprovedAmount,
          currency: 'YER',
          referenceId: deposit.id,
        })
      );
    } catch (_) {}

    return {
      deposit: updatedDeposit,
      outstandingBefore,
      outstandingAfter,
      isAutoUnblocked,
      surplusCredited,
    };
  }

  /**
   * Manual Admin Unblock Action (Privileged RBAC operation).
   */
  public static async manualAdminUnblock(
    adminUserId: string,
    sellerId: string,
    reason: string
  ): Promise<any> {
    if (!reason || !reason.trim()) {
      throw new AppError('سبب رفع التقييد المالي مطلوب إجبارياً', 400);
    }

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      include: { balance: true },
    });

    if (!seller) {
      throw new AppError('حساب البائع غير موجود', 404);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.seller.update({
        where: { id: sellerId },
        data: {
          isFinanciallyRestricted: false,
          financialRestrictionReason: `رفع استثنائي من الإدارة: ${reason.trim()}`,
        },
      });

      await tx.financialRestriction.updateMany({
        where: { sellerId, status: 'ACTIVE' },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releasedByAdminId: adminUserId,
          releaseReason: `رفع استثنائي من الإدارة: ${reason.trim()}`,
        },
      });

      await tx.sellerRiskProfile.updateMany({
        where: { sellerId },
        data: {
          newOrdersPaused: false,
          withdrawalsRestricted: false,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'SELLER_FINANCIAL_UNBLOCK_MANUAL',
          resource: 'sellers',
          details: JSON.stringify({
            sellerId,
            adminUserId,
            reason: reason.trim(),
            outstandingCommission: seller.balance?.outstandingCommission || 0,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return s;
    });

    SocketService.get()?.emitToUser(seller.userId, 'seller:account_unblocked', {
      reason,
      unblockedBy: 'ADMIN',
    });

    return updated;
  }

  /**
   * Validates whether a seller can safely close or delete an account.
   * Prevents financial liability evasion and preserves records.
   */
  public static async checkAccountClosureEligibility(sellerId: string): Promise<{
    eligible: boolean;
    reasons: string[];
    outstandingDebt: number;
    reservedBalance: number;
    openRefundsCount: number;
    openDisputesCount: number;
    inFlightOrdersCount: number;
  }> {
    const standing = await this.getSellerFinancialStanding(sellerId);

    const [openRefunds, openDisputes, inFlightOrders] = await Promise.all([
      prisma.refundRequest.count({
        where: {
          sellerId,
          status: { in: ['SUBMITTED', 'UNDER_SELLER_REVIEW', 'ADMIN_REVIEW', 'REFUND_PROCESSING'] },
        },
      }),
      prisma.dispute.count({
        where: {
          sellerId,
          status: { in: ['OPEN', 'UNDER_REVIEW'] },
        },
      }),
      prisma.sellerOrder.count({
        where: {
          sellerId,
          status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED'] },
        },
      }),
    ]);

    const reasons: string[] = [];

    if (standing.outstandingCommission > 0.01) {
      reasons.push(`يوجد مديونية مستحقة معلقة بقيمة ${standing.outstandingCommission} ${standing.currency} يجب سدادها أولاً`);
    }

    if (standing.totalReservedBalance > 0.01) {
      reasons.push(`يوجد رصيد احتياطي مالي محجوز بقيمة ${standing.totalReservedBalance} ${standing.currency} قيد فترة الضمان القانونية`);
    }

    if (openRefunds > 0) {
      reasons.push(`يوجد ${openRefunds} طلبات استرجاع معلقة لم يتم الفصل فيها`);
    }

    if (openDisputes > 0) {
      reasons.push(`يوجد ${openDisputes} نزاعات مالية مفتوحة تتطلب حلاً`);
    }

    if (inFlightOrders > 0) {
      reasons.push(`يوجد ${inFlightOrders} طلبات جارية قيد التجهيز أو الشحن يجب تسليمها أولاً`);
    }

    return {
      eligible: reasons.length === 0,
      reasons,
      outstandingDebt: standing.outstandingCommission,
      reservedBalance: standing.totalReservedBalance,
      openRefundsCount: openRefunds,
      openDisputesCount: openDisputes,
      inFlightOrdersCount: inFlightOrders,
    };
  }

  /**
   * Aggregate KPI dashboard for finance administrators.
   */
  public static async getRiskDashboardKpis(): Promise<{
    totalDebt: number;
    totalReserves: number;
    totalUnsecuredExposure: number;
    restrictedSellersCount: number;
    pausedOrdersCount: number;
    restrictedWithdrawalsCount: number;
    openExceptionsCount: number;
  }> {
    const [
      balancesSum,
      reservesSum,
      restrictedCount,
      riskProfiles,
      openExceptions,
    ] = await Promise.all([
      prisma.sellerBalance.aggregate({
        _sum: { outstandingCommission: true },
      }),
      prisma.sellerReserveAllocation.aggregate({
        where: { status: 'RESERVED' },
        _sum: { amount: true },
      }),
      prisma.seller.count({
        where: { isFinanciallyRestricted: true },
      }),
      prisma.sellerRiskProfile.findMany({
        select: {
          newOrdersPaused: true,
          withdrawalsRestricted: true,
          totalUnsecuredExposure: true,
        },
      }),
      prisma.reconciliationException.count({
        where: { status: 'OPEN' },
      }),
    ]);

    const totalDebt = balancesSum._sum.outstandingCommission || 0;
    const totalReserves = reservesSum._sum.amount || 0;
    const totalUnsecuredExposure = riskProfiles.reduce(
      (sum, p) => sum + (p.totalUnsecuredExposure || 0),
      0
    );
    const pausedOrdersCount = riskProfiles.filter((p) => p.newOrdersPaused).length;
    const restrictedWithdrawalsCount = riskProfiles.filter((p) => p.withdrawalsRestricted).length;

    return {
      totalDebt,
      totalReserves,
      totalUnsecuredExposure,
      restrictedSellersCount: restrictedCount,
      pausedOrdersCount,
      restrictedWithdrawalsCount,
      openExceptionsCount: openExceptions,
    };
  }
}
