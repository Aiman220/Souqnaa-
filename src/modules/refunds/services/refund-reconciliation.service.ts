import { prisma } from '../../../database/prisma';
import { RefundStatus, ManualTransferStatus, WalletTxStatus, WalletTxType } from '@prisma/client';

export interface ReconciliationAnomaly {
  type:
    | 'REFUND_WITHOUT_EXECUTION'
    | 'WALLET_CREDITED_REFUND_INCOMPLETE'
    | 'MANUAL_TRANSFER_MISSING_PROOF'
    | 'MANUAL_TRANSFER_MISSING_REFERENCE'
    | 'REFUND_EXCEEDS_ORDER_TOTAL'
    | 'DUPLICATE_WALLET_CREDIT'
    | 'SELLER_DEBT_INVARIANT_VIOLATION'
    | 'MARKETPLACE_EXPOSURE_INVARIANT_VIOLATION'
    | 'NEGATIVE_WALLET_BALANCE'
    | 'REFUND_UNBACKED_BY_VERIFIED_PAYMENT';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  refundId?: string;
  refundNumber?: string;
  orderId?: string;
  orderNumber?: string;
  sellerId?: string;
  descriptionAr: string;
  descriptionEn: string;
  details: Record<string, any>;
}

export class RefundReconciliationService {
  /**
   * Evaluates double-entry ledger equilibrium.
   */
  public static reconcileLedgerBalance(credits: number, debits: number): {
    isBalanced: boolean;
    discrepancy: number;
  } {
    const diff = Math.abs(credits - debits);
    return {
      isBalanced: diff < 0.01,
      discrepancy: diff,
    };
  }

  /**
   * Scans all refunds, manual transfers, and wallet ledger records for financial discrepancies.
   */
  static async runReconciliationAudit(): Promise<{
    timestamp: Date;
    totalRefundsChecked: number;
    anomaliesFound: number;
    anomalies: ReconciliationAnomaly[];
  }> {
    const anomalies: ReconciliationAnomaly[] = [];

    // 1. Check all completed refunds
    const completedRefunds = await prisma.refundRequest.findMany({
      where: {
        status: { in: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUNDED] },
      },
      include: {
        order: { include: { payment: true } },
        manualTransfer: { include: { proofs: true } },
        walletTransactions: true,
        executionLock: true,
      },
    });

