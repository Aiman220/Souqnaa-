/**
 * SOUQNAA Marketplace — Authoritative Settlement Engine
 * Manages seller settlement calculation, order item linking, settlement lifecycle
 * (PENDING -> PROCESSING -> COMPLETED / FAILED / REVERSED / CANCELLED), risk-based
 * reserve retention (10% baseline / 30-day holding), and automatic debt recovery.
 * Version: 2.1.0
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { SettlementStatus, SellerOrderStatus } from '@prisma/client';
import { TaxMath } from '../tax/tax.math';
import { config } from '../../config';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { SellerReserveService } from '../commission/seller-reserve.service';
import { remoteConfigService } from '../remote-config/remote-config.service';

export interface CreateSettlementInput {
  sellerId: string;
  periodStart: Date;
  periodEnd: Date;
  orderIds?: string[]; // Specific sub-order IDs or all eligible completed orders in the period
  payoutMethod?: string;
  paymentReference?: string;
  notes?: string;
}

export interface TransitionSettlementStatusInput {
  settlementId: string;
  targetStatus: SettlementStatus;
  actorId?: string;
  paymentReference?: string;
  withdrawalId?: string;
  notes?: string;
}

export class SettlementEngine {
  public static readonly VERSION = '2.1.0';

  /**
   * Generates a unique, concurrency-safe Settlement Number: SET-YYYY-XXXXXX
   */
  public static async generateSettlementNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await prisma.settlement.count({
      where: {
        createdAt: {
          gte: new Date(`${year}-01-01T00:00:00.000Z`),
          lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
        },
      },
    });
    let seqNum = count + 1;
    let candidate = `SET-${year}-${String(seqNum).padStart(6, '0')}`;
    while (await prisma.settlement.findUnique({ where: { settlementNumber: candidate } })) {
      seqNum++;
      candidate = `SET-${year}-${String(seqNum).padStart(6, '0')}`;
    }
    return candidate;
  }

  /**
   * Authoritative calculation and creation of a seller settlement.
   * Consumes completed/delivered SellerOrders and calculates risk-based reserve and debt recovery.
   */
  public static async createSettlement(input: CreateSettlementInput) {
    const seller = await prisma.seller.findUnique({
      where: { id: input.sellerId },
      include: { stores: true },
    });
    if (!seller) throw new AppError('البائع غير موجود', 404);

    const currency = config.marketplace.currency || 'YER';

    // 1. Find eligible delivered seller orders within the period that haven't been settled yet
    const orderWhere: any = {
      sellerId: input.sellerId,
      status: SellerOrderStatus.DELIVERED,
      createdAt: {
        gte: input.periodStart,
        lte: input.periodEnd,
      },
    };

    if (input.orderIds && input.orderIds.length > 0) {
      orderWhere.id = { in: input.orderIds };
    }

    const sellerOrders = await prisma.sellerOrder.findMany({
      where: orderWhere,
      include: {
        order: { select: { id: true, orderNumber: true, createdAt: true } },
        refundRequests: { where: { status: 'REFUND_COMPLETED' } },
        settlementItems: true,
      },
    });

    // Filter out orders that already belong to an active/completed settlement
    const eligibleOrders = sellerOrders.filter(
      (so) => !so.settlementItems || so.settlementItems.length === 0
    );

    let grossSales = 0;
    let discounts = 0;
    let refunds = 0;
    let commissionAmount = 0;
    let taxAdjustments = 0;
    let feeAmount = 0;
    let deliveryReimbursementTotal = 0;
    let sellerShippingContributionTotal = 0;
    let netSettlementAmount = 0;

    const itemsData: Array<{
      sellerOrderId: string;
      orderId: string;
      orderNumber: string;
      orderDate: Date;
      grossSales: number;
      discount: number;
      refund: number;
      tax: number;
      commission: number;
      otherFees: number;
      originalDeliveryFee: number;
      deliveryReimbursement: number;
      sellerShippingContribution: number;
      netSellerAmount: number;
      currency: string;
    }> = [];

    for (const so of eligibleOrders) {
      const orderGross = so.subtotal;
      const orderDiscount = Number(so.sellerFundedDiscount || 0);
      const orderTax = so.taxAmount;
      const orderCommission = so.commissionAmount;
      const orderRefund = (so.refundRequests || []).reduce(
        (sum, r) => TaxMath.add(sum, r.approvedAmount || 0),
        0
      );

      // Authoritative Delivery Reimbursement & Seller Contribution
      const originalDeliveryFee = so.originalDeliveryFee ?? so.deliveryFee ?? 0;
      const customerDeliveryFee = so.deliveryFee ?? 0;
      const platformDeliverySubsidy = so.sellerDeliveryReimbursement ?? 0;
      const totalDeliveryCompensation = TaxMath.add(customerDeliveryFee, platformDeliverySubsidy);
      const sellerShippingContribution = so.sellerShippingContribution ?? 0;

      // Net Seller Settlement per order:
      // Product Subtotal - Seller Funded Discounts - Commission + Delivery Compensation - Refunds
      const orderNet = Math.max(
        0,
        TaxMath.subtract(
          TaxMath.add(
            TaxMath.subtract(TaxMath.subtract(orderGross, orderDiscount), orderCommission),
            totalDeliveryCompensation
          ),
          orderRefund
        )
      );

      grossSales = TaxMath.add(grossSales, orderGross);
      discounts = TaxMath.add(discounts, orderDiscount);
      refunds = TaxMath.add(refunds, orderRefund);
      commissionAmount = TaxMath.add(commissionAmount, orderCommission);
      taxAdjustments = TaxMath.add(taxAdjustments, orderTax);
      deliveryReimbursementTotal = TaxMath.add(deliveryReimbursementTotal, platformDeliverySubsidy);
      sellerShippingContributionTotal = TaxMath.add(sellerShippingContributionTotal, sellerShippingContribution);
      netSettlementAmount = TaxMath.add(netSettlementAmount, orderNet);

      itemsData.push({
        sellerOrderId: so.id,
        orderId: so.orderId,
        orderNumber: so.order.orderNumber,
        orderDate: so.order.createdAt,
        grossSales: orderGross,
        discount: orderDiscount,
        refund: orderRefund,
        tax: orderTax,
        commission: orderCommission,
        otherFees: 0,
        originalDeliveryFee,
        deliveryReimbursement: platformDeliverySubsidy,
        sellerShippingContribution,
        netSellerAmount: orderNet,
        currency,
      });
    }

    // 2. Risk-Based Reserve Calculation
    const thresholds = await SellerFinancialRiskService.getRiskThresholds();
    const riskProfile = await prisma.sellerRiskProfile.findUnique({
      where: { sellerId: input.sellerId },
    });

    const isRiskReserveActive = await remoteConfigService.isFeatureActive('seller_risk_based_reserve_enabled');
    const reserveRate = isRiskReserveActive
      ? (riskProfile?.reservePercentage ?? thresholds.baseReservePercentage)
      : 0;

    const reserveAmount = parseFloat((netSettlementAmount * reserveRate).toFixed(2));
    const availableForDebtRecovery = Math.max(0, netSettlementAmount - reserveAmount);

    // 3. Collectible Debt Recovery Calculation
    let debtRecoveredAmount = 0;
    const isAutoDebtRecoveryActive = await remoteConfigService.isFeatureActive('seller_automatic_debt_recovery_enabled');

    if (isAutoDebtRecoveryActive && availableForDebtRecovery > 0) {
      const openDebts = await prisma.sellerOutstanding.findMany({
        where: { sellerId: input.sellerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        orderBy: { createdAt: 'asc' },
      });

      let remainingCapacity = availableForDebtRecovery;
      for (const debt of openDebts) {
        if (remainingCapacity <= 0) break;
        const toRecover = Math.min(remainingCapacity, debt.remainingAmount);
        debtRecoveredAmount = TaxMath.add(debtRecoveredAmount, toRecover);
        remainingCapacity -= toRecover;
      }
    }

    // Remaining Payable Settlement
    const payableSettlementAmount = Math.max(
      0,
      TaxMath.subtract(TaxMath.subtract(netSettlementAmount, reserveAmount), debtRecoveredAmount)
    );

    const settlementNumber = await this.generateSettlementNumber();

    return await prisma.$transaction(async (tx) => {
      const settlement = await tx.settlement.create({
        data: {
          settlementNumber,
          sellerId: input.sellerId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          settlementDate: new Date(),
          currency,
          status: SettlementStatus.PENDING,
          grossSales,
          discounts,
          refunds,
          commissionAmount,
          taxAdjustments,
          feeAmount,
          authorizedAdjustments: 0,
          deliveryReimbursementTotal,
          sellerShippingContributionTotal,
          netSettlementAmount,
          reserveAmount,
          debtRecoveredAmount,
          payableSettlementAmount,
          payoutMethod: input.payoutMethod || 'WALLET',
          paymentReference: input.paymentReference,
          notes: input.notes,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
          seller: { include: { stores: true } },
        },
      });

      return settlement;
    });
  }

  /**
   * Retrieves authoritative settlement by ID
   */
  public static async getSettlementById(settlementId: string) {
    const settlement = await prisma.settlement.findUnique({
      where: { id: settlementId },
      include: {
        items: true,
        seller: {
          include: {
            stores: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          },
        },
        statements: true,
        reserveAllocations: true,
        debtRecoveryAllocations: true,
      },
    });

    if (!settlement) throw new AppError('التسوية غير موجودة', 404);
    return settlement;
  }

  /**
   * Transitions settlement through lifecycle:
   * PENDING -> PROCESSING -> COMPLETED / FAILED / REVERSED / CANCELLED.
   * Atomically executes reserve hold, debt recovery, and net payout upon COMPLETED.
   */
  public static async transitionStatus(input: TransitionSettlementStatusInput) {
    const settlement = await prisma.settlement.findUnique({
      where: { id: input.settlementId },
    });
    if (!settlement) throw new AppError('التسوية غير موجودة', 404);

    // Validate lifecycle transitions
    const validTransitions: Record<SettlementStatus, SettlementStatus[]> = {
      PENDING: [SettlementStatus.PROCESSING, SettlementStatus.CANCELLED, SettlementStatus.FAILED],
      PROCESSING: [SettlementStatus.COMPLETED, SettlementStatus.FAILED, SettlementStatus.CANCELLED],
      COMPLETED: [SettlementStatus.REVERSED],
      FAILED: [SettlementStatus.PROCESSING, SettlementStatus.CANCELLED],
      REVERSED: [],
      CANCELLED: [],
    };

    if (!validTransitions[settlement.status].includes(input.targetStatus)) {
      throw new AppError(
        `لا يمكن تحويل حالة التسوية من ${settlement.status} إلى ${input.targetStatus}`,
        400
      );
    }

    const updateData: any = {
      status: input.targetStatus,
      updatedAt: new Date(),
    };

    if (input.targetStatus === SettlementStatus.COMPLETED) {
      updateData.processedAt = new Date();
      if (input.paymentReference) updateData.paymentReference = input.paymentReference;
      if (input.withdrawalId) updateData.withdrawalId = input.withdrawalId;

      return await prisma.$transaction(async (tx) => {
        // 1. Allocate Reserve if reserveAmount > 0
        if (settlement.reserveAmount > 0) {
          const riskProfile = await tx.sellerRiskProfile.findUnique({
            where: { sellerId: settlement.sellerId },
          });
          const holdingDays = riskProfile?.reserveHoldingDays ?? 30;
          const riskTier = riskProfile?.riskTier ?? 'NORMAL';
          const reservePercentage = settlement.netSettlementAmount > 0
            ? settlement.reserveAmount / settlement.netSettlementAmount
            : 0.10;

          await SellerReserveService.allocateReserveFromSettlement(tx, {
            sellerId: settlement.sellerId,
            settlementId: settlement.id,
            eligibleSettlementAmount: settlement.netSettlementAmount,
            reservePercentage,
            holdingDays,
            riskTier,
            currency: settlement.currency,
          });
        }

        // 2. Recover confirmed debt if debtRecoveredAmount > 0
        if (settlement.debtRecoveredAmount > 0) {
          const openDebts = await tx.sellerOutstanding.findMany({
            where: { sellerId: settlement.sellerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
            orderBy: { createdAt: 'asc' },
          });

          let unrecovered = settlement.debtRecoveredAmount;
          for (const debt of openDebts) {
            if (unrecovered <= 0) break;
            const toPay = Math.min(unrecovered, debt.remainingAmount);
            const newPaid = debt.paidAmount + toPay;
            const newRemaining = debt.remainingAmount - toPay;
            const newStatus = newRemaining <= 0.001 ? 'PAID' : 'PARTIALLY_PAID';

            await tx.sellerOutstanding.update({
              where: { id: debt.id },
              data: {
                paidAmount: newPaid,
                remainingAmount: Math.max(0, newRemaining),
                status: newStatus,
              },
            });

            await tx.debtRecoveryAllocation.create({
              data: {
                sellerId: settlement.sellerId,
                settlementId: settlement.id,
                outstandingId: debt.id,
                amount: toPay,
                currency: settlement.currency,
                recoveredFrom: 'SETTLEMENT',
                transactionRef: settlement.settlementNumber,
                notes: `استقطاع سداد مديونية تلقائي من تسوية الطلبات #${settlement.settlementNumber}`,
              },
            });

            const sellerBal = await tx.sellerBalance.findUnique({
              where: { sellerId: settlement.sellerId },
            });
            if (sellerBal) {
              await tx.sellerTransaction.create({
                data: {
                  sellerBalanceId: sellerBal.id,
                  amount: toPay,
                  type: 'OUTSTANDING_PAYMENT',
                  referenceId: settlement.id,
                  description: `سداد مديونية عبر تسوية #${settlement.settlementNumber} (${toPay} ${settlement.currency})`,
                },
              });

              await tx.sellerBalance.update({
                where: { id: sellerBal.id },
                data: {
                  outstandingCommission: { decrement: toPay },
                },
              });
            }

            unrecovered -= toPay;
          }
        }

        // 3. Credit remaining payable settlement to seller available balance
        if (settlement.payableSettlementAmount > 0) {
          const balance = await tx.sellerBalance.findUnique({
            where: { sellerId: settlement.sellerId },
          });
          if (balance) {
            await tx.sellerBalance.update({
              where: { id: balance.id },
              data: {
                availableBalance: { increment: settlement.payableSettlementAmount },
              },
            });

            await tx.sellerTransaction.create({
              data: {
                sellerBalanceId: balance.id,
                amount: settlement.payableSettlementAmount,
                type: 'CREDIT',
                referenceId: settlement.id,
                description: `إيداع صافي أرباح تسوية مبيعات #${settlement.settlementNumber} (بعد استقطاع الاحتياطي والمديونيات)`,
              },
            });
          }
        }

        // 4. Update settlement status
        const updatedSettlement = await tx.settlement.update({
          where: { id: input.settlementId },
          data: updateData,
          include: {
            items: true,
            seller: { include: { stores: true } },
          },
        });

        // 5. Re-evaluate restrictions
        await SellerFinancialRiskService.evaluateAndApplyRestrictions(tx, settlement.sellerId);

        return updatedSettlement;
      });
    }

    if (input.notes) updateData.notes = input.notes;

    return await prisma.settlement.update({
      where: { id: input.settlementId },
      data: updateData,
      include: {
        items: true,
        seller: { include: { stores: true } },
      },
    });
  }

  /**
   * Lists settlements with filtering and pagination
   */
  public static async listSettlements(params: {
    sellerId?: string;
    status?: SettlementStatus;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.sellerId) where.sellerId = params.sellerId;
    if (params.status) where.status = params.status;
    if (params.startDate || params.endDate) {
      where.createdAt = {};
      if (params.startDate) where.createdAt.gte = params.startDate;
      if (params.endDate) where.createdAt.lte = params.endDate;
    }

    const page = params.page || 1;
    const limit = params.limit || 20;

    const [total, settlements] = await Promise.all([
      prisma.settlement.count({ where }),
      prisma.settlement.findMany({
        where,
        include: {
          seller: { select: { id: true, stores: { select: { name: true } } } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      settlements,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
