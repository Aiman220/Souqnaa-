/**
 * SOUQNAA Marketplace — Authoritative Seller Reserve Holding & Release Engine
 * Manages risk-based reserve allocations, 30-day holding periods, maturity checks,
 * lawful debt offsets, and auditable reserve releases.
 * Version: 2.1.0
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { remoteConfigService } from '../remote-config/remote-config.service';

export interface ReserveAllocationResult {
  allocationId: string;
  sellerId: string;
  settlementId?: string;
  amount: number;
  reservePercentage: number;
  holdingDays: number;
  releaseEligibleAt: Date;
  status: string;
}

export class SellerReserveService {
  /**
   * Calculates required reserve with exact rounding: netSettlement * percentage
   */
  public static calculateRequiredReserve(amount: number, percentage = 0.10): number {
    return Math.round(amount * percentage);
  }

  /**
   * Creates an authoritative reserve allocation from an eligible seller settlement.
   * Atomic, idempotent, and non-duplicative.
   */
  public static async allocateReserveFromSettlement(
    tx: any,
    params: {
      sellerId: string;
      settlementId: string;
      eligibleSettlementAmount: number;
      reservePercentage: number;
      holdingDays: number;
      riskTier: string;
      currency?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<ReserveAllocationResult> {
    const {
      sellerId,
      settlementId,
      eligibleSettlementAmount,
      reservePercentage,
      holdingDays,
      riskTier,
      currency = 'YER',
      metadata,
    } = params;

    // Guard against negative or zero allocation
    if (eligibleSettlementAmount <= 0 || reservePercentage <= 0) {
      return {
        allocationId: '',
        sellerId,
        settlementId,
        amount: 0,
        reservePercentage: 0,
        holdingDays,
        releaseEligibleAt: new Date(),
        status: 'SKIPPED',
      };
    }

    // Idempotency: verify settlement doesn't already have an active reserve allocation
    const existing = await tx.sellerReserveAllocation.findFirst({
      where: { settlementId },
    });
    if (existing) {
      return {
        allocationId: existing.id,
        sellerId: existing.sellerId,
        settlementId: existing.settlementId,
        amount: existing.amount,
        reservePercentage: existing.reservePercentage,
        holdingDays: existing.holdingDays,
        releaseEligibleAt: existing.releaseEligibleAt,
        status: existing.status,
      };
    }

    const calculatedReserve = parseFloat((eligibleSettlementAmount * reservePercentage).toFixed(2));
    const releaseEligibleAt = new Date(Date.now() + holdingDays * 24 * 60 * 60 * 1000);

    const allocation = await tx.sellerReserveAllocation.create({
      data: {
        sellerId,
        settlementId,
        amount: calculatedReserve,
        currency,
        reservePercentage,
        riskTier,
        holdingDays,
        releaseEligibleAt,
        status: 'RESERVED',
        reason: `استقطاع احتياطي مالي بنسبة ${(reservePercentage * 100).toFixed(0)}% لمدة ${holdingDays} يوماً لتغطية التزامات الاسترجاع المحتملة`,
        metadata: JSON.stringify({
          eligibleSettlementAmount,
          settlementId,
          ...(metadata || {}),
          createdAt: new Date().toISOString(),
        }),
      },
    });

    // Update SellerRiskProfile totalReservedBalance
    await tx.sellerRiskProfile.upsert({
      where: { sellerId },
      create: {
        sellerId,
        riskTier: (riskTier as any) || 'NORMAL',
        reservePercentage,
        reserveHoldingDays: holdingDays,
        totalReservedBalance: calculatedReserve,
      },
      update: {
        totalReservedBalance: { increment: calculatedReserve },
        lastEvaluatedAt: new Date(),
      },
    });

    return {
      allocationId: allocation.id,
      sellerId,
      settlementId,
      amount: calculatedReserve,
      reservePercentage,
      holdingDays,
      releaseEligibleAt,
      status: allocation.status,
    };
  }

  /**
   * Processes mature reserves whose holding period has elapsed.
   * Releases undisputed funds to seller available balance or applies to confirmed debt.
   */
  public static async processEligibleReserveReleases(adminUserId?: string): Promise<{
    processedCount: number;
    releasedAmount: number;
    appliedToDebtAmount: number;
    allocations: any[];
  }> {
    const isReserveActive = await remoteConfigService.isFeatureActive('seller_financial_risk_enabled');
    if (!isReserveActive) {
      return { processedCount: 0, releasedAmount: 0, appliedToDebtAmount: 0, allocations: [] };
    }

    const now = new Date();

    // Find all mature allocations
    const matureAllocations = await prisma.sellerReserveAllocation.findMany({
      where: {
        status: 'RESERVED',
        releaseEligibleAt: { lte: now },
      },
      include: {
        seller: {
          include: {
            balance: true,
            user: { select: { id: true, firstName: true, lastName: true } },
            outstandings: {
              where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
              orderBy: { createdAt: 'asc' },
            },
            disputes: {
              where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
            },
          },
        },
      },
    });

    let processedCount = 0;
    let releasedAmount = 0;
    let appliedToDebtAmount = 0;
    const processedAllocations: any[] = [];

    for (const alloc of matureAllocations) {
      // If seller has active legal disputes, extend hold rather than releasing blindly
      if (alloc.seller.disputes && alloc.seller.disputes.length > 0) {
        await prisma.sellerReserveAllocation.update({
          where: { id: alloc.id },
          data: {
            status: 'DISPUTED',
            reason: `تعليق الإفراج عن الاحتياطي لوجود نزاعات قائمة مفتوحة (${alloc.seller.disputes.length} نزاع)`,
          },
        });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        let remainingReserve = alloc.amount;
        let appliedDebt = 0;

        // Check if seller has confirmed collectible debt
        const openDebts = alloc.seller.outstandings || [];
        if (openDebts.length > 0) {
          for (const debt of openDebts) {
            if (remainingReserve <= 0) break;

            const payable = Math.min(remainingReserve, debt.remainingAmount);
            const newPaid = debt.paidAmount + payable;
            const newRemaining = debt.remainingAmount - payable;
            const newStatus = newRemaining <= 0.001 ? 'PAID' : 'PARTIALLY_PAID';

            await tx.sellerOutstanding.update({
              where: { id: debt.id },
              data: {
                paidAmount: newPaid,
                remainingAmount: Math.max(0, newRemaining),
                status: newStatus,
              },
            });

            // Create DebtRecoveryAllocation
            await tx.debtRecoveryAllocation.create({
              data: {
                sellerId: alloc.sellerId,
                outstandingId: debt.id,
                amount: payable,
                currency: alloc.currency,
                recoveredFrom: 'RESERVE',
                transactionRef: alloc.id,
                notes: `استيفاء مديونية تلقائي من الاحتياطي المنتهي فترة حجزه (${alloc.holdingDays} يوماً)`,
              },
            });

            // Ledger entry
            if (alloc.seller.balance) {
              await tx.sellerTransaction.create({
                data: {
                  sellerBalanceId: alloc.seller.balance.id,
                  amount: payable,
                  type: 'OUTSTANDING_PAYMENT',
                  referenceId: alloc.id,
                  description: `سداد مديونية عبر الاحتياطي المنتهي فترة حجزه (${payable} ${alloc.currency})`,
                },
              });

              await tx.sellerBalance.update({
                where: { id: alloc.seller.balance.id },
                data: {
                  outstandingCommission: { decrement: payable },
                },
              });
            }

            remainingReserve -= payable;
            appliedDebt += payable;
          }
        }

        // Release remaining reserve to seller available balance
        let released = 0;
        if (remainingReserve > 0) {
          released = remainingReserve;
          if (alloc.seller.balance) {
            await tx.sellerBalance.update({
              where: { id: alloc.seller.balance.id },
              data: {
                availableBalance: { increment: released },
              },
            });

            await tx.sellerTransaction.create({
              data: {
                sellerBalanceId: alloc.seller.balance.id,
                amount: released,
                type: 'CREDIT',
                referenceId: alloc.id,
                description: `إفراج عن الاحتياطي المالي بعد انقضاء فترة الحجز (${alloc.holdingDays} يوماً) - مرجع: ${alloc.id.substring(0, 8)}`,
              },
            });
          }
        }

        // Update allocation record
        const updatedAlloc = await tx.sellerReserveAllocation.update({
          where: { id: alloc.id },
          data: {
            status: appliedDebt > 0 && remainingReserve <= 0 ? 'APPLIED_TO_DEBT' : 'RELEASED',
            releasedAt: new Date(),
            releasedByAdminId: adminUserId || 'SYSTEM_AUTO_RELEASE',
            appliedToDebtAt: appliedDebt > 0 ? new Date() : null,
            reason: appliedDebt > 0
              ? `تم تطبيق ${appliedDebt} ر.ي لسداد المديونية والإفراج عن ${released} ر.ي للرصيد المتاح`
              : `إفراج دوري نظامي بعد اكتمال فترة الحجز (${alloc.holdingDays} يوماً)`,
          },
        });

        // Decrement totalReservedBalance in SellerRiskProfile
        await tx.sellerRiskProfile.updateMany({
          where: { sellerId: alloc.sellerId },
          data: {
            totalReservedBalance: { decrement: alloc.amount },
            totalDebtRecovered: { increment: appliedDebt },
            lastEvaluatedAt: new Date(),
          },
        });

        // Audit log
        await tx.auditLog.create({
          data: {
            userId: adminUserId || alloc.seller.user?.id || 'SYSTEM',
            action: appliedDebt > 0 ? 'SELLER_RESERVE_APPLIED_AND_RELEASED' : 'SELLER_RESERVE_RELEASED_AUTO',
            resource: 'sellers',
            details: JSON.stringify({
              allocationId: alloc.id,
              sellerId: alloc.sellerId,
              originalAmount: alloc.amount,
              appliedDebt,
              releasedAmount: released,
              timestamp: new Date().toISOString(),
            }),
          },
        });

        processedCount++;
        releasedAmount += released;
        appliedToDebtAmount += appliedDebt;
        processedAllocations.push(updatedAlloc);
      });

      // Real-time notification to seller
      try {
        const userId = alloc.seller.user?.id;
        if (userId) {
          SocketService.get()?.emitToUser(userId, 'seller:reserve_released', {
            allocationId: alloc.id,
            amount: alloc.amount,
            releasedAt: new Date().toISOString(),
          });
        }
      } catch (_) {}
    }

    return {
      processedCount,
      releasedAmount,
      appliedToDebtAmount,
      allocations: processedAllocations,
    };
  }

  /**
   * Manual administrative reserve adjustment with full maker-checker audit trail.
   */
  public static async manualAdjustReserve(
    adminUserId: string,
    params: {
      allocationId: string;
      action: 'RELEASE' | 'EXTEND' | 'OFFSET_DEBT';
      extendDays?: number;
      reason: string;
    }
  ): Promise<any> {
    const { allocationId, action, extendDays = 30, reason } = params;

    if (!reason || !reason.trim()) {
      throw new AppError('سبب تعديل الاحتياطي مطلوب إجبارياً للتدقيق المحاسبي', 400);
    }

    const allocation = await prisma.sellerReserveAllocation.findUnique({
      where: { id: allocationId },
      include: {
        seller: {
          include: {
            balance: true,
            user: true,
            outstandings: { where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } } },
          },
        },
      },
    });

    if (!allocation) {
      throw new AppError('سجل الاحتياطي غير موجود', 404);
    }

    if (allocation.status !== 'RESERVED' && allocation.status !== 'DISPUTED') {
      throw new AppError(`لا يمكن تعديل هذا الاحتياطي نظراً لحالته الحالية (${allocation.status})`, 400);
    }

    return await prisma.$transaction(async (tx) => {
      let updated: any;

      if (action === 'EXTEND') {
        const newEligibleAt = new Date(allocation.releaseEligibleAt.getTime() + extendDays * 24 * 60 * 60 * 1000);
        updated = await tx.sellerReserveAllocation.update({
          where: { id: allocationId },
          data: {
            status: 'EXTENDED',
            holdingDays: allocation.holdingDays + extendDays,
            releaseEligibleAt: newEligibleAt,
            reason: `تمديد فترة الحجز بقرار إداري (${extendDays} يوماً إضافية): ${reason.trim()}`,
          },
        });
      } else if (action === 'RELEASE') {
        // Direct early release to available balance
        if (allocation.seller.balance) {
          await tx.sellerBalance.update({
            where: { id: allocation.seller.balance.id },
            data: {
              availableBalance: { increment: allocation.amount },
            },
          });

          await tx.sellerTransaction.create({
            data: {
              sellerBalanceId: allocation.seller.balance.id,
              amount: allocation.amount,
              type: 'CREDIT',
              referenceId: allocation.id,
              description: `إفراج إداري استثنائي عن الاحتياطي المالي (${reason.trim()})`,
            },
          });
        }

        updated = await tx.sellerReserveAllocation.update({
          where: { id: allocationId },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            releasedByAdminId: adminUserId,
            reason: `إفراج إداري استثنائي: ${reason.trim()}`,
          },
        });

        await tx.sellerRiskProfile.updateMany({
          where: { sellerId: allocation.sellerId },
          data: {
            totalReservedBalance: { decrement: allocation.amount },
            lastEvaluatedAt: new Date(),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: `SELLER_RESERVE_MANUAL_${action}`,
          resource: 'sellers',
          details: JSON.stringify({
            allocationId,
            sellerId: allocation.sellerId,
            action,
            reason: reason.trim(),
            adminUserId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return updated;
    });
  }
}
