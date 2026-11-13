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
import { SellerCodSettlementService } from './seller-cod-settlement.service';

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
  totalCodObligations?: number;
  totalCodWalletDeductions?: number;
  totalCodVerifiedPayments?: number;
  totalCodOutstanding?: number;
  codObligations?: Array<{
    id: string;
    obligationNumber: string;
    orderNumber: string;
    obligationAmount: number;
    walletDeduction: number;
    remainingObligation: number;
    verifiedPaymentAmount: number;
    outstandingAmount: number;
    currency: string;
    status: string;
    paymentMethod?: string | null;
    paymentReference?: string | null;
    proofImageUrl?: string | null;
    createdAt: Date;
    settledAt?: Date | null;
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
   * Evaluates debt threshold according to configured risk boundaries.
   */
  public static evaluateDebtThreshold(
    debt: number,
    thresholds: FinancialRiskThresholds = this.DEFAULT_THRESHOLDS
  ): 'NORMAL' | 'WARNING' | 'RESTRICTED' | 'CRITICAL' {
    if (debt >= thresholds.blockThreshold) return 'CRITICAL';
    if (debt >= thresholds.criticalThreshold) return 'RESTRICTED';
    if (debt >= thresholds.warningThreshold) return 'WARNING';
    return 'NORMAL';
  }

  /**
   * Applies hysteresis to prevent status oscillation around threshold boundaries.
   */
  public static evaluateHysteresis(
    currentStatus: 'RESTRICTED' | 'NORMAL' | 'WARNING' | 'CRITICAL',
    debt: number,
    thresholds: FinancialRiskThresholds = this.DEFAULT_THRESHOLDS
  ): 'RESTRICTED' | 'NORMAL' | 'WARNING' | 'CRITICAL' {
    if (currentStatus === 'RESTRICTED') {
      // Must fall strictly below unblockThreshold to leave RESTRICTED state
      if (debt < thresholds.unblockThreshold) {
        return this.evaluateDebtThreshold(debt, thresholds);
      }
      return 'RESTRICTED';
    }
    return this.evaluateDebtThreshold(debt, thresholds);
  }

  /**
   * Synchronous check on account closure invariants (zero debt, zero active disputes, zero in-flight orders).
   */
  public static canCloseAccount(params: {
    confirmedDebt: number;
    activeDisputesCount: number;
    pendingOrdersCount: number;
  }): { allowed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (params.confirmedDebt > 0) {
      reasons.push(`لا يمكن إغلاق الحساب لوجود مديونيات أو مستحقات مالية قائمة بمبلغ ${params.confirmedDebt} ر.ي`);
    }
    if (params.activeDisputesCount > 0) {
      reasons.push(`يوجد ${params.activeDisputesCount} نزاع أو استرجاع قيد التحقيق والمراجعة`);
    }
    if (params.pendingOrdersCount > 0) {
      reasons.push(`يوجد ${params.pendingOrdersCount} طلب نشط قيد التنفيذ`);
    }
    return {
      allowed: reasons.length === 0,
      reasons,
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
        codObligations: {
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

    // Withdrawable balance is available balance (which is already net of withheld reserve allocations)
    const withdrawableBalance = Math.max(0, availableBal);

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
      totalCodObligations: (seller.codObligations || []).reduce(
        (sum: number, o: any) => sum + (o.status !== 'REVERSED' ? o.obligationAmount : 0),
        0
      ),
      totalCodWalletDeductions: (seller.codObligations || []).reduce(
        (sum: number, o: any) => sum + (o.status !== 'REVERSED' ? o.walletDeduction : 0),
        0
      ),
      totalCodVerifiedPayments: (seller.codObligations || []).reduce(
        (sum: number, o: any) => sum + (o.status !== 'REVERSED' ? o.verifiedPaymentAmount : 0),
        0
      ),
      totalCodOutstanding: (seller.codObligations || []).reduce(
        (sum: number, o: any) => sum + (o.status !== 'REVERSED' ? o.outstandingAmount : 0),
        0
      ),
      codObligations: (seller.codObligations || []).map((o: any) => ({
        id: o.id,
        obligationNumber: o.obligationNumber,
        orderNumber: o.orderNumber,
        obligationAmount: o.obligationAmount,
        walletDeduction: o.walletDeduction,
        remainingObligation: o.remainingObligation,
        verifiedPaymentAmount: o.verifiedPaymentAmount,
        outstandingAmount: o.outstandingAmount,
        currency: o.currency,
        status: o.status,
        paymentMethod: o.paymentMethod,
        paymentReference: o.paymentReference,
        proofImageUrl: o.proofImageUrl,
        createdAt: o.createdAt,
        settledAt: o.settledAt,
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

    // Customer COD Policy: COD is available only after completing at least 3 orders (DELIVERED status)
    if (params.customerId) {
      const completedOrdersCount = await prisma.order.count({
        where: {
          userId: params.customerId,
          status: 'DELIVERED',
        },
      });

      const MIN_COMPLETED_ORDERS_FOR_COD = 3;
      if (completedOrdersCount < MIN_COMPLETED_ORDERS_FOR_COD) {
        const remaining = MIN_COMPLETED_ORDERS_FOR_COD - completedOrdersCount;
        return {
          isCodAvailable: false,
          reason: `خدمة الدفع عند الاستلام (COD) متاحة للعميل بعد إكمال 3 طلبات ناجحة سابقة. (أكملت ${completedOrdersCount} من ${MIN_COMPLETED_ORDERS_FOR_COD}، متبقي ${remaining}). يرجى اختيار وسيلة دفع بديلة لإتمام طلبك.`,
          sellerStatus: {},
        };
      }
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
        failureReason = 'خدمة الدفع عند الاستلام غير متاحة حالياً لأحد المتاجر. يرجى اختيار وسيلة دفع بديلة.';
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

    // CASH ON DELIVERY (COD) — Authoritative COD Wallet Deduction Engine
    const codResult = await SellerCodSettlementService.processCodOrderObligation(tx, {
      sellerOrderId,
      orderNumber,
      sellerId,
      obligationAmount: commissionAmount,
      isCod: true,
      currency: balance.currency,
    });

    return {
      collectedAmount: codResult.walletDeduction,
      outstandingAmount: codResult.remainingObligation,
      sellerBalance: codResult.sellerBalance,
      isRestricted: codResult.isRestricted,
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
    } catch (_) { }

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
    availableBalance: number;
    openRefundsCount: number;
    openDisputesCount: number;
    inFlightOrdersCount: number;
    pendingWithdrawalsCount: number;
    pendingSettlementsCount: number;
  }> {
    const standing = await this.getSellerFinancialStanding(sellerId);

    const [openRefunds, openDisputes, inFlightOrders, pendingWithdrawals, pendingSettlements, openCodObligations] = await Promise.all([
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
      prisma.withdrawal.count({
        where: {
          sellerId,
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      }),
      prisma.settlement.count({
        where: {
          sellerId,
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      }),
      prisma.codFinancialObligation.count({
        where: {
          sellerId,
          status: { in: ['PENDING_PAYMENT', 'PAYMENT_SUBMITTED', 'UNDER_REVIEW', 'PARTIALLY_SETTLED', 'PAYMENT_REJECTED'] },
        },
      }),
    ]);

    const reasons: string[] = [];

    if (openCodObligations > 0) {
      reasons.push(`يوجد ${openCodObligations} التزامات دفع عند الاستلام (COD) معلقة يجب تسويتها بالكامل قبل إغلاق الحساب`);
    }

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

    if (pendingWithdrawals > 0) {
      reasons.push(`يوجد ${pendingWithdrawals} طلبات سحب أرباح جارية قيد المعالجة`);
    }

    if (pendingSettlements > 0) {
      reasons.push(`يوجد ${pendingSettlements} تسويات دورية معلقة قيد الإجراء`);
    }

    if (standing.availableBalance > 0.01) {
      reasons.push(`يوجد رصيد متاح في المحفظة بقيمة ${standing.availableBalance} ${standing.currency} يتطلب التصفية والسحب النهائي قبل إغلاق الحساب`);
    }

    return {
      eligible: reasons.length === 0,
      reasons,
      outstandingDebt: standing.outstandingCommission,
      reservedBalance: standing.totalReservedBalance,
      availableBalance: standing.availableBalance,
      openRefundsCount: openRefunds,
      openDisputesCount: openDisputes,
      inFlightOrdersCount: inFlightOrders,
      pendingWithdrawalsCount: pendingWithdrawals,
      pendingSettlementsCount: pendingSettlements,
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

  /**
   * Authoritative Marketplace-Wide Financial Risk Exposure Monitoring (§Phase 9)
   * Tracks aggregate seller liabilities, unrecovered debt, marketplace-funded refunds,
   * active reservations, reserve coverage, daily/monthly limits, and concentration risk.
   */
  public static async getMarketplaceRiskExposure(): Promise<{
    totalSellerRefundLiabilities: number;
    totalUnrecoveredSellerDebt: number;
    totalMarketplaceFundedRefunds: number;
    totalRecoverableMarketplaceExposure: number;
    totalActiveRefundReservations: number;
    totalSellerReserveCoverage: number;
    totalRefundObligationsDue: number;
    dailyMarketplaceFundedAmount: number;
    monthlyMarketplaceFundedAmount: number;
    availableProtectionFundBalance: number;
    controls: {
      maxExposurePerSeller: number;
      maxAggregateOutstandingDebt: number;
      dailyMarketplaceFundedLimit: number;
      monthlyMarketplaceFundedLimit: number;
      isDailyLimitBreached: boolean;
      isMonthlyLimitBreached: boolean;
      isAggregateDebtBreached: boolean;
    };
    exposureAlerts: Array<{
      type: string;
      severity: string;
      message: string;
      details?: any;
    }>;
    topExposedSellers: Array<{
      sellerId: string;
      storeName: string;
      outstandingDebt: number;
      reservedBalance: number;
      riskTier: string;
      isRestricted: boolean;
    }>;
  }> {
    const thresholds = await this.getRiskThresholds();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      refundLiabilitiesAgg,
      allDebtAgg,
      reservesAgg,
      activeLocksCount,
      marketplaceTransactions,
      topSellers,
    ] = await Promise.all([
      // 1. Total outstanding seller refund liabilities
      prisma.sellerOutstanding.aggregate({
        where: {
          sourceType: 'REFUND_LIABILITY',
          status: { in: ['OPEN', 'PARTIALLY_PAID'] },
        },
        _sum: { remainingAmount: true },
        _count: { id: true },
      }),
      // 2. Total unrecovered seller debt (all sources)
      prisma.sellerOutstanding.aggregate({
        where: {
          status: { in: ['OPEN', 'PARTIALLY_PAID'] },
        },
        _sum: { remainingAmount: true },
      }),
      // 3. Total active seller reserves
      prisma.sellerReserveAllocation.aggregate({
        where: { status: 'RESERVED' },
        _sum: { amount: true },
      }),
      // 4. Active refund execution locks
      prisma.refundExecutionLock.count({
        where: { status: 'LOCKED' },
      }),
      // 5. Marketplace-funded transactions
      prisma.financialTransaction.findMany({
        where: {
          type: 'REFUND_CUSTOMER',
          direction: 'CREDIT',
          description: { contains: 'تمويل حماية المنصة' },
        },
        select: {
          amount: true,
          createdAt: true,
        },
      }),
      // 6. Top exposed sellers
      prisma.seller.findMany({
        where: {
          outstandings: {
            some: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
          },
        },
        include: {
          stores: { select: { name: true }, take: 1 },
          user: { select: { firstName: true, lastName: true } },
          balance: true,
          riskProfile: true,
          outstandings: {
            where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
            select: { remainingAmount: true },
          },
          reserveAllocations: {
            where: { status: 'RESERVED' },
            select: { amount: true },
          },
        },
        take: 10,
      }),
    ]);

    const totalSellerRefundLiabilities = refundLiabilitiesAgg._sum.remainingAmount || 0;
    const totalUnrecoveredSellerDebt = allDebtAgg._sum.remainingAmount || 0;
    const totalSellerReserveCoverage = reservesAgg._sum.amount || 0;
    const totalActiveRefundReservations = activeLocksCount;

    let totalMarketplaceFundedRefunds = 0;
    let dailyMarketplaceFundedAmount = 0;
    let monthlyMarketplaceFundedAmount = 0;

    for (const tx of marketplaceTransactions) {
      const amt = Number(tx.amount || 0);
      totalMarketplaceFundedRefunds += amt;
      if (tx.createdAt >= startOfToday) {
        dailyMarketplaceFundedAmount += amt;
      }
      if (tx.createdAt >= startOfMonth) {
        monthlyMarketplaceFundedAmount += amt;
      }
    }

    const totalRecoverableMarketplaceExposure = Math.max(
      0,
      totalMarketplaceFundedRefunds - totalSellerReserveCoverage
    );

    // Configurable Limits
    const maxExposurePerSeller = thresholds.maxExposureLimit || 50000;
    const maxAggregateOutstandingDebt = 1000000; // 1,000,000 YER default configurable cap
    const dailyMarketplaceFundedLimit = 200000;  // 200,000 YER default daily cap
    const monthlyMarketplaceFundedLimit = 1000000; // 1,000,000 YER default monthly cap
    const availableProtectionFundBalance = Math.max(0, monthlyMarketplaceFundedLimit - monthlyMarketplaceFundedAmount);

    const isDailyLimitBreached = dailyMarketplaceFundedAmount >= dailyMarketplaceFundedLimit;
    const isMonthlyLimitBreached = monthlyMarketplaceFundedAmount >= monthlyMarketplaceFundedLimit;
    const isAggregateDebtBreached = totalUnrecoveredSellerDebt >= maxAggregateOutstandingDebt;

    // Build exposure alerts
    const exposureAlerts: Array<{ type: string; severity: string; message: string; details?: any }> = [];

    if (isDailyLimitBreached) {
      exposureAlerts.push({
        type: 'DAILY_MARKETPLACE_FUNDING_LIMIT_BREACHED',
        severity: 'CRITICAL',
        message: `تم الوصول إلى الحد الأقصى اليومي لتمويل استرجاعات المنصة (${dailyMarketplaceFundedAmount} / ${dailyMarketplaceFundedLimit} ر.ي)`,
        details: { dailyMarketplaceFundedAmount, dailyMarketplaceFundedLimit },
      });
    }

    if (isMonthlyLimitBreached) {
      exposureAlerts.push({
        type: 'MONTHLY_MARKETPLACE_FUNDING_LIMIT_BREACHED',
        severity: 'CRITICAL',
        message: `تم الوصول إلى الحد الأقصى الشهري لتمويل استرجاعات المنصة (${monthlyMarketplaceFundedAmount} / ${monthlyMarketplaceFundedLimit} ر.ي)`,
        details: { monthlyMarketplaceFundedAmount, monthlyMarketplaceFundedLimit },
      });
    }

    if (isAggregateDebtBreached) {
      exposureAlerts.push({
        type: 'AGGREGATE_SELLER_DEBT_LIMIT_BREACHED',
        severity: 'HIGH',
        message: `إجمالي مديونيات التجار غير المحصلة تجاوز السقف الإجمالي المحدد (${totalUnrecoveredSellerDebt} / ${maxAggregateOutstandingDebt} ر.ي)`,
        details: { totalUnrecoveredSellerDebt, maxAggregateOutstandingDebt },
      });
    }

    // Top exposed sellers sorted descending by debt
    const topExposedSellers = topSellers
      .map((s) => {
        const debt = s.outstandings.reduce((sum, o) => sum + (o.remainingAmount || 0), 0);
        const res = s.reserveAllocations.reduce((sum, r) => sum + (r.amount || 0), 0);
        const name = s.stores[0]?.name || `${s.user?.firstName || ''} ${s.user?.lastName || ''}`.trim() || s.id;
        return {
          sellerId: s.id,
          storeName: name,
          outstandingDebt: debt,
          reservedBalance: res,
          riskTier: s.riskProfile?.riskTier || 'NORMAL',
          isRestricted: s.isFinanciallyRestricted,
        };
      })
      .sort((a, b) => b.outstandingDebt - a.outstandingDebt);

    // Check individual seller concentration alerts
    for (const s of topExposedSellers) {
      if (s.outstandingDebt >= maxExposurePerSeller) {
        exposureAlerts.push({
          type: 'SELLER_EXPOSURE_CAP_BREACHED',
          severity: 'HIGH',
          message: `المتجر [${s.storeName}] تجاوز الحد الأقصى للمديونية الفردية (${s.outstandingDebt} / ${maxExposurePerSeller} ر.ي)`,
          details: { sellerId: s.sellerId, storeName: s.storeName, debt: s.outstandingDebt },
        });
      }
    }

    return {
      totalSellerRefundLiabilities,
      totalUnrecoveredSellerDebt,
      totalMarketplaceFundedRefunds,
      totalRecoverableMarketplaceExposure,
      totalActiveRefundReservations,
      totalSellerReserveCoverage,
      totalRefundObligationsDue: totalSellerRefundLiabilities,
      dailyMarketplaceFundedAmount,
      monthlyMarketplaceFundedAmount,
      availableProtectionFundBalance,
      controls: {
        maxExposurePerSeller,
        maxAggregateOutstandingDebt,
        dailyMarketplaceFundedLimit,
        monthlyMarketplaceFundedLimit,
        isDailyLimitBreached,
        isMonthlyLimitBreached,
        isAggregateDebtBreached,
      },
      exposureAlerts,
      topExposedSellers,
    };
  }
}
