import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { WalletTxType, WalletTxStatus, NotificationType } from '@prisma/client';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';

export class CustomerWalletService {
  /**
   * Retrieves or creates a customer internal wallet account.
   */
  static async getOrCreateAccount(userId: string, txClient?: any) {
    const db = txClient || prisma;
    let account = await db.walletAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      account = await db.walletAccount.create({
        data: {
          userId,
          currency: 'YER',
          availableBalance: 0.0,
          pendingBalance: 0.0,
        },
      });
    }

    return account;
  }

  /**
   * Retrieves wallet summary and computes ledger-derived authoritative balance.
   */
  static async getAccountDetails(userId: string) {
    const account = await this.getOrCreateAccount(userId);

    // Compute balance from immutable ledger entries to ensure financial consistency
    const ledgerAggregates = await prisma.walletLedgerEntry.groupBy({
      by: ['direction'],
      where: {
        walletAccountId: account.id,
        status: WalletTxStatus.COMPLETED,
      },
      _sum: {
        amount: true,
      },
    });

    let totalCredits = 0;
    let totalDebits = 0;
    for (const agg of ledgerAggregates) {
      if (agg.direction === 'CREDIT') {
        totalCredits = agg._sum.amount || 0;
      } else if (agg.direction === 'DEBIT') {
        totalDebits = agg._sum.amount || 0;
      }
    }

    const authoritativeBalance = parseFloat((totalCredits - totalDebits).toFixed(2));

    // Auto-heal cached balance if drifted
    if (Math.abs(account.availableBalance - authoritativeBalance) > 0.009) {
      await prisma.walletAccount.update({
        where: { id: account.id },
        data: { availableBalance: authoritativeBalance },
      });
      account.availableBalance = authoritativeBalance;
    }

    const totalTransactions = await prisma.walletTransaction.count({
      where: { walletAccountId: account.id },
    });

    return {
      accountId: account.id,
      userId: account.userId,
      currency: account.currency,
      availableBalance: account.availableBalance,
      pendingBalance: account.pendingBalance,
      totalCredits,
      totalDebits,
      totalTransactions,
      ledgerConsistent: true,
    };
  }

  /**
   * Retrieves paginated transaction history.
   */
  static async getTransactions(
    userId: string,
    params: { page?: number; limit?: number; type?: WalletTxType }
  ) {
    const account = await this.getOrCreateAccount(userId);
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(50, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = { walletAccountId: account.id };
    if (params.type) where.type = params.type;

    const [total, transactions] = await Promise.all([
      prisma.walletTransaction.count({ where }),
      prisma.walletTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          refund: {
            select: {
              id: true,
              refundNumber: true,
              orderId: true,
              order: { select: { orderNumber: true } },
            },
          },
        },
      }),
    ]);

    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        referenceNumber: t.referenceNumber,
        externalReference: t.externalReference,
        type: t.type,
        status: t.status,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        refundNumber: t.refund?.refundNumber,
        orderNumber: t.refund?.order?.orderNumber,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Idempotently credits customer wallet from an approved refund.
   * Uses unique constraint on (refundId, type) to strictly prevent double credits.
   */
  static async creditRefund(
    params: {
      refundId: string;
      customerId: string;
      amount: number;
      currency: string;
      orderNumber: string;
      refundNumber: string;
      adminUserId?: string;
    },
    txClient?: any
  ) {
    const { refundId, customerId, amount, currency, orderNumber, refundNumber, adminUserId } = params;

    if (amount <= 0) {
      throw new AppError('مبلغ الاسترجاع يجب أن يكون أكبر من الصفر', 400);
    }

    const runner = async (tx: any) => {
      // 1. Lock/Fetch account
      const account = await tx.walletAccount.findUnique({
        where: { userId: customerId },
      });
      const targetAccount = account || (await tx.walletAccount.create({
        data: {
          userId: customerId,
          currency: currency || 'YER',
          availableBalance: 0.0,
          pendingBalance: 0.0,
        },
      }));

      // 2. Idempotency Check: prevent duplicate refund credit
      const existingTx = await tx.walletTransaction.findFirst({
        where: {
          refundId,
          type: WalletTxType.REFUND_CREDIT,
          status: WalletTxStatus.COMPLETED,
        },
      });

      if (existingTx) {
        return {
          alreadyProcessed: true,
          transaction: existingTx,
          account: targetAccount,
        };
      }

      const balanceBefore = targetAccount.availableBalance;
      const balanceAfter = parseFloat((balanceBefore + amount).toFixed(2));
      const refNumber = `WTX-REF-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      // 3. Create Immutable Ledger Entry
      const ledgerEntry = await tx.walletLedgerEntry.create({
        data: {
          walletAccountId: targetAccount.id,
          type: WalletTxType.REFUND_CREDIT,
          direction: 'CREDIT',
          amount,
          currency: currency || 'YER',
          balanceBefore,
          balanceAfter,
          referenceType: 'REFUND',
          referenceId: refundId,
          status: WalletTxStatus.COMPLETED,
          description: `استرداد مالي للطلب #${orderNumber} (طلب استرجاع #${refundNumber})`,
          createdBy: adminUserId || null,
        },
      });

      // 4. Create Wallet Transaction Record
      const walletTx = await tx.walletTransaction.create({
        data: {
          walletAccountId: targetAccount.id,
          refundId,
          type: WalletTxType.REFUND_CREDIT,
          status: WalletTxStatus.COMPLETED,
          amount,
          currency: currency || 'YER',
          referenceNumber: refNumber,
          description: `استرجاع مالي للطلب #${orderNumber}`,
          metadata: JSON.stringify({
            refundId,
            refundNumber,
            orderNumber,
            ledgerEntryId: ledgerEntry.id,
          }),
          completedAt: new Date(),
        },
      });

      // 5. Update cached account available balance
      const updatedAccount = await tx.walletAccount.update({
        where: { id: targetAccount.id },
        data: { availableBalance: balanceAfter },
      });

      return {
        alreadyProcessed: false,
        transaction: walletTx,
        ledgerEntry,
        account: updatedAccount,
      };
    };

    if (txClient) {
      return await runner(txClient);
    } else {
      return await prisma.$transaction(runner);
    }
  }

  /**
   * Administrative manual adjustment (credit or debit) backed by immutable ledger entries.
   */
  static async manualAdjustment(params: {
    adminUserId: string;
    targetUserId: string;
    amount: number;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    reference?: string;
  }) {
    const { adminUserId, targetUserId, amount, direction, reason, reference } = params;

    if (!reason || reason.trim().length < 5) {
      throw new AppError('سبب التسوية الإدارية إلزامي ومطلوب للتوثيق المالي', 400);
    }
    if (!amount || amount <= 0) {
      throw new AppError('مبلغ التسوية يجب أن يكون أكبر من الصفر', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const account = await this.getOrCreateAccount(targetUserId, tx);

      if (direction === 'DEBIT' && account.availableBalance < amount) {
        throw new AppError(
          `رصيد المحفظة الحالي (${account.availableBalance} ${account.currency}) غير كافٍ لخصم مبلغ (${amount} ${account.currency})`,
          400
        );
      }

      const balanceBefore = account.availableBalance;
      const balanceAfter = parseFloat(
        (direction === 'CREDIT' ? balanceBefore + amount : balanceBefore - amount).toFixed(2)
      );
      const txType = direction === 'CREDIT' ? WalletTxType.ADJUSTMENT_CREDIT : WalletTxType.ADJUSTMENT_DEBIT;
      const refNumber = `WTX-ADJ-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      // 1. Immutable Ledger Entry
      const ledger = await tx.walletLedgerEntry.create({
        data: {
          walletAccountId: account.id,
          type: txType,
          direction,
          amount,
          currency: account.currency,
          balanceBefore,
          balanceAfter,
          referenceType: 'ADJUSTMENT',
          referenceId: reference || null,
          status: WalletTxStatus.COMPLETED,
          description: `تسوية إدارية (${direction === 'CREDIT' ? 'إيداع' : 'خصم'}): ${reason}`,
          createdBy: adminUserId,
        },
      });

      // 2. Transaction record
      const walletTx = await tx.walletTransaction.create({
        data: {
          walletAccountId: account.id,
          type: txType,
          status: WalletTxStatus.COMPLETED,
          amount,
          currency: account.currency,
          referenceNumber: refNumber,
          externalReference: reference || null,
          description: reason,
          metadata: JSON.stringify({ adminUserId, ledgerEntryId: ledger.id }),
          completedAt: new Date(),
        },
      });

      // 3. Update account balance
      const updatedAccount = await tx.walletAccount.update({
        where: { id: account.id },
        data: { availableBalance: balanceAfter },
      });

      // 4. Audit Log
      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: `WALLET_ADJUSTMENT_${direction}`,
          resource: 'wallet_accounts',
          details: JSON.stringify({
            targetUserId,
            amount,
            direction,
            balanceBefore,
            balanceAfter,
            reason,
            reference,
            transactionId: walletTx.id,
          }),
        },
      });

      return {
        account: updatedAccount,
        transaction: walletTx,
        ledger,
      };
    });
  }

  // ── CUSTOMER WITHDRAWAL FLOW ─────────────────────────────────────────────────

  static async requestWithdrawal(params: { userId: string; savedWalletId: string; amount: number }) {
    const { userId, savedWalletId, amount } = params;
    if (!amount || amount <= 0) throw new AppError('مبلغ السحب يجب أن يكون أكبر من الصفر', 400);
    if (amount < 100) throw new AppError('الحد الأدنى للسحب هو 100 ريال يمني', 400);
    return await prisma.$transaction(async (tx) => {
      const account = await tx.walletAccount.findUnique({ where: { userId } });
      if (!account) throw new AppError('لم يتم العثور على حساب المحفظة', 404);
      const effectiveAvailable = parseFloat((account.availableBalance - account.pendingBalance).toFixed(2));
      if (amount > effectiveAvailable) throw new AppError(`الرصيد المتاح للسحب (${effectiveAvailable.toFixed(0)} ر.ي) غير كافٍ`, 400);
      const savedWallet = await tx.customerSavedWallet.findFirst({ where: { id: savedWalletId, userId } });
      if (!savedWallet) throw new AppError('المحفظة الرقمية المحددة غير موجودة أو لا تخصك', 404);
      if (!savedWallet.walletNumberFull) throw new AppError('يرجى حذف هذه المحفظة وإعادة إضافتها لتفعيل السحب', 400);
      await tx.walletAccount.update({ where: { userId }, data: { pendingBalance: { increment: amount } } });
      const withdrawal = await tx.customerWalletWithdrawal.create({
        data: {
          userId, savedWalletId: savedWallet.id, amount, currency: account.currency || 'YER',
          status: 'PENDING', walletProvider: savedWallet.provider,
          walletNumberMasked: savedWallet.walletNumberMasked, walletNumberFull: savedWallet.walletNumberFull,
          holderName: savedWallet.holderName || null,
        },
      });
      const ref = `WTX-WDR-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
      await tx.walletTransaction.create({
        data: {
          walletAccountId: account.id, type: WalletTxType.WITHDRAWAL_REQUEST, status: WalletTxStatus.PENDING,
          amount, currency: account.currency || 'YER', referenceNumber: ref,
          description: `طلب سحب لمحفظة ${savedWallet.provider} (${savedWallet.walletNumberMasked})`,
          metadata: JSON.stringify({ withdrawalId: withdrawal.id }),
        },
      });
      return withdrawal;
    });
  }

  static async getMyWithdrawals(userId: string) {
    return await prisma.customerWalletWithdrawal.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: {
        id: true, amount: true, currency: true, status: true, walletProvider: true,
        walletNumberMasked: true, holderName: true, adminNote: true, rejectionReason: true,
        proofImageUrl: true, externalRef: true, completedAt: true, createdAt: true,
      },
    });
  }

  static async adminCompleteWithdrawal(params: {
    withdrawalId: string; adminUserId: string; proofImageUrl: string; externalRef?: string; adminNote?: string;
  }) {
    const { withdrawalId, adminUserId, proofImageUrl, externalRef, adminNote } = params;
    return await prisma.$transaction(async (tx) => {
      const wr = await tx.customerWalletWithdrawal.findUnique({ where: { id: withdrawalId } });
      if (!wr) throw new AppError('طلب السحب غير موجود', 404);
      if (wr.status !== 'PENDING' && wr.status !== 'APPROVED') throw new AppError(`لا يمكن إتمام طلب بحالة [${wr.status}]`, 400);
      const account = await tx.walletAccount.findUnique({ where: { userId: wr.userId } });
      if (!account) throw new AppError('حساب المحفظة غير موجود', 404);
      const balanceBefore = account.availableBalance;
      const balanceAfter = parseFloat((balanceBefore - wr.amount).toFixed(2));
      if (balanceAfter < 0) throw new AppError('الرصيد المتاح غير كافٍ', 400);
      await tx.walletLedgerEntry.create({
        data: {
          walletAccountId: account.id, type: WalletTxType.WITHDRAWAL_COMPLETED, direction: 'DEBIT',
          amount: wr.amount, currency: wr.currency, balanceBefore, balanceAfter,
          referenceType: 'WITHDRAWAL', referenceId: wr.id, status: WalletTxStatus.COMPLETED,
          description: `سحب مكتمل لمحفظة ${wr.walletProvider} (${wr.walletNumberMasked})`, createdBy: adminUserId,
        },
      });
      await tx.walletTransaction.updateMany({
        where: { metadata: { contains: wr.id }, type: WalletTxType.WITHDRAWAL_REQUEST, status: WalletTxStatus.PENDING },
        data: { status: WalletTxStatus.COMPLETED, completedAt: new Date(), externalReference: externalRef || null,
          description: `سحب مكتمل — المرجع: ${externalRef || 'غير محدد'}` },
      });
      await tx.walletAccount.update({
        where: { userId: wr.userId },
        data: { availableBalance: balanceAfter, pendingBalance: { decrement: wr.amount } },
      });
      const updated = await tx.customerWalletWithdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'COMPLETED', proofImageUrl, externalRef: externalRef || null,
          adminNote: adminNote || null, assignedAdminId: adminUserId, completedAt: new Date() },
      });
      try {
        notificationEventBus.publish(
          NotificationEventFactory.walletEvent({
            eventType: 'WITHDRAWAL_COMPLETED',
            recipientId: wr.userId,
            amount: wr.amount,
            currency: wr.currency,
            referenceId: wr.id,
            description: `تم تحويل ${wr.amount} ${wr.currency} إلى محفظة ${wr.walletProvider}`,
          })
        );
      } catch (_) {}
      return updated;
    });
  }

  static async adminRejectWithdrawal(params: { withdrawalId: string; adminUserId: string; reason: string }) {
    const { withdrawalId, adminUserId, reason } = params;
    return await prisma.$transaction(async (tx) => {
      const wr = await tx.customerWalletWithdrawal.findUnique({ where: { id: withdrawalId } });
      if (!wr) throw new AppError('طلب السحب غير موجود', 404);
      if (wr.status !== 'PENDING' && wr.status !== 'APPROVED') throw new AppError(`لا يمكن رفض طلب بحالة [${wr.status}]`, 400);
      await tx.walletAccount.update({ where: { userId: wr.userId }, data: { pendingBalance: { decrement: wr.amount } } });
      await tx.walletTransaction.updateMany({
        where: { metadata: { contains: wr.id }, type: WalletTxType.WITHDRAWAL_REQUEST, status: WalletTxStatus.PENDING },
        data: { status: WalletTxStatus.FAILED },
      });
      const updated = await tx.customerWalletWithdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'REJECTED', rejectionReason: reason, adminNote: reason, assignedAdminId: adminUserId },
      });
      try {
        notificationEventBus.publish(
          NotificationEventFactory.walletEvent({
            eventType: 'WITHDRAWAL_REJECTED',
            recipientId: wr.userId,
            amount: wr.amount,
            currency: wr.currency,
            referenceId: wr.id,
            description: reason,
          })
        );
      } catch (_) {}
      return updated;
    });
  }

  /**
   * Debits the customer's internal wallet for an order checkout.
   * Atomically verifies balance, creates immutable DEBIT ledger entry, transaction, and updates available balance.
   */
  static async debitForOrder(
    params: {
      customerId: string;
      orderId: string;
      orderNumber: string;
      amount: number;
      currency?: string;
    },
    txClient?: any
  ) {
    const { customerId, orderId, orderNumber, amount, currency = 'YER' } = params;

    if (amount <= 0) {
      throw new AppError('مبلغ الخصم يجب أن يكون أكبر من الصفر', 400);
    }

    const runner = async (tx: any) => {
      const account = await this.getOrCreateAccount(customerId, tx);

      if (account.availableBalance < amount) {
        throw new AppError(
          `رصيد محفظتك الحالي (${account.availableBalance.toFixed(0)} ${account.currency}) غير كافٍ لإتمام الطلب بقيمة (${amount.toFixed(0)} ${currency})`,
          400
        );
      }

      // Check idempotency
      const existingLedger = await tx.walletLedgerEntry.findFirst({
        where: {
          walletAccountId: account.id,
          referenceType: 'ORDER',
          referenceId: orderId,
          type: WalletTxType.ORDER_PAYMENT,
        },
      });

      if (existingLedger) {
        return {
          alreadyProcessed: true,
          account,
          ledgerEntry: existingLedger,
        };
      }

      const balanceBefore = account.availableBalance;
      const balanceAfter = parseFloat((balanceBefore - amount).toFixed(2));
      const refNumber = `WTX-ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      // 1. Create Ledger Entry
      const ledgerEntry = await tx.walletLedgerEntry.create({
        data: {
          walletAccountId: account.id,
          type: WalletTxType.ORDER_PAYMENT,
          direction: 'DEBIT',
          amount,
          currency: currency || 'YER',
          balanceBefore,
          balanceAfter,
          referenceType: 'ORDER',
          referenceId: orderId,
          status: WalletTxStatus.COMPLETED,
          description: `خصم قيمة الطلب #${orderNumber} من المحفظة الإلكترونية`,
        },
      });

      // 2. Create Wallet Transaction Record
      const walletTx = await tx.walletTransaction.create({
        data: {
          walletAccountId: account.id,
          type: WalletTxType.ORDER_PAYMENT,
          status: WalletTxStatus.COMPLETED,
          amount,
          currency: currency || 'YER',
          referenceNumber: refNumber,
          description: `دفع قيمة الطلب #${orderNumber}`,
          metadata: JSON.stringify({
            orderId,
            orderNumber,
            ledgerEntryId: ledgerEntry.id,
          }),
          completedAt: new Date(),
        },
      });

      // 3. Update cached balance
      const updatedAccount = await tx.walletAccount.update({
        where: { id: account.id },
        data: { availableBalance: balanceAfter },
      });

      return {
        alreadyProcessed: false,
        account: updatedAccount,
        transaction: walletTx,
        ledgerEntry,
      };
    };

    if (txClient) {
      return await runner(txClient);
    } else {
      return await prisma.$transaction(runner);
    }
  }

  /**
   * Directly credits the customer's wallet when an order is cancelled or rejected (without opening a refund process).
   * Atomically creates immutable CREDIT ledger entry and updates available balance.
   */
  static async creditForOrderRefund(
    params: {
      customerId: string;
      orderId: string;
      orderNumber: string;
      amount: number;
      currency?: string;
      reason?: string;
      referenceType?: string;
      adminUserId?: string;
    },
    txClient?: any
  ) {
    const {
      customerId,
      orderId,
      orderNumber,
      amount,
      currency = 'YER',
      reason = 'استرجاع قيمة الطلب للمحفظة',
      referenceType = 'ORDER_CANCEL_REFUND',
      adminUserId,
    } = params;

    if (amount <= 0) {
      return { alreadyProcessed: true, amount: 0 };
    }

    const runner = async (tx: any) => {
      const account = await this.getOrCreateAccount(customerId, tx);

      // Check idempotency for this exact order refund
      const existingLedger = await tx.walletLedgerEntry.findFirst({
        where: {
          walletAccountId: account.id,
          referenceType,
          referenceId: orderId,
          type: WalletTxType.ORDER_REFUND,
        },
      });

      if (existingLedger) {
        return {
          alreadyProcessed: true,
          account,
          ledgerEntry: existingLedger,
        };
      }

      const balanceBefore = account.availableBalance;
      const balanceAfter = parseFloat((balanceBefore + amount).toFixed(2));
      const refNumber = `WTX-CRD-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      // 1. Create Ledger Entry
      const ledgerEntry = await tx.walletLedgerEntry.create({
        data: {
          walletAccountId: account.id,
          type: WalletTxType.ORDER_REFUND,
          direction: 'CREDIT',
          amount,
          currency: currency || 'YER',
          balanceBefore,
          balanceAfter,
          referenceType,
          referenceId: orderId,
          status: WalletTxStatus.COMPLETED,
          description: `استرجاع مالي للطلب #${orderNumber}: ${reason}`,
          createdBy: adminUserId || null,
        },
      });

      // 2. Create Wallet Transaction Record
      const walletTx = await tx.walletTransaction.create({
        data: {
          walletAccountId: account.id,
          type: WalletTxType.ORDER_REFUND,
          status: WalletTxStatus.COMPLETED,
          amount,
          currency: currency || 'YER',
          referenceNumber: refNumber,
          description: `استرجاع رصيد الطلب #${orderNumber}`,
          metadata: JSON.stringify({
            orderId,
            orderNumber,
            reason,
            ledgerEntryId: ledgerEntry.id,
          }),
          completedAt: new Date(),
        },
      });

      // 3. Update cached balance
      const updatedAccount = await tx.walletAccount.update({
        where: { id: account.id },
        data: { availableBalance: balanceAfter },
      });

      // 4. Send centralized domain notification event
      try {
        notificationEventBus.publish(
          NotificationEventFactory.walletEvent({
            eventType: 'WALLET_CREDITED',
            recipientId: customerId,
            amount,
            currency,
            referenceId: orderId,
            description: `استرجاع مبلغ للطلب #${orderNumber} (${reason})`,
          })
        );
      } catch (_) {}

      return {
        alreadyProcessed: false,
        account: updatedAccount,
        transaction: walletTx,
        ledgerEntry,
      };
    };

    if (txClient) {
      return await runner(txClient);
    } else {
      return await prisma.$transaction(runner);
    }
  }
}
