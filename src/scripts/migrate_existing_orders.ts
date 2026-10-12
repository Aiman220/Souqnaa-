import { prisma } from '../database/prisma';
import { OrderNumberService } from '../services/orders/order-number.service';

async function migrateExistingOrders() {
  console.log('--- STARTING SOUQNAA ORDER NUMBER MIGRATION ---');

  // 1. Initialize PostgreSQL sequence
  await OrderNumberService.initSequence();

  // 2. Fetch all orders ordered chronologically
  const allOrders = await prisma.order.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      sellerOrders: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  console.log(`Found total ${allOrders.length} orders in database.`);

  let migratedCount = 0;
  let alreadyMigratedCount = 0;

  // Find highest existing sequence if any
  let currentSeq = 0;
  for (const o of allOrders) {
    if (o.orderSequence && o.orderSequence > currentSeq) {
      currentSeq = o.orderSequence;
    }
  }

  for (let i = 0; i < allOrders.length; i++) {
    const order = allOrders[i];

    // Idempotency: If already has orderSequence and formatted SQ order number, keep stable!
    if (order.orderSequence && order.orderNumber.startsWith('SQ-')) {
      alreadyMigratedCount++;
      // Still ensure sellerOrders have sellerOrderNumber
      for (let sIdx = 0; sIdx < order.sellerOrders.length; sIdx++) {
        const so = order.sellerOrders[sIdx];
        if (!so.sellerOrderNumber) {
          const subIndex = sIdx + 1;
          const sellerOrderNumber = OrderNumberService.generateSellerOrderNumber(order.orderNumber, subIndex);
          await prisma.sellerOrder.update({
            where: { id: so.id },
            data: {
              subOrderIndex: subIndex,
              sellerOrderNumber,
            },
          });
          console.log(`  Updated missing sub-order number: ${sellerOrderNumber} for SellerOrder ${so.id}`);
        }
      }
      continue;
    }

    currentSeq++;
    const publicOrderNumber = OrderNumberService.formatPublicOrderNumber(currentSeq, order.createdAt);
    const displayOrderNumber = OrderNumberService.formatDisplayOrderNumber(currentSeq);

    await prisma.$transaction(async (tx) => {
      // Update parent Order
      await tx.order.update({
        where: { id: order.id },
        data: {
          orderSequence: currentSeq,
          orderNumber: publicOrderNumber,
          displayOrderNumber,
        },
      });

      // Update seller orders with deterministic S01, S02...
      for (let sIdx = 0; sIdx < order.sellerOrders.length; sIdx++) {
        const so = order.sellerOrders[sIdx];
        const subIndex = sIdx + 1;
        const sellerOrderNumber = OrderNumberService.generateSellerOrderNumber(publicOrderNumber, subIndex);

        await tx.sellerOrder.update({
          where: { id: so.id },
          data: {
            subOrderIndex: subIndex,
            sellerOrderNumber,
          },
        });
      }
    });

    migratedCount++;
    console.log(`[${migratedCount}/${allOrders.length}] Migrated Order ${order.id}: ${order.orderNumber} -> ${publicOrderNumber} (${displayOrderNumber}) with ${order.sellerOrders.length} sub-orders`);
  }

  // 3. Synchronize PostgreSQL sequence to currentSeq
  if (currentSeq > 0) {
    await prisma.$executeRawUnsafe(`
      SELECT setval('"souqnaa"."order_number_seq"', ${currentSeq}, true);
    `);
    await prisma.orderCounter.upsert({
      where: { name: 'order_number' },
      update: { value: BigInt(currentSeq) },
      create: { name: 'order_number', value: BigInt(currentSeq) },
    });
  }

  console.log('--- MIGRATION COMPLETED SUCCESSFULLY ---');
  console.log(`Migrated: ${migratedCount}`);
  console.log(`Already migrated: ${alreadyMigratedCount}`);
  console.log(`Current sequence value: ${currentSeq}`);
}

migrateExistingOrders()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
