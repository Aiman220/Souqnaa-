import { prisma } from './src/database/prisma';

async function main() {
  const orderId = '42a0ef95-9850-451c-a633-2af3e32bcdf3';
  const r = await prisma.refundRequest.findFirst({
    where: { orderId },
    include: { evidence: true, items: true, reason: true },
  });
  console.log('REFUND REQUEST DETAILS:');
  console.log(JSON.stringify(r, null, 2));
}

main().finally(() => prisma.$disconnect());
