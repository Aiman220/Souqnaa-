/**
 * SOUQNAA Marketplace — Statement Aggregation Service
 * Reporting & document layer that consumes authoritative data from:
 * - Orders & SellerOrders
 * - Tax Engine (OrderTaxSnapshot, RefundTaxRecord)
 * - Commission Engine (Commission, SellerOrder.commissionAmount)
 * - Settlement Engine (Settlement, SettlementItem)
 * - Ledger & Wallet (SellerTransaction, Withdrawal, WalletDeposit)
 * NEVER recalculates historical tax rates, commission percentages, or order prices.
 */

import { prisma } from '../../database/prisma';
import { StatementMath } from './statement-math.util';
import {
  StatementLineItemDto,
  StatementLineType,
  SellerStatementSummary,
  SettlementStatementSummary,
  CommissionStatementSummary,
  TaxStatementSummary,
} from './statement.types';
import { SettlementEngine } from '../settlement/settlement.service';
import { config } from '../../config';
import { AppError } from '../../middleware/error.middleware';

export class StatementAggregationService {
  /**
   * Aggregates authoritative financial activity for a seller in a given period.
   * Produces SELLER_STATEMENT summary and lines.
   */
  public static async aggregateSellerStatement(params: {
    sellerId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<{
    summary: SellerStatementSummary;
    lineItems: StatementLineItemDto[];
    sourceReferences: any;
  }> {
    const currency = config.marketplace.currency || 'YER';

    // 1. Calculate Opening Balance prior to periodStart from SellerTransaction
    const priorTransactions = await prisma.sellerTransaction.findMany({
      where: {
        sellerBalance: { sellerId: params.sellerId },
        createdAt: { lt: params.periodStart },
      },
    });

    let openingBalance = 0;
    for (const tx of priorTransactions) {
      if (tx.type === 'CREDIT') {
        openingBalance = StatementMath.add(openingBalance, tx.amount);
      } else if (tx.type === 'DEBIT' || tx.type === 'WITHDRAWAL' || tx.type === 'REFUND') {
        openingBalance = StatementMath.subtract(openingBalance, tx.amount);
      }
    }

    // 2. Query Orders within the period
    const sellerOrders = await prisma.sellerOrder.findMany({
      where: {
        sellerId: params.sellerId,
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      include: {
        order: { select: { id: true, orderNumber: true, createdAt: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // 3. Query Refunds within the period
    const refunds = await prisma.refundRequest.findMany({
      where: {
        sellerId: params.sellerId,
        status: 'REFUND_COMPLETED',
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      include: {
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // 4. Query Withdrawals within the period
    const withdrawals = await prisma.withdrawal.findMany({
      where: {
        sellerId: params.sellerId,
        status: 'COMPLETED',
        completedAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      orderBy: { completedAt: 'asc' },
    });

    // 5. Query Deposits within the period
    const deposits = await prisma.walletDeposit.findMany({
      where: {
        userId: (await prisma.seller.findUnique({ where: { id: params.sellerId }, select: { userId: true } }))?.userId,
        status: 'APPROVED',
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Compute Metrics using decimal-safe math
    let grossSales = 0;
    let productDiscounts = 0;
    let tax = 0;
    let platformCommission = 0;
    let deliveryAdjustments = 0;
    const lineItems: StatementLineItemDto[] = [];
    let lineIndex = 1;

    const orderIds: string[] = [];
    const sellerOrderIds: string[] = [];

    // Convert Orders into statement lines
    for (const so of sellerOrders) {
      grossSales = StatementMath.add(grossSales, so.subtotal);
      const discount = StatementMath.add(so.voucherDiscountAmount, so.sellerFundedDiscount);
      productDiscounts = StatementMath.add(productDiscounts, discount);
      tax = StatementMath.add(tax, so.taxAmount);
      platformCommission = StatementMath.add(platformCommission, so.commissionAmount);

      const customerDeliveryFee = so.deliveryFee || 0;
      const platformDeliverySubsidy = so.sellerDeliveryReimbursement || 0;
      const totalDeliveryCompensation = StatementMath.add(customerDeliveryFee, platformDeliverySubsidy);
      const sellerContribution = so.sellerShippingContribution || 0;
      deliveryAdjustments = StatementMath.add(deliveryAdjustments, platformDeliverySubsidy);

      const net = StatementMath.subtract(
        StatementMath.add(StatementMath.subtract(so.subtotal, discount), totalDeliveryCompensation),
        so.commissionAmount
      );

      orderIds.push(so.orderId);
      sellerOrderIds.push(so.id);

      const ref = so.sellerOrderNumber || so.order.orderNumber;
      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: so.createdAt,
        reference: ref,
        orderId: so.orderId,
        sellerOrderId: so.id,
        type: StatementLineType.SALE,
        description: `طلب مبيعات ${ref}`,
        grossAmount: so.subtotal,
        discountAmount: discount,
        taxAmount: so.taxAmount,
        commissionAmount: so.commissionAmount,
        adjustmentAmount: platformDeliverySubsidy,
        feeAmount: 0,
        netAmount: net,
        currency,
        status: so.status,
        sourceType: 'SELLER_ORDER',
        sourceId: so.id,
      });

      const shippingPromoDiscount = so.shippingPromotionDiscount || 0;

      // If promotion is platform-funded: record delivery reimbursement line item
      if (platformDeliverySubsidy > 0 && shippingPromoDiscount > 0) {
        lineItems.push({
          lineIndex: lineIndex++,
          transactionDate: so.createdAt,
          reference: `REIMB-${ref}`,
          orderId: so.orderId,
          sellerOrderId: so.id,
          type: StatementLineType.ADJUSTMENT,
          description: 'عرض الشحن المجاني للطلب الأول — تعويض التوصيل',
          grossAmount: platformDeliverySubsidy,
          discountAmount: 0,
          taxAmount: 0,
          commissionAmount: 0,
          adjustmentAmount: platformDeliverySubsidy,
          feeAmount: 0,
          netAmount: platformDeliverySubsidy,
          currency,
          status: 'COMPLETED',
          sourceType: 'DELIVERY_REIMBURSEMENT',
          sourceId: so.id,
        });
      }

      // If promotion is seller-funded: record seller contribution line item
      if (sellerContribution > 0) {
        lineItems.push({
          lineIndex: lineIndex++,
          transactionDate: so.createdAt,
          reference: `CONTRIB-${ref}`,
          orderId: so.orderId,
          sellerOrderId: so.id,
          type: StatementLineType.ADJUSTMENT,
          description: 'عرض الشحن المجاني للطلب الأول — مساهمة البائع',
          grossAmount: 0,
          discountAmount: sellerContribution,
          taxAmount: 0,
          commissionAmount: 0,
          adjustmentAmount: -sellerContribution,
          feeAmount: 0,
          netAmount: -sellerContribution,
          currency,
          status: 'COMPLETED',
          sourceType: 'SELLER_CONTRIBUTION',
          sourceId: so.id,
        });
      }
    }

    // Convert Refunds into statement lines
    let totalRefunds = 0;
    const refundIds: string[] = [];
    for (const r of refunds) {
      const refundAmt = r.approvedAmount || 0;
      totalRefunds = StatementMath.add(totalRefunds, refundAmt);
      refundIds.push(r.id);

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: r.createdAt,
        reference: `REF-${r.id.slice(0, 8).toUpperCase()}`,
        orderId: r.orderId,
        sellerOrderId: r.sellerOrderId || undefined,
        type: StatementLineType.REFUND,
        description: `استرجاع مالي للطلب ${r.order?.orderNumber || ''}`,
        grossAmount: 0,
        discountAmount: 0,
        taxAmount: 0,
        commissionAmount: 0,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: -refundAmt,
        currency,
        status: 'COMPLETED',
        sourceType: 'REFUND_REQUEST',
        sourceId: r.id,
      });
    }

    // Convert Withdrawals into statement lines
    let totalWithdrawals = 0;
    for (const w of withdrawals) {
      totalWithdrawals = StatementMath.add(totalWithdrawals, w.amount);

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: w.completedAt || w.createdAt,
        reference: w.externalRef || `WTH-${w.id.slice(0, 8).toUpperCase()}`,
        type: StatementLineType.WITHDRAWAL,
        description: `سحب أرباح إلى محفظة ${w.walletProvider || 'بنكية'}`,
        grossAmount: 0,
        discountAmount: 0,
        taxAmount: 0,
        commissionAmount: 0,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: -w.amount,
        currency,
        status: 'COMPLETED',
        sourceType: 'WITHDRAWAL',
        sourceId: w.id,
      });
    }

    // Convert Deposits into statement lines
    let totalDeposits = 0;
    for (const d of deposits) {
      totalDeposits = StatementMath.add(totalDeposits, d.amount);

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: d.createdAt,
        reference: d.transferReference || `DEP-${d.id.slice(0, 8).toUpperCase()}`,
        type: StatementLineType.ADJUSTMENT,
        description: `إيداع رصيد بالمحفظة (${d.walletProvider})`,
        grossAmount: d.amount,
        discountAmount: 0,
        taxAmount: 0,
        commissionAmount: 0,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: d.amount,
        currency,
        status: 'COMPLETED',
        sourceType: 'WALLET_DEPOSIT',
        sourceId: d.id,
      });
    }

    const netActivity = StatementMath.add(
      StatementMath.subtract(
        StatementMath.subtract(
          StatementMath.subtract(
            StatementMath.add(
              StatementMath.subtract(grossSales, productDiscounts),
              deliveryAdjustments
            ),
            totalRefunds
          ),
          platformCommission
        ),
        totalWithdrawals
      ),
      totalDeposits
    );

    const closingBalance = StatementMath.add(openingBalance, netActivity);

    const summary: SellerStatementSummary = {
      openingBalance,
      grossSales,
      productDiscounts,
      refunds: totalRefunds,
      tax,
      platformCommission,
      paymentFees: 0,
      deliveryAdjustments,
      otherAuthorizedAdjustments: 0,
      withdrawals: totalWithdrawals,
      deposits: totalDeposits,
      netActivity,
      closingBalance,
      totalOrdersCount: sellerOrders.length,
      totalRefundsCount: refunds.length,
    };

    return {
      summary,
      lineItems,
      sourceReferences: {
        orderIds,
        sellerOrderIds,
        transactionIds: [],
        taxSnapshotIds: [],
        refundIds,
        settlementId: null,
      },
    };
  }

  /**
   * Aggregates authoritative SETTLEMENT_STATEMENT data from SettlementEngine.
   */
  public static async aggregateSettlementStatement(settlementId: string): Promise<{
    summary: SettlementStatementSummary;
    lineItems: StatementLineItemDto[];
    sourceReferences: any;
    sellerId: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
  }> {
    const settlement = await SettlementEngine.getSettlementById(settlementId);
    const currency = settlement.currency || config.marketplace.currency || 'YER';

    const lineItems: StatementLineItemDto[] = settlement.items.map((it, idx) => ({
      lineIndex: idx + 1,
      transactionDate: it.orderDate,
      reference: it.orderNumber || `ORD-${(it.orderId || '').slice(0, 8)}`,
      orderId: it.orderId || undefined,
      sellerOrderId: it.sellerOrderId || undefined,
      type: StatementLineType.SALE,
      description: `تسوية طلب ${it.orderNumber || ''}`,
      grossAmount: it.grossSales,
      discountAmount: it.discount,
      taxAmount: it.tax,
      commissionAmount: it.commission,
      adjustmentAmount: 0,
      feeAmount: it.otherFees,
      netAmount: it.netSellerAmount,
      currency,
      status: settlement.status,
      sourceType: 'SETTLEMENT_ITEM',
      sourceId: it.id,
    }));

    const summary: SettlementStatementSummary = {
      settlementNumber: settlement.settlementNumber,
      settlementId: settlement.id,
      settlementDate: settlement.settlementDate,
      grossSales: settlement.grossSales,
      productDiscounts: settlement.discounts,
      refunds: settlement.refunds,
      platformCommission: settlement.commissionAmount,
      paymentFees: settlement.feeAmount,
      authorizedAdjustments: settlement.authorizedAdjustments,
      taxAdjustments: settlement.taxAdjustments,
      netSettlement: settlement.netSettlementAmount,
      settlementStatus: settlement.status,
      paymentReference: settlement.paymentReference,
      totalOrdersCount: settlement.items.length,
    };

    return {
      summary,
      lineItems,
      sourceReferences: {
        orderIds: settlement.items.map((i) => i.orderId).filter(Boolean) as string[],
        sellerOrderIds: settlement.items.map((i) => i.sellerOrderId).filter(Boolean) as string[],
        transactionIds: [],
        taxSnapshotIds: [],
        refundIds: [],
        settlementId: settlement.id,
      },
      sellerId: settlement.sellerId,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      currency,
    };
  }

  /**
   * Aggregates authoritative COMMISSION_STATEMENT data from CommissionEngine and SellerOrders.
   */
  public static async aggregateCommissionStatement(params: {
    sellerId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<{
    summary: CommissionStatementSummary;
    lineItems: StatementLineItemDto[];
    sourceReferences: any;
  }> {
    const currency = config.marketplace.currency || 'YER';

    const sellerOrders = await prisma.sellerOrder.findMany({
      where: {
        sellerId: params.sellerId,
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      include: {
        order: { select: { id: true, orderNumber: true, createdAt: true } },
        items: {
          include: {
            product: { select: { nameAr: true, commissionRate: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let grossSales = 0;
    let eligibleSales = 0;
    let totalCommissionBase = 0;
    let totalCommissionAmount = 0;
    const lineItems: StatementLineItemDto[] = [];
    let lineIndex = 1;

    for (const so of sellerOrders) {
      grossSales = StatementMath.add(grossSales, so.subtotal);
      const discount = StatementMath.add(so.voucherDiscountAmount, so.sellerFundedDiscount);
      const base = Math.max(0, StatementMath.subtract(so.subtotal, discount));
      eligibleSales = StatementMath.add(eligibleSales, base);
      totalCommissionBase = StatementMath.add(totalCommissionBase, base);
      totalCommissionAmount = StatementMath.add(totalCommissionAmount, so.commissionAmount);

      const effectiveRate = base > 0 ? StatementMath.divide(so.commissionAmount, base) : 0;

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: so.createdAt,
        reference: so.sellerOrderNumber || so.order.orderNumber,
        orderId: so.orderId,
        sellerOrderId: so.id,
        type: StatementLineType.COMMISSION,
        description: `عمولة منصة سوقناا عن الطلب ${so.sellerOrderNumber || so.order.orderNumber}`,
        grossAmount: so.subtotal,
        discountAmount: discount,
        taxAmount: 0,
        commissionAmount: so.commissionAmount,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: so.commissionAmount,
        currency,
        status: so.status,
        sourceType: 'SELLER_ORDER',
        sourceId: so.id,
        metadata: {
          commissionBase: base,
          commissionRate: effectiveRate,
        },
      });
    }

    const effectiveCommissionRate = totalCommissionBase > 0
      ? StatementMath.divide(totalCommissionAmount, totalCommissionBase)
      : (config.marketplace.defaultCommissionRate || 0.10);

    const summary: CommissionStatementSummary = {
      grossSales,
      eligibleSales,
      commissionBase: totalCommissionBase,
      effectiveCommissionRate,
      commissionAmount: totalCommissionAmount,
      commissionAdjustments: 0,
      taxOnCommission: 0,
      totalCommission: totalCommissionAmount,
      totalOrdersCount: sellerOrders.length,
    };

    return {
      summary,
      lineItems,
      sourceReferences: {
        orderIds: sellerOrders.map((so) => so.orderId),
        sellerOrderIds: sellerOrders.map((so) => so.id),
        transactionIds: [],
        taxSnapshotIds: [],
        refundIds: [],
        settlementId: null,
      },
    };
  }

  /**
   * Aggregates authoritative TAX_STATEMENT data from Tax Engine snapshots.
   */
  public static async aggregateTaxStatement(params: {
    sellerId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<{
    summary: TaxStatementSummary;
    lineItems: StatementLineItemDto[];
    sourceReferences: any;
  }> {
    const currency = config.marketplace.currency || 'YER';

    // 1. Query OrderTaxSnapshots for this seller in the period
    const taxSnapshots = await prisma.orderTaxSnapshot.findMany({
      where: {
        sellerId: params.sellerId,
        calculatedAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      include: {
        order: { select: { id: true, orderNumber: true } },
        taxRule: { select: { name: true, code: true } },
      },
      orderBy: { calculatedAt: 'asc' },
    });

    // 2. Query RefundTaxRecords for this seller in the period
    const refundTaxRecords = await prisma.refundTaxRecord.findMany({
      where: {
        order: { sellerOrders: { some: { sellerId: params.sellerId } } },
        createdAt: { gte: params.periodStart, lte: params.periodEnd },
      },
      include: {
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    let grossTaxableSales = 0;
    let taxExemptSales = 0;
    let zeroRatedSales = 0;
    let taxableAmount = 0;
    let taxCollected = 0;

    const lineItems: StatementLineItemDto[] = [];
    let lineIndex = 1;
    const taxSnapshotIds: string[] = [];

    for (const snap of taxSnapshots) {
      taxSnapshotIds.push(snap.id);
      if (snap.taxRate === 0) {
        zeroRatedSales = StatementMath.add(zeroRatedSales, snap.taxableAmount);
      } else {
        grossTaxableSales = StatementMath.add(grossTaxableSales, snap.taxableAmount);
        taxableAmount = StatementMath.add(taxableAmount, snap.taxableAmount);
        taxCollected = StatementMath.add(taxCollected, snap.taxAmount);
      }

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: snap.calculatedAt,
        reference: snap.order?.orderNumber || `TAX-${snap.id.slice(0, 8)}`,
        orderId: snap.orderId,
        sellerOrderId: snap.sellerOrderId || undefined,
        type: StatementLineType.TAX,
        description: `بند ضريبي (${snap.taxName})`,
        grossAmount: snap.taxableAmount,
        discountAmount: snap.discountAmount,
        taxAmount: snap.taxAmount,
        commissionAmount: 0,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: snap.taxAmount,
        currency: snap.currency || currency,
        status: 'COMPLETED',
        sourceType: 'ORDER_TAX_SNAPSHOT',
        sourceId: snap.id,
        metadata: {
          taxRuleId: snap.taxRuleId,
          taxRuleVersion: snap.taxRuleVersion,
          taxRate: snap.taxRate,
          taxJurisdiction: config.marketplace.taxJurisdiction || 'YEMEN_GENERAL',
        },
      });
    }

    let taxRefunded = 0;
    for (const ref of refundTaxRecords) {
      taxRefunded = StatementMath.add(taxRefunded, ref.refundedTax);

      lineItems.push({
        lineIndex: lineIndex++,
        transactionDate: ref.createdAt,
        reference: `REF-TAX-${ref.id.slice(0, 8)}`,
        orderId: ref.orderId,
        sellerOrderId: ref.sellerOrderId || undefined,
        type: StatementLineType.REFUND,
        description: `استرجاع ضريبة للطلب ${ref.order?.orderNumber || ''}`,
        grossAmount: 0,
        discountAmount: 0,
        taxAmount: -ref.refundedTax,
        commissionAmount: 0,
        adjustmentAmount: 0,
        feeAmount: 0,
        netAmount: -ref.refundedTax,
        currency,
        status: 'COMPLETED',
        sourceType: 'REFUND_TAX_RECORD',
        sourceId: ref.id,
      });
    }

    const netTax = StatementMath.subtract(taxCollected, taxRefunded);

    const summary: TaxStatementSummary = {
      grossTaxableSales,
      taxExemptSales,
      zeroRatedSales,
      taxableAmount,
      taxCollected,
      taxRefunded,
      netTax,
      totalTransactionsCount: taxSnapshots.length + refundTaxRecords.length,
    };

    return {
      summary,
      lineItems,
      sourceReferences: {
        orderIds: taxSnapshots.map((t) => t.orderId),
        sellerOrderIds: taxSnapshots.map((t) => t.sellerOrderId).filter(Boolean) as string[],
        transactionIds: [],
        taxSnapshotIds,
        refundIds: refundTaxRecords.map((r) => r.refundId),
        settlementId: null,
      },
    };
  }
}
