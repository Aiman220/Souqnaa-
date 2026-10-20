import { prisma } from '../database/prisma';
import { OrderStateMachine } from '../modules/orders/order.state-machine';
import { SocketService } from '../services/websocket/socket.service';
import { formatProductForClient } from '../utils/product-formatter.util';
import { OrderStatus, SellerOrderStatus } from '@prisma/client';

async function traceDiagnostics() {
  const correlationId = `DIAG-SOLD-${Date.now()}`;
  console.log(`\n======================================================`);
  console.log(`[DIAGNOSTICS] Starting correlation trace: ${correlationId}`);
  console.log(`======================================================\n`);

  // Clean up any stale diagnostic test products and order items
  await prisma.orderItem.deleteMany({
    where: {
      OR: [
        { product: { slug: { startsWith: 'diag-prod-' } } },
        { sellerOrder: { order: { orderSequence: 999999 } } },
      ],
    },
  }).catch(() => {});
  await prisma.sellerOrder.deleteMany({
    where: { order: { orderSequence: 999999 } },
  }).catch(() => {});
  await prisma.order.deleteMany({
    where: { orderSequence: 999999 },
  }).catch(() => {});
  await prisma.inventory.deleteMany({
    where: { product: { slug: { startsWith: 'diag-prod-' } } },
  }).catch(() => {});
  await prisma.product.deleteMany({
    where: { slug: { startsWith: 'diag-prod-' } },
  }).catch(() => {});

  // Setup: Find test store and category
  const testStore = await prisma.store.findFirst({
    include: { seller: true },
  });
  if (!testStore) {
    throw new Error('No store found in database for diagnostic test');
  }

  const testCategory = await prisma.category.findFirst();
  if (!testCategory) {
    throw new Error('No category found in database for diagnostic test');
  }

  // Create isolated test product with soldCount = 10
  const initialSoldCount = 10;
  const testProduct = await prisma.product.create({
    data: {
      nameAr: `منتج فحص تشخيصي ${correlationId}`,
      nameEn: `Diag Test Product ${correlationId}`,
      slug: `diag-prod-${correlationId.toLowerCase()}`,
      price: 100,
      currency: 'SAR',
      soldCount: initialSoldCount,
      storeId: testStore.id,
      categoryId: testCategory.id,
      isActive: true,
      inventory: {
        create: {
          quantity: 50,
          reserved: 0,
        },
      },
    },
  });

  console.log(`CHECKPOINT 1 [DB Initial]:`);
  console.log(`  correlationId: ${correlationId}`);
  console.log(`  productId: ${testProduct.id}`);
  console.log(`  soldCount before test: ${testProduct.soldCount}`);

  // Create test customer order with quantity = 3
  const orderQuantity = 3;
  const sampleUser = await prisma.user.findFirst();
  if (!sampleUser) throw new Error('No user found');

  const testOrder = await prisma.order.create({
    data: {
      orderNumber: `ORD-${Date.now()}`,
      orderSequence: 999999,
      displayOrderNumber: `#999999`,
      userId: sampleUser.id,
      status: OrderStatus.CONFIRMED,
      currency: 'SAR',
      subtotal: 300,
      total: 300,
    },
  });

  const sellerOrder = await prisma.sellerOrder.create({
    data: {
      orderId: testOrder.id,
      sellerId: testStore.sellerId || testStore.seller!.id,
      sellerOrderNumber: `SO-${Date.now()}-1`,
      status: SellerOrderStatus.SHIPPED,
      subtotal: 300,
      sellerPayout: 270,
      items: {
        create: {
          productId: testProduct.id,
          productNameAr: testProduct.nameAr || 'منتج فحص',
          productNameEn: testProduct.nameEn || 'Test Product',
          unitPrice: 100,
          quantity: orderQuantity,
          totalPrice: 300,
        },
      },
    },
    include: {
      items: true,
    },
  });

  console.log(`\nCHECKPOINT 2 [Order Transition Setup]:`);
  console.log(`  orderId: ${testOrder.id}`);
  console.log(`  sellerOrderId: ${sellerOrder.id}`);
  console.log(`  itemQuantity: ${orderQuantity}`);
  console.log(`  qualifying status transition: SHIPPED -> DELIVERED`);

  // Intercept socket emissions to verify Checkpoint 4/5 broadcast
  let emittedGlobalEvent: { event: string; payload: any } | null = null;
  const mockSocket = {
    emitOrderStatusUpdate: () => {},
    emitGlobal: (event: string, payload: any) => {
      emittedGlobalEvent = { event, payload };
      console.log(`  [Socket Emission Captured] event: '${event}', payload:`, payload);
    },
    io: {
      to: () => ({ emit: () => {} }),
      emit: () => {},
    },
  };
  (SocketService as any).instance = mockSocket;

  // Execute qualifying status transition: SHIPPED -> DELIVERED
  await OrderStateMachine.transitionSellerOrder({
    sellerOrderId: sellerOrder.id,
    targetStatus: 'DELIVERED',
    changedByRole: 'SELLER',
    changedBy: sampleUser.id,
    reason: 'Delivery confirmed for diagnostic verification',
  });

  // Checkpoint 3: Database count after transaction commits
  const dbProductAfter = await prisma.product.findUnique({
    where: { id: testProduct.id },
    select: { id: true, soldCount: true, nameAr: true, price: true, currency: true },
  });

  console.log(`\nCHECKPOINT 3 [DB Post-Commit]:`);
  console.log(`  productId: ${dbProductAfter?.id}`);
  console.log(`  soldCount in DB: ${dbProductAfter?.soldCount}`);
  console.log(`  expected DB soldCount: ${initialSoldCount + orderQuantity} (13)`);
  console.log(`  DB status: ${dbProductAfter?.soldCount === 13 ? 'CORRECT (13)' : 'FAILED'}`);

  // Checkpoint 4: Product API Formatter / Serialization
  const formattedProduct = formatProductForClient(dbProductAfter);
  console.log(`\nCHECKPOINT 4 [API Response & Serialization]:`);
  console.log(`  formatted soldCount: ${formattedProduct.soldCount}`);
  console.log(`  formatted sold_count: ${formattedProduct.sold_count}`);
  console.log(`  API status: ${formattedProduct.soldCount === 13 ? 'CORRECT (13)' : 'FAILED'}`);

  // Checkpoint 5: Real-time broadcast emission check
  console.log(`\nCHECKPOINT 5 [Real-time Event Emission]:`);
  if (emittedGlobalEvent) {
    console.log(`  Emitted Event: ${(emittedGlobalEvent as any).event}`);
    console.log(`  Payload:`, (emittedGlobalEvent as any).payload);
    console.log(`  Socket status: CORRECT`);
  } else {
    console.log(`  Socket status: NO EVENT EMITTED`);
  }

  // Idempotency verification: Duplicate event / re-transition should NOT double-increment
  console.log(`\n[IDEMPOTENCY VERIFICATION]: Attempting duplicate transition on already DELIVERED order...`);
  try {
    await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: sellerOrder.id,
      targetStatus: 'DELIVERED',
      changedByRole: 'SELLER',
      changedBy: sampleUser.id,
    });
  } catch (err: any) {
    console.log(`  Duplicate transition rejected as expected: ${err.message}`);
  }

  const dbProductAfterDupe = await prisma.product.findUnique({
    where: { id: testProduct.id },
    select: { soldCount: true },
  });
  console.log(`  DB count after duplicate attempt: ${dbProductAfterDupe?.soldCount} (Must remain 13, NOT 16)`);

  // Cleanup test product and order
  await prisma.orderItem.deleteMany({ where: { sellerOrderId: sellerOrder.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: testOrder.id } });
  await prisma.sellerOrder.deleteMany({ where: { orderId: testOrder.id } });
  await prisma.payment.deleteMany({ where: { orderId: testOrder.id } });
  await prisma.order.deleteMany({ where: { id: testOrder.id } });
  await prisma.inventory.deleteMany({ where: { productId: testProduct.id } });
  await prisma.product.deleteMany({ where: { id: testProduct.id } });

  console.log(`\n[CLEANUP] Diagnostic test artifacts safely cleaned up.`);
  console.log(`\n======================================================`);
  console.log(`[DIAGNOSTICS COMPLETE]`);
  console.log(`======================================================\n`);
}

traceDiagnostics()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

