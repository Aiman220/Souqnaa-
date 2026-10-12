import { prisma } from './src/database/prisma';

async function main() {
  const [orders, sellerOrders, products, sellers, customers, commissions, settlements, taxSnapshots] = await Promise.all([
    prisma.order.count(),
    prisma.sellerOrder.count(),
    prisma.product.count(),
    prisma.seller.count(),
    prisma.customer.count(),
    prisma.commission.count(),
    prisma.settlement.count(),
    prisma.orderTaxSnapshot.count(),
  ]);

  const dailyCount = await (prisma as any).analyticsDailyMetric?.count?.().catch((e: any) => e.message);
  console.log('AnalyticsDailyMetric query result:', dailyCount);

  console.log('DB Counts:', {
    orders,
    sellerOrders,
    products,
    sellers,
    customers,
    commissions,
    settlements,
    taxSnapshots,
  });

  const sampleSeller = await prisma.seller.findFirst({
    select: { id: true, userId: true, user: { select: { email: true, firstName: true } } },
  });
  console.log('Sample Seller:', sampleSeller);
}

main().catch(console.error).finally(() => prisma.$disconnect());
