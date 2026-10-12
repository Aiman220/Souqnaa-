import { prisma } from '../database/prisma';

async function main() {
  const count = await prisma.order.count();
  console.log('Total Orders count:', count);

  const orders = await prisma.order.findMany({
    select: {
      id: true,
      orderNumber: true,
      createdAt: true,
      sellerOrders: {
        select: {
          id: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  console.log('Sample orders:', JSON.stringify(orders, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
