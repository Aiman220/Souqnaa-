/**
 * SOUQNAA Marketplace — Authoritative Seller Financial Reconciliation Engine
 * Verifies invariants across wallet ledgers, reserves, outstanding liabilities,
 * customer refund credits, and settlement debt recoveries.
 * Version: 2.1.0
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';

export interface ReconciliationSummary {
  runId: string;
  runNumber: string;
  totalSellersChecked: number;
  totalDiscrepancies: number;
  totalExposure: number;
  totalReserves: number;
  totalDebt: number;
  status: string;
  exceptions: Array<{
    sellerId?: string;
    entityType: string;
    entityId?: string;
    severity: string;
    expectedAmount?: number;
    actualAmount?: number;
    discrepancy?: number;
    description: string;
  }>;
  completedAt: Date;
}

export class SellerReconciliationService {
  /**
   * Generates unique run number: REC-YYYYMMDD-XXXX
   */
  private static async generateRunNumber(): Promise<string> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const count = await prisma.reconciliationRun.count({
      where: {
        runNumber: { startsWith: `REC-${today}` },
      },
    });
    return `REC-${today}-${String(count + 1).padStart(4, '0')}`;
  }

  /**
   * Executes authoritative, non-destructive reconciliation across all active sellers.
   * Never mutates posted transactions; records exceptions for finance review.
   */
  public static async runReconciliation(adminUserId?: string): Promise<ReconciliationSummary> {
    const runNumber = await this.generateRunNumber();

    const run = await prisma.reconciliationRun.create({
      data: {
        runNumber,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    const exceptions: Array<{
      sellerId?: string;
      entityType: string;
      entityId?: string;
      severity: string;
      expectedAmount?: number;
      actualAmount?: number;
      discrepancy?: number;
      description: string;
    }> = [];

    let totalExposure = 0;
    let totalReserves = 0;
    let totalDebt = 0;

    // Fetch all sellers with balance, outstandings, reserves, and risk profile
    const sellers = await prisma.seller.findMany({
      include: {
        balance: {
          include: {
            transactions: true,
          },
        },
        outstandings: {
          where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        },
        reserveAllocations: {
          where: { status: 'RESERVED' },
        },
        riskProfile: true,
      },
    });

    for (const seller of sellers) {
      // 1. Invariant: Sum of open outstandings remainingAmount == SellerBalance.outstandingCommission
      const sumOutstandings = seller.outstandings.reduce(
        (sum, o) => sum + (o.remainingAmount || 0),
        0
      );
      totalDebt += sumOutstandings;

      const balanceOutstanding = seller.balance?.outstandingCommission ?? 0;
      const driftOutstanding = Math.abs(sumOutstandings - balanceOutstanding);

      if (driftOutstanding > 0.05) {
        exceptions.push({
          sellerId: seller.id,
          entityType: 'SELLER_OUTSTANDING',
          entityId: seller.balance?.id,
          severity: driftOutstanding > 1000 ? 'HIGH' : 'MEDIUM',
          expectedAmount: sumOutstandings,
          actualAmount: balanceOutstanding,
          discrepancy: parseFloat((balanceOutstanding - sumOutstandings).toFixed(2)),
          description: `عدم تطابق بين مجموع مطالبات المديونية المفتوحة (${sumOutstandings} ر.ي) ورصيد المديونية المسجل بالمحفظة (${balanceOutstanding} ر.ي)`,
        });
      }

      // 2. Invariant: Sum of active SellerReserveAllocation == SellerRiskProfile.totalReservedBalance
      const sumReserves = seller.reserveAllocations.reduce(
        (sum, r) => sum + (r.amount || 0),
        0
      );
      totalReserves += sumReserves;

      const profileReserved = seller.riskProfile?.totalReservedBalance ?? 0;
      const driftReserves = Math.abs(sumReserves - profileReserved);

      if (driftReserves > 0.05) {
        exceptions.push({
          sellerId: seller.id,
          entityType: 'RESERVE_ALLOCATION',
          entityId: seller.riskProfile?.id,
          severity: driftReserves > 1000 ? 'HIGH' : 'LOW',
          expectedAmount: sumReserves,
          actualAmount: profileReserved,
          discrepancy: parseFloat((profileReserved - sumReserves).toFixed(2)),
          description: `عدم تطابق بين مجموع الاحتياطيات المحجوزة (${sumReserves} ر.ي) ومسجل ملف المخاطر (${profileReserved} ر.ي)`,
        });
      }

      // 3. Invariant: Available balance must NEVER be negative
      const available = seller.balance?.availableBalance ?? 0;
      if (available < -0.01) {
        exceptions.push({
          sellerId: seller.id,
          entityType: 'WALLET_LEDGER',
          entityId: seller.balance?.id,
          severity: 'CRITICAL',
          expectedAmount: 0,
          actualAmount: available,
          discrepancy: available,
          description: `رصيد المحفظة المتاح سالب (${available} ر.ي)، وهو ما يخالف قواعد النزاهة المحاسبية`,
        });
      }

      // 4. Invariant: Independent double-entry ledger verification
      if (seller.balance?.transactions && seller.balance.transactions.length > 0) {
        const ledgerNet = seller.balance.transactions.reduce((sum: number, tx: any) => {
          if (tx.type === 'CREDIT') return sum + Math.abs(tx.amount);
          if (tx.type === 'REFUND' || tx.type === 'WITHDRAWAL' || tx.type === 'DEBIT') return sum - Math.abs(tx.amount);
          return sum;
        }, 0);

        const driftLedger = Math.abs(available - ledgerNet);
        if (driftLedger > 0.05) {
          exceptions.push({
            sellerId: seller.id,
            entityType: 'WALLET_LEDGER',
            entityId: seller.balance.id,
            severity: driftLedger > 1000 ? 'HIGH' : 'MEDIUM',
            expectedAmount: parseFloat(ledgerNet.toFixed(2)),
            actualAmount: parseFloat(available.toFixed(2)),
            discrepancy: parseFloat((available - ledgerNet).toFixed(2)),
            description: `انحراف بين رصيد المحفظة المسجل (${available} ر.ي) وصافي حركة قيود الأستاذ العام (${ledgerNet.toFixed(2)} ر.ي)`,
          });
        }
      }

      // 5. Calculate Net Exposure
      const unsecuredExposure = Math.max(0, sumOutstandings - sumReserves);
      totalExposure += unsecuredExposure;
    }

    // Persist all exceptions linked to this run
    if (exceptions.length > 0) {
      await prisma.reconciliationException.createMany({
        data: exceptions.map((e) => ({
          runId: run.id,
          sellerId: e.sellerId || null,
          entityType: e.entityType,
          entityId: e.entityId || null,
          severity: e.severity,
          status: 'OPEN',
          expectedAmount: e.expectedAmount || null,
          actualAmount: e.actualAmount || null,
          discrepancy: e.discrepancy || null,
          description: e.description,
        })),
      });
    }

    const finalStatus = exceptions.length === 0 ? 'COMPLETED' : 'COMPLETED_WITH_EXCEPTIONS';

    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        totalSellersChecked: sellers.length,
        totalDiscrepancies: exceptions.length,
        totalExposure,
        totalReserves,
        totalDebt,
        completedAt: new Date(),
        summary: JSON.stringify({
          adminUserId: adminUserId || 'SYSTEM',
          criticalCount: exceptions.filter((e) => e.severity === 'CRITICAL').length,
          highCount: exceptions.filter((e) => e.severity === 'HIGH').length,
          mediumCount: exceptions.filter((e) => e.severity === 'MEDIUM').length,
          lowCount: exceptions.filter((e) => e.severity === 'LOW').length,
        }),
      },
    });

    // Record audit log
    let validUserId: string | null = null;
    if (adminUserId && adminUserId !== 'SYSTEM' && adminUserId !== 'AUTOMATED_TEST_SUITE') {
      const userExists = await prisma.user.findUnique({
        where: { id: adminUserId },
        select: { id: true },
      });
      if (userExists) validUserId = userExists.id;
    }

    await prisma.auditLog.create({
      data: {
        userId: validUserId,
        action: 'FINANCIAL_RECONCILIATION_RUN',
        resource: 'finance',
        details: JSON.stringify({
          runNumber,
          actor: adminUserId || 'SYSTEM',
          totalSellersChecked: sellers.length,
          exceptionsCount: exceptions.length,
          totalExposure,
          totalReserves,
          totalDebt,
          timestamp: new Date().toISOString(),
        }),
      },
    });

    return {
      runId: run.id,
      runNumber,
      totalSellersChecked: sellers.length,
      totalDiscrepancies: exceptions.length,
      totalExposure,
      totalReserves,
      totalDebt,
      status: finalStatus,
      exceptions,
      completedAt: new Date(),
    };
  }

  /**
   * Resolves a reconciliation exception with documented administrative corrective action.
   */
  public static async resolveException(
    adminUserId: string,
    exceptionId: string,
    resolutionNotes: string
  ): Promise<any> {
    if (!resolutionNotes || !resolutionNotes.trim()) {
      throw new AppError('ملاحظات معالجة وتسوية الفارق المالي مطلوبة إجبارياً', 400);
    }

    const exception = await prisma.reconciliationException.findUnique({
      where: { id: exceptionId },
    });
    if (!exception) {
      throw new AppError('سجل الفارق المالي غير موجود', 404);
    }

    const updated = await prisma.reconciliationException.update({
      where: { id: exceptionId },
      data: {
        status: 'RESOLVED',
        resolvedByAdminId: adminUserId,
        resolvedAt: new Date(),
        resolutionNotes: resolutionNotes.trim(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: 'RECONCILIATION_EXCEPTION_RESOLVED',
        resource: 'finance',
        details: JSON.stringify({
          exceptionId,
          sellerId: exception.sellerId,
          resolutionNotes: resolutionNotes.trim(),
          timestamp: new Date().toISOString(),
        }),
      },
    });

    return updated;
  }
}
