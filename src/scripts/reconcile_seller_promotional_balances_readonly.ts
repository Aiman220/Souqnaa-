/**
 * SOUQNA — READ-ONLY HISTORICAL RECONCILIATION AUDIT
 * Identifies any seller balances created through the unsafe 100,000 YER promotional path.
 *
 * RULE: STRICTLY READ-ONLY. Zero writes, zero deductions, zero row updates.
 */

import { prisma } from '../database/prisma';
import { SellerOrderStatus } from '@prisma/client';

interface SellerBalanceAnomaly {
  sellerId: string;
  sellerName?: string;
  storeNames: string[];
  currentAvailableBalance: number;
  currentPendingBalance: number;
  currency: string;
  totalOrderPayouts: number;
  totalApprovedDeposits: number;
  totalCompletedWithdrawals: number;
  totalPromotionExpenses: number;
  expectedMaxBalance: number;
  unbackedSurplus: number;
  flaggedForReview: boolean;
}

async function runReadOnlyHistoricalBalanceAudit() {
  console.log('============================================================');
  console.log('🔍 SOUQNA — READ-ONLY SELLER BALANCE RECONCILIATION AUDIT');
  console.log('============================================================\n');

  try {
    const balances = await prisma.sellerBalance.findMany({
      include: {
        seller: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
            stores: { select: { id: true, name: true } },
          },
        },
      },
    });

    console.log(`Auditing ${balances.length} registered seller balance records in database...\n`);

    const anomalies: SellerBalanceAnomaly[] = [];

    for (const b of balances) {
      // 1. Sum verified order payouts
      let totalOrderPayouts = 0;
      try {
        const completedSellerOrders = await prisma.sellerOrder.aggregate({
          where: {
            sellerId: b.sellerId,
            status: SellerOrderStatus.DELIVERED,
          },
          _sum: { sellerPayout: true },
        });
        totalOrderPayouts = completedSellerOrders._sum.sellerPayout || 0;
      } catch {
        // No orders
      }

      // 2. Sum approved deposits
      let totalApprovedDeposits = 0;
      try {
        const approvedDeposits = await prisma.walletDeposit.aggregate({
          where: {
            userId: b.seller?.userId,
            status: 'APPROVED',
          },
          _sum: { amount: true },
        });
        totalApprovedDeposits = approvedDeposits._sum.amount || 0;
      } catch {
        // Table may be empty
      }

      // 3. Sum approved withdrawals
      let totalCompletedWithdrawals = 0;
      try {
        const completedWithdrawals = await prisma.withdrawal.aggregate({
          where: {
            sellerId: b.sellerId,
            status: 'COMPLETED',
          },
          _sum: { amount: true },
        });
        totalCompletedWithdrawals = completedWithdrawals._sum.amount || 0;
      } catch {
        // Table may be empty
      }

      // 4. Sum promotional campaign expenses
      let totalPromotionExpenses = 0;
      try {
        const promoPayments = await prisma.sellerPromotionPayment.aggregate({
          where: {
            sellerId: b.sellerId,
            status: 'COMPLETED',
          },
          _sum: { amount: true },
        });
        totalPromotionExpenses = promoPayments._sum.amount || 0;
      } catch {
        // Table may be empty
      }

      // Theoretical maximum legitimate balance
      const expectedMaxBalance = Math.max(0, totalOrderPayouts + totalApprovedDeposits - totalCompletedWithdrawals - totalPromotionExpenses);
      const unbackedSurplus = Math.max(0, b.availableBalance - expectedMaxBalance);

      // Flag if unbacked balance > 0 or matches 100,000 YER initial threshold
      const isAnomalous = unbackedSurplus > 0 || b.availableBalance === 100000;

      if (isAnomalous || b.availableBalance > 0) {
        anomalies.push({
          sellerId: b.sellerId,
          sellerName: b.seller?.user ? `${b.seller.user.firstName} ${b.seller.user.lastName}` : 'N/A',
          storeNames: b.seller?.stores.map((s) => s.name) || [],
          currentAvailableBalance: b.availableBalance,
          currentPendingBalance: b.pendingBalance,
          currency: b.currency || 'YER',
          totalOrderPayouts,
          totalApprovedDeposits,
          totalCompletedWithdrawals,
          totalPromotionExpenses,
          expectedMaxBalance,
          unbackedSurplus,
          flaggedForReview: isAnomalous,
        });
      }
    }

    console.log(`------------------------------------------------------------`);
    console.log(`SUMMARY: ${anomalies.length} seller balances evaluated with non-zero or anomalous states.`);
    console.log(`------------------------------------------------------------\n`);

    if (anomalies.length === 0) {
      console.log('✅ ZERO UNBACKED OR ANOMALOUS SELLER BALANCES FOUND IN DATABASE.\n');
    } else {
      for (const a of anomalies) {
        console.log(`Seller: ${a.sellerId} (${a.sellerName})`);
        console.log(`  Stores: ${a.storeNames.join(', ') || 'None'}`);
        console.log(`  Available Balance : ${a.currentAvailableBalance.toLocaleString()} ${a.currency}`);
        console.log(`  Order Payouts     : ${a.totalOrderPayouts.toLocaleString()} ${a.currency}`);
        console.log(`  Approved Deposits : ${a.totalApprovedDeposits.toLocaleString()} ${a.currency}`);
        console.log(`  Withdrawals       : ${a.totalCompletedWithdrawals.toLocaleString()} ${a.currency}`);
        console.log(`  Promotion Expenses: ${a.totalPromotionExpenses.toLocaleString()} ${a.currency}`);
        console.log(`  Unbacked Surplus  : ${a.unbackedSurplus.toLocaleString()} ${a.currency}`);
        console.log(`  Status            : ${a.flaggedForReview ? '⚠️ FLAGGED FOR MANUAL REMEDIATION' : '✓ LEGITIMATE'}\n`);
      }
    }

    console.log('============================================================');
    console.log('AUDIT COMPLETE: No rows were modified.');
    console.log('============================================================\n');
  } catch (error) {
    console.error('Audit execution error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runReadOnlyHistoricalBalanceAudit();
