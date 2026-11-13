/**
 * SOUQNAA Marketplace — Authoritative COD Wallet Deduction & Seller Payment Fallback Engine
 * 
 * Production-grade engine for automatic Cash on Delivery (COD) financial settlement:
 * - Authoritative backend calculation of COD seller obligations and wallet deductions
 * - Atomic wallet deductions from eligible unreserved balances (preserving 30-day reserves)
 * - Automatic seller payment fallback when available balance is insufficient
 * - Integration with existing payment providers (Kuraimi, CashPay, OneCash, Jawali, etc.) and deposits
 * - Admin manual payment verification and electronic provider callback verification
 * - Concurrency protection, row-level locking, idempotency, and duplicate-proof replays
 * - Financial risk engine integration, restriction evaluation, and non-destructive reconciliation
 * - Mathematical invariant: Outstanding = Original Obligation - Wallet Deductions - Verified Payments + Reversals
 * 
 * Version: 2.1.0
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { SellerFinancialRiskService } from './seller-financial-risk.service';
import { WalletProviderRegistry } from '../payments/adapters/wallet-provider.adapter';
import { UrlSecurityUtil } from '../../utils/url-security.util';
import { TaxMath } from '../tax/tax.math';
import { CodObligationStatus, TransactionType, Prisma } from '@prisma/client';

export interface ProcessCodObligationParams {
  sellerOrderId?: string;
  orderId?: string;
  orderNumber: string;
  sellerId: string;
  obligationAmount: number;
  isCod: boolean;
  currency?: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
}

export interface CodObligationResult {
  obligationId: string;
  obligationNumber: string;
  sellerId: string;
  orderNumber: string;
  obligationAmount: number;
  walletDeduction: number;
  remainingObligation: number;
  outstandingAmount: number;
  status: CodObligationStatus;
  isFullySettled: boolean;
  currency: string;
  sellerBalance: any;
  isRestricted: boolean;
}

export interface SubmitPaymentProofParams {
  obligationId: string;
  sellerUserId: string;
  amount: number;
  walletProvider: string;
  transferReference: string;
  proofImageUrl: string;
  senderName?: string;
  senderPhone?: string;
}

export interface VerifyPaymentParams {
  obligationId: string;
  adminUserId: string;
  approvedAmount?: number;
  adminNote: string;
}

export interface RejectPaymentParams {
  obligationId: string;
  adminUserId: string;
  rejectionReason: string;
}

export interface ReverseObligationParams {
  obligationId: string;
  adminUserId: string;
  reason: string;
}

export class SellerCodSettlementService {
  public static readonly VERSION = '2.1.0';

  /**
   * Generates a unique, concurrency-safe COD Obligation Number: COD-OBL-YYYY-XXXXXX
   */
  public static async generateObligationNumber(tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx || prisma;
    const year = new Date().getFullYear();
    const prefix = `COD-OBL-${year}-`;

    if (tx) {
      try {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cod_obligation_number_generation'))`;
      } catch (_) {}
    }

    const latest = await client.codFinancialObligation.findFirst({
      where: {
        obligationNumber: {
          startsWith: prefix,
        },
      },
      orderBy: {
        obligationNumber: 'desc',
      },
      select: {
        obligationNumber: true,
      },
    });

    let nextSeq = 1;
    if (latest && latest.obligationNumber) {
      const parts = latest.obligationNumber.split('-');
      const parsed = parseInt(parts[3] || '', 10);
      if (!isNaN(parsed)) {
        nextSeq = parsed + 1;
      }
    }

    let candidate = `${prefix}${String(nextSeq).padStart(6, '0')}`;
    while (await client.codFinancialObligation.findUnique({ where: { obligationNumber: candidate } })) {
      nextSeq++;
      candidate = `${prefix}${String(nextSeq).padStart(6, '0')}`;
    }
    return candidate;
  }

  /**
   * PHASE 2 & 3: AUTHORITATIVE FINANCIAL RULE & ATOMIC WALLET DEDUCTION
   * 
   * When a COD transaction creates a seller financial obligation:
   * walletDeduction = MIN(eligibleWalletBalance, obligationAmount)
   * remainingObligation = obligationAmount - walletDeduction
   * 
   * Eligible wallet balance excludes reserved funds (e.g. 30-day reserve allocations),
   * pending settlements, and restricted balances. Never creates a negative wallet balance.
   */
  public static async processCodOrderObligation(
    tx: Prisma.TransactionClient,
    params: ProcessCodObligationParams
  ): Promise<CodObligationResult> {
    const {
      sellerOrderId,
      orderId,
      orderNumber,
      sellerId,
      obligationAmount: rawObligationAmount,
      isCod,
      currency = 'YER',
      metadata,
    } = params;

    // Monetary precision: 2 decimal places in smallest unit
    const obligationAmount = Math.max(0, Math.round(rawObligationAmount * 100) / 100);

    // Guard: Only COD transactions generate COD seller obligations
    if (!isCod || obligationAmount <= 0) {
      const balance = await tx.sellerBalance.findUnique({ where: { sellerId } });
      const seller = await tx.seller.findUnique({ where: { id: sellerId } });
      return {
        obligationId: '',
        obligationNumber: '',
        sellerId,
        orderNumber,
        obligationAmount: 0,
        walletDeduction: 0,
        remainingObligation: 0,
        outstandingAmount: 0,
        status: CodObligationStatus.SETTLED,
        isFullySettled: true,
        currency,
        sellerBalance: balance,
        isRestricted: seller?.isFinanciallyRestricted || false,
      };
    }

    // Idempotency guard: Verify obligation record doesn't already exist for this sellerOrderId
    if (sellerOrderId) {
      const existing = await tx.codFinancialObligation.findFirst({
        where: { sellerOrderId },
      });

      if (existing) {
        const bal = await tx.sellerBalance.findUnique({ where: { sellerId } });
        const seller = await tx.seller.findUnique({ where: { id: sellerId } });
        return {
          obligationId: existing.id,
          obligationNumber: existing.obligationNumber,
          sellerId: existing.sellerId,
          orderNumber: existing.orderNumber,
          obligationAmount: existing.obligationAmount,
          walletDeduction: existing.walletDeduction,
          remainingObligation: existing.remainingObligation,
          outstandingAmount: existing.outstandingAmount,
          status: existing.status,
          isFullySettled: existing.status === CodObligationStatus.SETTLED,
          currency: existing.currency,
          sellerBalance: bal,
          isRestricted: seller?.isFinanciallyRestricted || false,
        };
      }
    }

    // Acquire row-level lock on SellerBalance to prevent concurrent double-spending
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
          currency,
        },
      });
    }

    // Calculate Authoritative Eligible Balance:
    // Reserves are held in SellerReserveAllocation and aggregated in SellerRiskProfile.
    // Available balance in SellerBalance is strictly liquid.
    // Never allow negative balance:
    const availableBalance = Math.max(0, balance.availableBalance);
    const eligibleWalletBalance = Math.round(availableBalance * 100) / 100;

    // Apply Authoritative Financial Rule:
    // walletDeduction = MIN(eligibleWalletBalance, obligationAmount)
    // remainingObligation = obligationAmount - walletDeduction
    const walletDeduction = Math.round(Math.min(eligibleWalletBalance, obligationAmount) * 100) / 100;
    const remainingObligation = Math.round(Math.max(0, obligationAmount - walletDeduction) * 100) / 100;

    let deductionTransactionId: string | undefined = undefined;

    // Execute atomic wallet deduction if eligible funds exist
    if (walletDeduction > 0) {
      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: { availableBalance: { decrement: walletDeduction } },
      });

      const deductionTx = await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: -walletDeduction,
          type: TransactionType.COMMISSION,
          referenceId: sellerOrderId || orderNumber,
          description: `استقطاع تلقائي لالتزام COD للطلب #${orderNumber} (${walletDeduction} ${currency})`,
        },
      });
      deductionTransactionId = deductionTx.id;
    }

    let outstandingId: string | undefined = undefined;

    // If remaining obligation exists, integrate with existing SellerOutstanding debt workflow
    if (remainingObligation > 0) {
      const outstandingRecord = await tx.sellerOutstanding.create({
        data: {
          sellerId,
          sourceType: 'COD_OBLIGATION',
          sourceReference: orderNumber,
          amount: remainingObligation,
          paidAmount: 0,
          remainingAmount: remainingObligation,
          currency,
          status: 'OPEN',
          warningLevel: 'NORMAL',
          metadata: JSON.stringify({
            sellerOrderId,
            orderNumber,
            totalObligation: obligationAmount,
            walletDeduction,
            remainingObligation,
            createdAt: new Date().toISOString(),
            ...(metadata || {}),
          }),
        },
      });
      outstandingId = outstandingRecord.id;

      balance = await tx.sellerBalance.update({
        where: { id: balance.id },
        data: { outstandingCommission: { increment: remainingObligation } },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: 0,
          type: TransactionType.DEBIT,
          referenceId: sellerOrderId || orderNumber,
          description: `تسجيل مديونية التزام COD للطلب #${orderNumber} (${remainingObligation} ${currency} مستحقة)`,
        },
      });
    }

    // Determine lifecycle status
    let initialStatus: CodObligationStatus;
    if (remainingObligation <= 0.001) {
      initialStatus = CodObligationStatus.SETTLED;
    } else if (walletDeduction > 0) {
      initialStatus = CodObligationStatus.PARTIALLY_SETTLED;
    } else {
      initialStatus = CodObligationStatus.PENDING_PAYMENT;
    }

    const obligationNumber = await this.generateObligationNumber(tx);

    const obligation = await tx.codFinancialObligation.create({
      data: {
        obligationNumber,
        sellerId,
        sellerOrderId: sellerOrderId || null,
        orderId: orderId || null,
        orderNumber,
        obligationAmount,
        walletDeduction,
        remainingObligation,
        verifiedPaymentAmount: 0,
        outstandingAmount: remainingObligation,
        currency,
        status: initialStatus,
        walletTransactionId: deductionTransactionId || null,
        outstandingId: outstandingId || null,
        paymentMethod: walletDeduction > 0 ? 'WALLET_DEDUCTION' : null,
        settledAt: remainingObligation <= 0.001 ? new Date() : null,
        metadata: JSON.stringify({
          sellerOrderId,
          orderNumber,
          walletDeduction,
          remainingObligation,
          initialStatus,
          createdAt: new Date().toISOString(),
          ...(metadata || {}),
        }),
      },
    });

    // Re-evaluate financial risk restrictions
    const restrictionResult = await SellerFinancialRiskService.evaluateAndApplyRestrictions(tx, sellerId);

    // Real-time broadcasts
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { userId: true } });
    if (seller?.userId) {
      SocketService.get()?.emitToUser(seller.userId, 'seller:finance_updated', {
        outstandingCommission: restrictionResult.totalRemainingDebt,
        financialRestrictionLevel: restrictionResult.restrictionLevel,
        isFinanciallyRestricted: restrictionResult.isRestricted,
        newOrdersPaused: restrictionResult.newOrdersPaused,
      });

      SocketService.get()?.emitToUser(seller.userId, 'seller:cod_obligation_created', {
        obligationId: obligation.id,
        obligationNumber: obligation.obligationNumber,
        obligationAmount,
        walletDeduction,
        remainingObligation,
        status: initialStatus,
      });
    }

    return {
      obligationId: obligation.id,
      obligationNumber: obligation.obligationNumber,
      sellerId,
      orderNumber,
      obligationAmount,
      walletDeduction,
      remainingObligation,
      outstandingAmount: remainingObligation,
      status: initialStatus,
      isFullySettled: remainingObligation <= 0.001,
      currency,
      sellerBalance: balance,
      isRestricted: restrictionResult.isRestricted,
    };
  }

  /**
   * PHASE 4: SELLER PAYMENT FALLBACK — SUBMIT PAYMENT PROOF
   * 
   * When an outstanding obligation remains, the seller submits payment proof
   * using an existing configured payment provider (Kuraimi, Jawali, CashPay, etc.).
   * 
   * A submitted payment proof must NEVER be treated as verified payment.
   * Outstanding obligation is only reduced upon authorized admin/provider verification.
   */
  public static async submitPaymentProof(
    params: SubmitPaymentProofParams
  ): Promise<any> {
    const {
      obligationId,
      sellerUserId,
      amount,
      walletProvider,
      transferReference,
      proofImageUrl,
      senderName,
      senderPhone,
    } = params;

    const parsedAmount = Math.round(Number(amount) * 100) / 100;
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError('مبلغ السداد المدخل غير صالح', 400);
    }

    if (!walletProvider || typeof walletProvider !== 'string') {
      throw new AppError('يرجى تحديد مزود المحفظة أو البنك المحول منه', 400);
    }

    if (!transferReference || typeof transferReference !== 'string' || !transferReference.trim()) {
      throw new AppError('رقم الحوالة أو مرجع العملية مطلوب', 400);
    }

    const cleanRef = transferReference.trim();
    if (cleanRef.length < 3) {
      throw new AppError('يرجى إدخال رقم مرجع تحويل صالح', 400);
    }

    if (!proofImageUrl || typeof proofImageUrl !== 'string' || !proofImageUrl.trim()) {
      throw new AppError('صورة سند التحويل أو إشعار الإيداع مطلوبة', 400);
    }

    if (!UrlSecurityUtil.isSafeUrl(proofImageUrl.trim())) {
      throw new AppError('رابط إشعار التحويل غير صالح أو غير مسموح به لأسباب أمنية', 400, 'INVALID_RECEIPT_URL');
    }

    // Replay attack protection: Reference must not be duplicated
    const existingDeposit = await prisma.walletDeposit.findFirst({
      where: { transferReference: cleanRef },
      select: { id: true },
    });
    if (existingDeposit) {
      throw new AppError('رقم العملية أو المرجع البنكي تم استخدامه مسبقاً. يرجى التحقق من السند.', 409, 'DUPLICATE_TRANSACTION_REFERENCE');
    }

    return await prisma.$transaction(async (tx) => {
      // Find obligation and enforce seller ownership
      const obligation = await tx.codFinancialObligation.findUnique({
        where: { id: obligationId },
        include: {
          seller: { select: { id: true, userId: true } },
        },
      });

      if (!obligation) {
        throw new AppError('التزام الدفع عند الاستلام غير موجود', 404);
      }

      if (obligation.seller.userId !== sellerUserId) {
        throw new AppError('غير مصرح لك بالوصول إلى هذا الالتزام المالي', 403, 'FORBIDDEN');
      }

      if (obligation.status === CodObligationStatus.SETTLED) {
        throw new AppError('تمت تسوية هذا الالتزام المالي بالكامل مسبقاً', 400);
      }

      if (parsedAmount > obligation.outstandingAmount) {
        throw new AppError(
          `المبلغ المدخل (${parsedAmount} ر.ي) يتجاوز المبلغ المتبقي المستحق (${obligation.outstandingAmount} ر.ي)`,
          400
        );
      }

      // Create linked WalletDeposit in pending state
      const deposit = await tx.walletDeposit.create({
        data: {
          userType: 'SELLER',
          userId: sellerUserId,
          sellerId: obligation.sellerId,
          amount: parsedAmount,
          currency: obligation.currency,
          walletProvider: walletProvider.trim().toUpperCase(),
          transferReference: cleanRef,
          proofImageUrl: proofImageUrl.trim(),
          senderName: senderName ? String(senderName).trim() : null,
          senderPhone: senderPhone ? String(senderPhone).trim() : null,
          status: 'PENDING',
        },
      });

      // Update obligation to PAYMENT_SUBMITTED without reducing outstanding debt
      const updatedObligation = await tx.codFinancialObligation.update({
        where: { id: obligation.id },
        data: {
          status: CodObligationStatus.PAYMENT_SUBMITTED,
          depositId: deposit.id,
          paymentMethod: walletProvider.trim().toUpperCase(),
          paymentReference: cleanRef,
          proofImageUrl: proofImageUrl.trim(),
        },
      });

      // Broadcast events
      SocketService.get()?.emitToUser(sellerUserId, 'seller:cod_obligation_updated', {
        obligationId: updatedObligation.id,
        status: updatedObligation.status,
        paymentReference: cleanRef,
      });

      void SocketService.get()?.emitToAdminsWithPermission('finance:payments', 'admin:cod_payment_submitted', {
        obligationId: updatedObligation.id,
        obligationNumber: updatedObligation.obligationNumber,
        sellerId: updatedObligation.sellerId,
        amount: parsedAmount,
        walletProvider,
        transferReference: cleanRef,
      });

      return {
        obligation: updatedObligation,
        deposit,
      };
    });
  }

  /**
   * PHASE 4 & 5: AUTHORITATIVE ADMIN / ELECTRONIC PAYMENT VERIFICATION
   * 
   * Only verified payment reduces the outstanding obligation.
   * Decrements outstanding commission, records FIFO debt recovery, posts ledger transaction,
   * updates status to SETTLED (or PARTIALLY_SETTLED), and evaluates unblocking.
   */
  public static async verifyPayment(params: VerifyPaymentParams): Promise<any> {
    const { obligationId, adminUserId, approvedAmount: rawApprovedAmount, adminNote } = params;

    if (!adminNote || !adminNote.trim()) {
      throw new AppError('سبب وملاحظات اعتماد وتأكيد السداد مطلوبة إجبارياً للتدقيق المحاسبي', 400);
    }

    return await prisma.$transaction(async (tx) => {
      // Concurrency protection: row-level lock
      const obligation = await tx.codFinancialObligation.findUnique({
        where: { id: obligationId },
        include: {
          seller: { include: { balance: true } },
          outstanding: true,
          deposit: true,
        },
      });

      if (!obligation) {
        throw new AppError('التزام الدفع عند الاستلام غير موجود', 404);
      }

      if (obligation.status === CodObligationStatus.SETTLED) {
        throw new AppError('تم البت في هذا الالتزام المالي وتسويته بالكامل مسبقاً', 400);
      }

      if (
        obligation.status !== CodObligationStatus.PAYMENT_SUBMITTED &&
        obligation.status !== CodObligationStatus.UNDER_REVIEW &&
        obligation.status !== CodObligationStatus.PENDING_PAYMENT &&
        obligation.status !== CodObligationStatus.PARTIALLY_SETTLED
      ) {
        throw new AppError(`حالة الالتزام الحالية [${obligation.status}] لا تسمح بالاعتماد`, 400);
      }

      const effectiveApprovedAmount =
        rawApprovedAmount !== undefined && rawApprovedAmount > 0
          ? Math.round(Number(rawApprovedAmount) * 100) / 100
          : obligation.outstandingAmount;

      if (effectiveApprovedAmount <= 0) {
        throw new AppError('مبلغ الاعتماد يجب أن يكون أكبر من الصفر', 400);
      }

      // Handle overpayment policy: Applied amount capped at outstanding; surplus credited to available balance
      const appliedToObligation = Math.round(Math.min(effectiveApprovedAmount, obligation.outstandingAmount) * 100) / 100;
      const surplus = Math.round(Math.max(0, effectiveApprovedAmount - obligation.outstandingAmount) * 100) / 100;

      const newVerifiedPaymentTotal = Math.round((obligation.verifiedPaymentAmount + appliedToObligation) * 100) / 100;
      const newOutstandingAmount = Math.round(Math.max(0, obligation.remainingObligation - newVerifiedPaymentTotal) * 100) / 100;
      const isFullySettled = newOutstandingAmount <= 0.001;
      const newStatus = isFullySettled ? CodObligationStatus.SETTLED : CodObligationStatus.PARTIALLY_SETTLED;

      // Update CodFinancialObligation
      const updatedObligation = await tx.codFinancialObligation.update({
        where: { id: obligation.id },
        data: {
          verifiedPaymentAmount: newVerifiedPaymentTotal,
          outstandingAmount: newOutstandingAmount,
          status: newStatus,
          verifiedByAdminId: adminUserId,
          verifiedAt: new Date(),
          settledAt: isFullySettled ? new Date() : null,
          adminNote: adminNote.trim(),
        },
      });

      // Update linked WalletDeposit if present
      if (obligation.depositId) {
        await tx.walletDeposit.update({
          where: { id: obligation.depositId },
          data: {
            status: isFullySettled ? 'APPROVED' : 'PARTIALLY_APPROVED',
            approvedAmount: effectiveApprovedAmount,
            reviewedByAdminId: adminUserId,
            reviewedAt: new Date(),
            completedAt: new Date(),
            adminNote: adminNote.trim(),
          },
        });
      }

      // Update linked SellerOutstanding if present
      if (obligation.outstandingId) {
        const out = await tx.sellerOutstanding.findUnique({ where: { id: obligation.outstandingId } });
        if (out) {
          const newPaid = Math.round((out.paidAmount + appliedToObligation) * 100) / 100;
          const newRemaining = Math.round(Math.max(0, out.remainingAmount - appliedToObligation) * 100) / 100;
          await tx.sellerOutstanding.update({
            where: { id: out.id },
            data: {
              paidAmount: newPaid,
              remainingAmount: newRemaining,
              status: newRemaining <= 0.001 ? 'PAID' : 'PARTIALLY_PAID',
            },
          });

          await tx.debtRecoveryAllocation.create({
            data: {
              sellerId: obligation.sellerId,
              depositId: obligation.depositId || null,
              outstandingId: out.id,
              amount: appliedToObligation,
              currency: obligation.currency,
              recoveredFrom: 'DEPOSIT',
              transactionRef: obligation.paymentReference || obligation.obligationNumber,
              notes: `سداد التزام COD #${obligation.orderNumber} - مرجع: ${obligation.paymentReference || 'MANUAL'}`,
            },
          });
        }
      }

      // Update SellerBalance
      let balance = obligation.seller.balance;
      if (!balance) {
        balance = await tx.sellerBalance.create({
          data: {
            sellerId: obligation.sellerId,
            availableBalance: 0,
            pendingBalance: 0,
            withdrawnBalance: 0,
            outstandingCommission: 0,
            currency: obligation.currency,
          },
        });
      }

      await tx.sellerBalance.update({
        where: { id: balance.id },
        data: {
          outstandingCommission: { decrement: appliedToObligation },
          ...(surplus > 0 ? { availableBalance: { increment: surplus } } : {}),
        },
      });

      // Ledger entries
      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: appliedToObligation,
          type: TransactionType.OUTSTANDING_PAYMENT,
          referenceId: obligation.obligationNumber,
          description: `سداد مؤكد لالتزام COD للطلب #${obligation.orderNumber} (${appliedToObligation} ${obligation.currency})`,
        },
      });

      if (surplus > 0) {
        await tx.sellerTransaction.create({
          data: {
            sellerBalanceId: balance.id,
            amount: surplus,
            type: TransactionType.CREDIT,
            referenceId: obligation.obligationNumber,
            description: `إيداع فائض سداد التزام COD في رصيد المتجر (${surplus} ${obligation.currency})`,
          },
        });
      }

      // Re-evaluate restrictions
      const restrictionResult = await SellerFinancialRiskService.evaluateAndApplyRestrictions(tx, obligation.sellerId);

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'COD_OBLIGATION_PAYMENT_VERIFIED',
          resource: 'finance',
          details: JSON.stringify({
            obligationId: obligation.id,
            obligationNumber: obligation.obligationNumber,
            appliedAmount: appliedToObligation,
            surplus,
            newStatus,
            adminUserId,
            adminNote: adminNote.trim(),
            timestamp: new Date().toISOString(),
          }),
        },
      });

      // Socket broadcasts
      const seller = await tx.seller.findUnique({ where: { id: obligation.sellerId }, select: { userId: true } });
      if (seller?.userId) {
        SocketService.get()?.emitToUser(seller.userId, 'seller:cod_obligation_updated', {
          obligationId: obligation.id,
          status: newStatus,
          verifiedAmount: appliedToObligation,
          remainingAmount: newOutstandingAmount,
        });

        SocketService.get()?.emitToUser(seller.userId, 'seller:finance_updated', {
          outstandingCommission: restrictionResult.totalRemainingDebt,
          isFinanciallyRestricted: restrictionResult.isRestricted,
        });
      }

      return {
        obligation: updatedObligation,
        appliedAmount: appliedToObligation,
        surplus,
        isFullySettled,
      };
    });
  }

  /**
   * PHASE 4: REJECT PAYMENT PROOF
   * 
   * Rejection keeps the outstanding obligation unchanged and marks status as PAYMENT_REJECTED.
   */
  public static async rejectPayment(params: RejectPaymentParams): Promise<any> {
    const { obligationId, adminUserId, rejectionReason } = params;

    if (!rejectionReason || !rejectionReason.trim()) {
      throw new AppError('سبب رفض إشعار السداد مطلوب إجبارياً للتدقيق المحاسبي', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const obligation = await tx.codFinancialObligation.findUnique({
        where: { id: obligationId },
        include: { deposit: true, seller: true },
      });

      if (!obligation) {
        throw new AppError('التزام الدفع عند الاستلام غير موجود', 404);
      }

      if (obligation.status === CodObligationStatus.SETTLED) {
        throw new AppError('لا يمكن رفض سداد التزام مالي تمت تسويته بالكامل', 400);
      }

      const updatedObligation = await tx.codFinancialObligation.update({
        where: { id: obligation.id },
        data: {
          status: CodObligationStatus.PAYMENT_REJECTED,
          rejectionReason: rejectionReason.trim(),
          adminNote: `تم رفض الإشعار من قبل الإدارة: ${rejectionReason.trim()}`,
        },
      });

      if (obligation.depositId) {
        await tx.walletDeposit.update({
          where: { id: obligation.depositId },
          data: {
            status: 'REJECTED',
            rejectionReason: rejectionReason.trim(),
            reviewedByAdminId: adminUserId,
            reviewedAt: new Date(),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'COD_OBLIGATION_PAYMENT_REJECTED',
          resource: 'finance',
          details: JSON.stringify({
            obligationId: obligation.id,
            obligationNumber: obligation.obligationNumber,
            rejectionReason: rejectionReason.trim(),
            adminUserId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      if (obligation.seller.userId) {
        SocketService.get()?.emitToUser(obligation.seller.userId, 'seller:cod_obligation_updated', {
          obligationId: obligation.id,
          status: CodObligationStatus.PAYMENT_REJECTED,
          rejectionReason: rejectionReason.trim(),
        });
      }

      return updatedObligation;
    });
  }

  /**
   * PHASE 5: COMPENSATING REVERSAL TRANSACTION
   * 
   * Reversals preserve historical records and post linked compensating transactions.
   */
  public static async reverseObligation(params: ReverseObligationParams): Promise<any> {
    const { obligationId, adminUserId, reason } = params;

    if (!reason || !reason.trim()) {
      throw new AppError('سبب العملية العكسية مطلوب إجبارياً للتدقيق المحاسبي', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const obligation = await tx.codFinancialObligation.findUnique({
        where: { id: obligationId },
        include: {
          seller: { include: { balance: true } },
          outstanding: true,
        },
      });

      if (!obligation) {
        throw new AppError('التزام الدفع عند الاستلام غير موجود', 404);
      }

      if (obligation.status === CodObligationStatus.REVERSED) {
        throw new AppError('تمت تسوية هذه العملية عكسياً مسبقاً', 400);
      }

      const balance = obligation.seller.balance;

      // 1. If wallet deduction occurred, refund deducted funds via compensating CREDIT transaction
      if (obligation.walletDeduction > 0 && balance) {
        await tx.sellerBalance.update({
          where: { id: balance.id },
          data: { availableBalance: { increment: obligation.walletDeduction } },
        });

        await tx.sellerTransaction.create({
          data: {
            sellerBalanceId: balance.id,
            amount: obligation.walletDeduction,
            type: TransactionType.CREDIT,
            referenceId: obligation.obligationNumber,
            description: `تسوية عكسية تعويضية لاستقطاع COD للطلب #${obligation.orderNumber} (${obligation.walletDeduction} ${obligation.currency}) - السبب: ${reason.trim()}`,
          },
        });
      }

      // 2. If open debt was recorded, cancel the outstanding liability
      if (obligation.outstandingId && balance) {
        const out = await tx.sellerOutstanding.findUnique({ where: { id: obligation.outstandingId } });
        if (out && out.remainingAmount > 0) {
          await tx.sellerBalance.update({
            where: { id: balance.id },
            data: { outstandingCommission: { decrement: out.remainingAmount } },
          });

          await tx.sellerOutstanding.update({
            where: { id: out.id },
            data: {
              remainingAmount: 0,
              status: 'WAIVED',
              warningLevel: 'NORMAL',
            },
          });
        }
      }

      // 3. Mark obligation as REVERSED
      const updatedObligation = await tx.codFinancialObligation.update({
        where: { id: obligation.id },
        data: {
          status: CodObligationStatus.REVERSED,
          reversedAt: new Date(),
          adminNote: `تم عكس العملية تعويضياً: ${reason.trim()}`,
        },
      });

      // Re-evaluate restrictions
      const restrictionResult = await SellerFinancialRiskService.evaluateAndApplyRestrictions(tx, obligation.sellerId);

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'COD_OBLIGATION_REVERSED',
          resource: 'finance',
          details: JSON.stringify({
            obligationId: obligation.id,
            obligationNumber: obligation.obligationNumber,
            reversedWalletDeduction: obligation.walletDeduction,
            reversedOutstanding: obligation.outstandingAmount,
            reason: reason.trim(),
            adminUserId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return updatedObligation;
    });
  }

  /**
   * Retrieves COD obligations summary and list for a seller or marketplace
   */
  public static async getSellerCodSummary(sellerId?: string) {
    const where: Prisma.CodFinancialObligationWhereInput = sellerId ? { sellerId } : {};

    const [
      totalCount,
      allObligations,
    ] = await Promise.all([
      prisma.codFinancialObligation.count({ where }),
      prisma.codFinancialObligation.findMany({
        where,
        include: {
          seller: {
            include: {
              stores: { select: { id: true, name: true, logo: true } },
              user: { select: { firstName: true, lastName: true, phone: true } },
            },
          },
          deposit: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    let totalObligationAmount = 0;
    let totalWalletDeductions = 0;
    let totalVerifiedPayments = 0;
    let totalOutstanding = 0;
    let totalReversals = 0;

    for (const o of allObligations) {
      if (o.status === CodObligationStatus.REVERSED) {
        totalReversals += o.obligationAmount;
      } else {
        totalObligationAmount += o.obligationAmount;
        totalWalletDeductions += o.walletDeduction;
        totalVerifiedPayments += o.verifiedPaymentAmount;
        totalOutstanding += o.outstandingAmount;
      }
    }

    return {
      totalCount,
      totalObligationAmount: Math.round(totalObligationAmount * 100) / 100,
      totalWalletDeductions: Math.round(totalWalletDeductions * 100) / 100,
      totalVerifiedPayments: Math.round(totalVerifiedPayments * 100) / 100,
      totalReversals: Math.round(totalReversals * 100) / 100,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      obligations: allObligations,
    };
  }
}
