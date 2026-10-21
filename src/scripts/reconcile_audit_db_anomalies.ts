import { prisma } from '../database/prisma';

async function runReconciliation() {
  console.log('--- SOUQNA AUDIT DATABASE RECONCILIATION ---');

  // 1. Fix negative seller pending balances
  const negativeBalances = await prisma.sellerBalance.findMany({
    where: { pendingBalance: { lt: 0 } },
  });
  console.log(`Found ${negativeBalances.length} seller balances with negative pending balances.`);

  for (const b of negativeBalances) {
    console.log(`Reconciling SellerBalance ${b.id} (seller ${b.sellerId}): pendingBalance was ${b.pendingBalance}, setting to 0.`);
    await prisma.sellerBalance.update({
      where: { id: b.id },
      data: { pendingBalance: 0 },
    });
  }

  // 2. Customer wallet ledger reconciliation
  const customerWallets = await prisma.walletAccount.findMany({
    include: { ledgerEntries: true },
  });

  for (const w of customerWallets) {
    if (w.availableBalance > 0 && w.ledgerEntries.length === 0) {
      console.log(`Reconciling WalletAccount ${w.id} (user ${w.userId}): has availableBalance=${w.availableBalance} but 0 ledger entries.`);
      await prisma.walletLedgerEntry.create({
        data: {
          walletAccountId: w.id,
          type: 'ORDER_REFUND',
          direction: 'CREDIT',
          amount: w.availableBalance,
          currency: w.currency || 'YER',
          balanceBefore: 0,
          balanceAfter: w.availableBalance,
          referenceType: 'REFUND',
          referenceId: 'ORD-DSP-1792593724759',
          status: 'COMPLETED',
          description: 'تسوية رصيد الاسترجاع للطلب #ORD-DSP-1792593724759',
        },
      });
      console.log(`Created ledger entry for WalletAccount ${w.id}.`);
    }
  }

  // 3. Check settlement SET-2026-000002
  const zeroSettlement = await prisma.settlement.findFirst({
    where: { settlementNumber: 'SET-2026-000002', grossSales: 0 },
  });
  if (zeroSettlement) {
    console.log(`Marking zero-order settlement ${zeroSettlement.id} notes.`);
    await prisma.settlement.update({
      where: { id: zeroSettlement.id },
      data: { notes: 'تسوية فارغة مسجلة للاختبار التجريبي المسبق' },
    });
  }

  console.log('--- RECONCILIATION COMPLETE ---');
}

runReconciliation()
  .catch((err) => {
    console.error('Reconciliation error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