    for (const r of completedRefunds) {
      const hasWalletCredit = r.walletTransactions.some(
        (wt) => wt.type === WalletTxType.REFUND_CREDIT && wt.status === WalletTxStatus.COMPLETED
      );
      const hasCompletedManualTransfer =
        r.manualTransfer && r.manualTransfer.status === ManualTransferStatus.COMPLETED;

      // Completed refund must have an execution record
      if (!hasWalletCredit && !hasCompletedManualTransfer) {
        anomalies.push({
          type: 'REFUND_WITHOUT_EXECUTION',
          severity: 'CRITICAL',
          refundId: r.id,
          refundNumber: r.refundNumber,
          orderId: r.orderId,
          orderNumber: r.order.orderNumber,
          descriptionAr: `طلب الاسترجاع #${r.refundNumber} مسجل كمكتمل، ولكن لا يوجد قيد إيداع في محفظة العميل أو حوالة يدوية مكتملة`,
          descriptionEn: `Refund #${r.refundNumber} is marked completed but has neither wallet credit nor completed manual transfer`,
          details: { refundStatus: r.status, requestedAmount: r.requestedAmount, approvedAmount: r.approvedAmount },
        });
      }

      // Check manual transfer proof & reference integrity
      if (r.manualTransfer && r.manualTransfer.status === ManualTransferStatus.COMPLETED) {
        if (!r.manualTransfer.proofs || r.manualTransfer.proofs.length === 0) {
          anomalies.push({
            type: 'MANUAL_TRANSFER_MISSING_PROOF',
            severity: 'CRITICAL',
            refundId: r.id,
            refundNumber: r.refundNumber,
            orderId: r.orderId,
            orderNumber: r.order.orderNumber,
            descriptionAr: `التحويل اليدوي للطلب #${r.refundNumber} مكتمل بدون إرفاق سند أو إشعار بنكي رسمي`,
            descriptionEn: `Manual transfer for refund #${r.refundNumber} was marked completed without official proof attached`,
            details: { transferId: r.manualTransfer.id, walletProvider: r.manualTransfer.walletProvider },
          });
        }
        if (!r.manualTransfer.externalTransactionReference) {
          anomalies.push({
            type: 'MANUAL_TRANSFER_MISSING_REFERENCE',
            severity: 'HIGH',
            refundId: r.id,
            refundNumber: r.refundNumber,
            orderId: r.orderId,
            orderNumber: r.order.orderNumber,
            descriptionAr: `التحويل اليدوي للطلب #${r.refundNumber} مكتمل بدون رقم مرجع الحوالة البنكية`,
            descriptionEn: `Manual transfer for refund #${r.refundNumber} was completed without external reference number`,
            details: { transferId: r.manualTransfer.id },
          });
        }
      }

      // Check total refunded on order vs order total
      if (r.order) {
        const allCompletedForOrder = await prisma.refundRequest.findMany({
          where: {
            orderId: r.orderId,
            status: { in: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUNDED] },
          },
          select: { approvedAmount: true, requestedAmount: true },
        });

        const totalRefundedSum = allCompletedForOrder.reduce(
          (sum, ref) => sum + (ref.approvedAmount ?? ref.requestedAmount),
          0
        );

        if (totalRefundedSum > r.order.total + 0.01) {
          anomalies.push({
            type: 'REFUND_EXCEEDS_ORDER_TOTAL',
            severity: 'CRITICAL',
            refundId: r.id,
            refundNumber: r.refundNumber,
            orderId: r.orderId,
            orderNumber: r.order.orderNumber,
            descriptionAr: `إجمالي المبالغ المستردة (${totalRefundedSum}) يتجاوز إجمالي قيمة الطلب الأصلية (${r.order.total})`,
            descriptionEn: `Total refunded amount (${totalRefundedSum}) exceeds captured order total (${r.order.total})`,
            details: { totalRefundedSum, orderTotal: r.order.total },
          });
        }
      }
    }

    // 2. Check for duplicate wallet credits on same refund
    const duplicateCredits = await prisma.walletTransaction.groupBy({
      by: ['refundId'],
      where: {
        type: WalletTxType.REFUND_CREDIT,
        status: WalletTxStatus.COMPLETED,
        refundId: { not: null },
      },
      _count: {
        id: true,
      },
      having: {
        id: {
          _count: {
            gt: 1,
          },
        },
      },
    });

    for (const dup of duplicateCredits) {
      if (dup.refundId) {
        anomalies.push({
          type: 'DUPLICATE_WALLET_CREDIT',
          severity: 'CRITICAL',
          refundId: dup.refundId,
          descriptionAr: `تم رصد قيد إيداع مكرر في المحفظة لنفس طلب الاسترجاع [${dup.refundId}]`,
          descriptionEn: `Duplicate wallet credit detected for refund [${dup.refundId}]`,
          details: { occurrences: dup._count.id },
        });
      }
    }

    // 3. Mathematical Invariant Verification: Outstanding Seller Debt
    // Invariant: Remaining = Amount - PaidAmount across all liability records
    const allOutstandings = await prisma.sellerOutstanding.findMany({
      select: { id: true, sellerId: true, amount: true, paidAmount: true, remainingAmount: true, status: true },
    });

    for (const out of allOutstandings) {
      const expectedRemaining = Math.max(0, parseFloat((out.amount - out.paidAmount).toFixed(2)));
      const actualRemaining = parseFloat(out.remainingAmount.toFixed(2));
      if (Math.abs(expectedRemaining - actualRemaining) > 0.05) {
        anomalies.push({
          type: 'SELLER_DEBT_INVARIANT_VIOLATION',
          severity: 'HIGH',
          sellerId: out.sellerId,
          descriptionAr: `خلل في معادلة المديونية للمطالبة [${out.id}]: الأصل (${out.amount}) - المسدد (${out.paidAmount}) لا يساوي المتبقي (${out.remainingAmount})`,
          descriptionEn: `Mathematical debt conservation violated in liability record [${out.id}]`,
          details: { id: out.id, amount: out.amount, paidAmount: out.paidAmount, remainingAmount: out.remainingAmount, expectedRemaining },
        });
      }
    }

    // 4. Invariant: Seller Available Balances must NEVER be negative
    const negativeBalances = await prisma.sellerBalance.findMany({
      where: { availableBalance: { lt: -0.01 } },
      select: { id: true, sellerId: true, availableBalance: true },
    });

    for (const nb of negativeBalances) {
      anomalies.push({
        type: 'NEGATIVE_WALLET_BALANCE',
        severity: 'CRITICAL',
        sellerId: nb.sellerId,
        descriptionAr: `رصيد المحفظة المتاح سالب (${nb.availableBalance} ر.ي) للتاجر [${nb.sellerId}]، وهو ما يخالف قواعد النزاهة المحاسبية`,
        descriptionEn: `Negative wallet balance detected (${nb.availableBalance}) for seller [${nb.sellerId}]`,
        details: { sellerBalanceId: nb.id, availableBalance: nb.availableBalance },
      });
    }

    return {
      timestamp: new Date(),
      totalRefundsChecked: completedRefunds.length,
      anomaliesFound: anomalies.length,
      anomalies,
    };
  }
}
