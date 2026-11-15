import { prisma } from '../database/prisma';

async function run() {
  const sellerId = '2b74577c-8ca7-48e7-91db-bead0f37675e';
  const balance = await prisma.sellerBalance.findUnique({ where: { sellerId } });
  const outstandings = await prisma.sellerOutstanding.findMany({ where: { sellerId } });
  const codObligations = await prisma.codFinancialObligation.findMany({ where: { sellerId } });
  const refundRequests = await prisma.refundRequest.findMany({ where: { sellerId } });
  const sellerOrders = await prisma.sellerOrder.findMany({ where: { sellerId } });
  const transactions = await prisma.sellerTransaction.findMany({
    where: { sellerBalance: { sellerId } },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  console.log('=== BALANCE ===', balance);
  console.log('=== OUTSTANDINGS ===', outstandings);
  console.log('=== COD OBLIGATIONS ===', codObligations);
  console.log('=== REFUNDS ===', refundRequests);
  console.log('=== SELLER ORDERS ===', sellerOrders.map(o => ({ id: o.id, status: o.status, sellerPayout: o.sellerPayout, commissionAmount: o.commissionAmount, subtotal: o.subtotal })));
  console.log('=== TRANSACTIONS ===', transactions);
}

run().catch(console.error).finally(() => process.exit(0));
