/**
 * SOUQNAA Marketplace — Authoritative Seller Financial Risk & Outstanding Commission Engine
 * Production-grade engine for Seller COD eligibility, Platform Commission Collection,
 * Commission Outstanding Liabilities, Configurable Risk Thresholds, Automatic Restriction &
 * Unblocking, Wallet Deposits Review, and Multi-Vendor Reconciliation.
 * Version: 2.0.0
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
  pendingBalance: number;
  withdrawnBalance: number;
  outstandingCommission: number;
  currency: string;
  isFinanciallyRestricted: boolean;
  financialRestrictionLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'RESTRICTED';
  financialRestrictionReason: string | null;
  financialRestrictedAt: Date | null;
  cashOnDeliveryEnabled: boolean;
  thresholds: FinancialRiskThresholds;
  amountNeededToUnblock: number;
  openOutstandingsCount: number;
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
  };

  /**
   * Retrieves authoritative marketplace risk thresholds from Remote Config / DB
   */
  public static async getRiskThresholds(): Promise<FinancialRiskThresholds> {
    try {
      const [warningSetting, criticalSetting, blockSetting, unblockSetting] = await Promise.all([
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_warning_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_critical_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_block_threshold' } }),
        prisma.systemSetting.findUnique({ where: { key: 'seller_outstanding_unblock_threshold' } }),
      ]);

      const isBlockingActive = await remoteConfigService.isFeatureActive('seller_outstanding_blocking_enabled');
      const isWarningActive = await remoteConfigService.isFeatureActive('seller_outstanding_warning_enabled');
      const isAutoUnblockActive = await remoteConfigService.isFeatureActive('seller_deposit_auto_unblock_enabled');
      const isPartialActive = await remoteConfigService.isFeatureActive('seller_partial_deposit_enabled');

      return {
        warningThreshold: warningSetting ? parseFloat(warningSetting.value) : this.DEFAULT_THRESHOLDS.warningThreshold,
        criticalThreshold: criticalSetting ? parseFloat(criticalSetting.value) : this.DEFAULT_THRESHOLDS.criticalThreshold,
        blockThreshold: blockSetting ? parseFloat(blockSetting.value) : this.DEFAULT_THRESHOLDS.blockThreshold,
        unblockThreshold: unblockSetting ? parseFloat(unblockSetting.value) : this.DEFAULT_THRESHOLDS.unblockThreshold,
        blockingEnabled: isBlockingActive,
        warningEnabled: isWarningActive,
        autoUnblockEnabled: isAutoUnblockActive,
        partialDepositEnabled: isPartialActive,
      };
    } catch (_) {
      return this.DEFAULT_THRESHOLDS;
    }
  }

  /**
   * Computes authoritative financial standing and restriction status for a seller
   */
  public static async getSellerFinancialStanding(sellerId: string): Promise<SellerFinancialStanding> {
    const seller: any = await prisma.seller.findUnique({
      where: { id: sellerId },
      include: {
        stores: { select: { id: true, name: true, logo: true } },
        user: { select: { firstName: true, lastName: true, phone: true, email: true } },
        balance: true,
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
      pendingBalance: pendingBal,
      withdrawnBalance: withdrawnBal,
      outstandingCommission: authoritativeOutstanding,
      currency,
      isFinanciallyRestricted: seller.isFinanciallyRestricted,
      financialRestrictionLevel: calculatedLevel,
      financialRestrictionReason: seller.financialRestrictionReason,
      financialRestrictedAt: seller.financialRestrictedAt,
      cashOnDeliveryEnabled: seller.cashOnDeliveryEnabled,
      thresholds,
      amountNeededToUnblock,
      openOutstandingsCount: openOutstandings.length,
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
   * Evaluates COD eligibility across a list of seller IDs for checkout
   * Ensures backend is 100% authoritative for Cash on Delivery availability.
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

    // Check if any requested seller ID was not found in DB
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
   * Handles sufficient balance deduction vs insufficient balance outstanding creation.
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
      // Already processed idempotently
      const bal = await tx.sellerBalance.findUnique({ where: { sellerId } });
      const seller = await tx.seller.findUnique({ where: { id: sellerId } });
      return {
        collectedAmount: existingCommission.amount,
        outstandingAmount: 0,
        sellerBalance: bal,
        isRestricted: seller?.isFinanciallyRestricted || false,
      };
    }

    // Authoritatively create commission record
    await tx.commission.create({
      data: {
        sellerOrderId,
        rate: 0.10, // Reference metadata
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

    // Fetch or create seller balance
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
      // Prepaid online order: Commission is already factored out of seller payout.
      // Simply log commission transaction for clarity.
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

    // CASH ON DELIVERY (COD):
    // Attempt transactional deduction from seller's available wallet balance
    if (balance.availableBalance >= commissionAmount) {
      // SUFFICIENT BALANCE: Fully collect commission
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
      // INSUFFICIENT BALANCE: Collect whatever is available, create outstanding liability for remainder
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

      // Create official SellerOutstanding liability
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

      // Update total outstanding liability on SellerBalance
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

    // Authoritative Threshold & Risk Check
    const thresholds = await this.getRiskThresholds();
    const activeOutstandings = await tx.sellerOutstanding.findMany({
      where: { sellerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      select: { remainingAmount: true },
    });
    const totalRemaining = activeOutstandings.reduce((sum: number, o: { remainingAmount: number }) => sum + o.remainingAmount, 0);

    let isRestricted = false;
    let restrictionLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'RESTRICTED' = 'NORMAL';

    if (totalRemaining >= thresholds.blockThreshold && thresholds.blockingEnabled) {
      isRestricted = true;
      restrictionLevel = 'RESTRICTED';

      await tx.seller.update({
        where: { id: sellerId },
        data: {
          isFinanciallyRestricted: true,
          financialRestrictionLevel: 'RESTRICTED',
          financialRestrictionReason: `تجاوز الحد الأقصى لمديونية عمولات المنصة (${totalRemaining} / ${thresholds.blockThreshold} ر.ي)`,
          financialRestrictedAt: new Date(),
        },
      });

      // Audit Log
      await tx.auditLog.create({
        data: {
          action: 'SELLER_FINANCIAL_RESTRICTION_AUTO',
          resource: 'sellers',
          details: JSON.stringify({
            sellerId,
            totalRemaining,
            blockThreshold: thresholds.blockThreshold,
            triggerOrderNumber: orderNumber,
            timestamp: new Date().toISOString(),
          }),
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

    // Broadcast real-time events to seller
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { userId: true } });
    if (seller?.userId) {
      SocketService.get()?.emitToUser(seller.userId, 'seller:finance_updated', {
        outstandingCommission: totalRemaining,
        financialRestrictionLevel: restrictionLevel,
        isFinanciallyRestricted: isRestricted,
      });

      if (isRestricted) {
        SocketService.get()?.emitToUser(seller.userId, 'seller:account_restricted', {
          reason: `تجاوز الحد الأقصى للمديونية (${totalRemaining} ر.ي)`,
          outstanding: totalRemaining,
          blockThreshold: thresholds.blockThreshold,
          unblockThreshold: thresholds.unblockThreshold,
          amountNeededToUnblock: Math.max(0, totalRemaining - thresholds.unblockThreshold),
        });
      }
    }

    return {
      collectedAmount,
      outstandingAmount,
      sellerBalance: balance,
      isRestricted,
    };
  }

  /**
   * Atomic, Idempotent Admin Deposit Approval Flow
   * Applies approved funds to FIFO outstanding liabilities, updates ledger, credits surplus,
   * and automatically evaluates unblocking condition!
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

    // Idempotency & Concurrency check: Ensure status is strictly PENDING
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
    const effectiveApprovedAmount = approvedAmount !== undefined && approvedAmount > 0
      ? approvedAmount
      : deposit.amount;

    if (effectiveApprovedAmount > deposit.amount) {
      throw new AppError('المبلغ المعتمد لا يمكن أن يتجاوز مبلغ الحوالة المقدم', 400);
    }

    // Ensure seller balance exists
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

    // Allocate approved deposit across outstanding liabilities FIFO
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

      // Record transaction in ledger for debt repayment
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

    // If there is surplus deposit after clearing all outstandings, credit to available balance
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
      // Just reduce outstanding commission balance
      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: {
          outstandingCommission: { decrement: totalDebtPaid },
        },
      });
    }

    const outstandingAfter = Math.max(0, outstandingBefore - totalDebtPaid);

    // Update deposit status to APPROVED or PARTIALLY_APPROVED
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

    // Authoritative Automatic Unblock Check
    const thresholds = await this.getRiskThresholds();
    let isAutoUnblocked = false;

    if (deposit.seller?.isFinanciallyRestricted) {
      // Unblock condition: remaining outstanding is at or below the configured unblock threshold
      if (thresholds.autoUnblockEnabled && outstandingAfter <= thresholds.unblockThreshold) {
        isAutoUnblocked = true;
        let newLevel: 'NORMAL' | 'WARNING' = 'NORMAL';
        if (outstandingAfter >= thresholds.warningThreshold) {
          newLevel = 'WARNING';
        }

        await tx.seller.update({
          where: { id: sellerId },
          data: {
            isFinanciallyRestricted: false,
            financialRestrictionLevel: newLevel,
            financialRestrictionReason: null,
            financialRestrictedAt: null,
          },
        });

        // Audit unblock event
        await tx.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'SELLER_FINANCIAL_UNBLOCK_AUTO',
            resource: 'sellers',
            details: JSON.stringify({
              sellerId,
              depositId: deposit.id,
              outstandingBefore,
              outstandingAfter,
              unblockThreshold: thresholds.unblockThreshold,
              timestamp: new Date().toISOString(),
            }),
          },
        });
      }
    }

    // Publish notifications and socket updates
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
   * Manual Admin Unblock Action (Privileged RBAC operation)
   * Note: This does NOT erase outstanding liabilities; it only lifts the operational block.
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

    // Notify seller
    SocketService.get()?.emitToUser(seller.userId, 'seller:account_unblocked', {
      reason,
      unblockedBy: 'ADMIN',
    });

    return updated;
  }
}
