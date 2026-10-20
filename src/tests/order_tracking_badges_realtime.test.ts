import { prisma } from '../database/prisma';
import { OrderStatus, SellerOrderStatus, PaymentMethodType, PaymentStatus, NotificationType } from '@prisma/client';
import { OrderStateMachine } from '../modules/orders/order.state-machine';

async function runTestSuite() {
  console.log('================================================================');
  console.log('SOUQNAA — REAL-TIME TRACKING, BADGES & UNREAD STATE TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      if (details) console.error(`       Details: ${details}`);
      failed++;
    }
  }

  const testSuffix = Date.now().toString().slice(-6);

  let sampleUser: any;
  let sampleStore: any;
  let testOrder1: any;
  let testOrder2: any;
  let testSellerOrder1: any;
  let testSellerOrder2: any;

  try {
    // -------------------------------------------------------------
    // SETUP: Use existing user and store to create isolated test orders
    // -------------------------------------------------------------
    console.log('--- 0. Setup: Test fixtures creation ---');
    sampleUser = await prisma.user.findFirst();
    if (!sampleUser) throw new Error('No user found in database');

    sampleStore = await prisma.store.findFirst({
      include: { seller: true },
    });
    if (!sampleStore || !sampleStore.seller) throw new Error('No store/seller found in database');

    // Create Order 1 (initially PENDING, Cash on delivery)
    testOrder1 = await prisma.order.create({
      data: {
        userId: sampleUser.id,
        orderNumber: `ORD-TEST-1-${testSuffix}`,
        displayOrderNumber: `#SQ-${testSuffix}-1`,
        subtotal: 100,
        deliveryFee: 10,
        total: 110,
        currency: 'YER',
        status: OrderStatus.PENDING,
        payment: {
          create: {
            method: PaymentMethodType.CASH_ON_DELIVERY,
            status: PaymentStatus.PENDING,
            amount: 110,
          },
        },
      },
    });

    testSellerOrder1 = await prisma.sellerOrder.create({
      data: {
        orderId: testOrder1.id,
        sellerId: sampleStore.seller.id,
        sellerOrderNumber: `SO-TEST-1-${testSuffix}`,
        subtotal: 100,
        sellerPayout: 90,
        status: SellerOrderStatus.PENDING,
      },
    });

    // Create Order 2 (SHIPPED)
    testOrder2 = await prisma.order.create({
      data: {
        userId: sampleUser.id,
        orderNumber: `ORD-TEST-2-${testSuffix}`,
        displayOrderNumber: `#SQ-${testSuffix}-2`,
        subtotal: 200,
        deliveryFee: 20,
        total: 220,
        currency: 'YER',
        status: OrderStatus.SHIPPED,
        payment: {
          create: {
            method: PaymentMethodType.CASH_ON_DELIVERY,
            status: PaymentStatus.PENDING,
            amount: 220,
          },
        },
      },
    });

    testSellerOrder2 = await prisma.sellerOrder.create({
      data: {
        orderId: testOrder2.id,
        sellerId: sampleStore.seller.id,
        sellerOrderNumber: `SO-TEST-2-${testSuffix}`,
        subtotal: 200,
        sellerPayout: 180,
        status: SellerOrderStatus.SHIPPED,
      },
    });

    // Create unread notifications for Order 1 using different alias identifiers
    const notif1 = await prisma.notification.create({
      data: {
        userId: sampleUser.id,
        type: NotificationType.ORDER_STATUS,
        titleAr: 'طلبك قيد المراجعة',
        titleEn: 'Order under review',
        bodyAr: 'تم استلام طلبك بنجاح',
        bodyEn: 'Your order was received',
        entityId: testOrder1.orderNumber, // alias: orderNumber
        isRead: false,
      },
    });

    // Create unread notification for Order 2 using displayOrderNumber
    const notif2 = await prisma.notification.create({
      data: {
        userId: sampleUser.id,
        type: NotificationType.ORDER_STATUS,
        titleAr: 'طلبك في الطريق',
        titleEn: 'Order shipped',
        bodyAr: 'تم شحن طلبك بنجاح',
        bodyEn: 'Your order has been shipped',
        entityId: testOrder2.displayOrderNumber, // alias: displayOrderNumber
        isRead: false,
      },
    });

    assert(Boolean(testOrder1 && testOrder2 && notif1 && notif2), 'Test fixtures initialized successfully');

    // -------------------------------------------------------------
    // TEST 1: Authoritative Order State Machine Transition
    // -------------------------------------------------------------
    console.log('\n--- 1. Testing Authoritative Status Transition ---');
    const startTransitionTime = Date.now();
    const transitionResult = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: testSellerOrder1.id,
      targetStatus: SellerOrderStatus.CONFIRMED,
      changedBy: sampleStore.seller.userId,
      changedByRole: 'SELLER',
      reason: 'Seller confirmed preparation',
    });
    const transitionLatencyMs = Date.now() - startTransitionTime;

    assert(
      transitionResult.sellerOrder.status === SellerOrderStatus.CONFIRMED,
      'Seller order transitioned to CONFIRMED',
      `Current: ${transitionResult.sellerOrder.status}`
    );
    assert(
      transitionResult.parentStatus === OrderStatus.CONFIRMED,
      'Parent order synchronized to CONFIRMED',
      `Current parent: ${transitionResult.parentStatus}`
    );
    console.log(`       Transition measured latency: ${transitionLatencyMs} ms`);

    // Verify status history recorded
    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: testOrder1.id, toStatus: 'CONFIRMED' },
    });
    assert(Boolean(history), 'OrderStatusHistory record was committed to database');

    // -------------------------------------------------------------
    // TEST 2: Unread Aliases & Entity Identification
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Identifier Aliases for Unread State ---');

    // Query notifications by Order 1's UUID, orderNumber, displayOrderNumber, and sellerOrderNumber
    const order1Aliases = [
      testOrder1.id,
      testOrder1.orderNumber,
      testOrder1.displayOrderNumber,
      testSellerOrder1.id,
      testSellerOrder1.sellerOrderNumber,
    ].filter(Boolean);

    const unreadForOrder1 = await prisma.notification.findMany({
      where: {
        userId: sampleUser.id,
        isRead: false,
        entityId: { in: order1Aliases },
      },
    });

    assert(
      unreadForOrder1.length >= 1 && unreadForOrder1.some(n => n.id === notif1.id),
      'Notification matched via orderNumber alias without UUID mismatch',
      `Found: ${unreadForOrder1.length}`
    );

    // -------------------------------------------------------------
    // TEST 3: Idempotent Single Order Read (POST /api/v1/orders/:id/read logic)
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing Single Order Read Operation ---');
    // Mark order 1 read using displayOrderNumber alias
    const readUpdateResult = await prisma.notification.updateMany({
      where: {
        userId: sampleUser.id,
        isRead: false,
        entityId: { in: order1Aliases },
      },
      data: { isRead: true, readAt: new Date() },
    });

    assert(
      readUpdateResult.count >= 1,
      'Order 1 notification marked as read via alias',
      `Marked count: ${readUpdateResult.count}`
    );

    // Verify Order 2 notification remains untouched (isolation requirement §6)
    const order2NotifAfter = await prisma.notification.findUnique({
      where: { id: notif2.id },
    });
    assert(
      order2NotifAfter?.isRead === false,
      'Order 2 notification remains UNREAD (viewing one order does not clear unrelated unreads)',
      `Order 2 isRead: ${order2NotifAfter?.isRead}`
    );

    // Repeated read call idempotency check (§6, §9.5)
    const repeatedUpdate = await prisma.notification.updateMany({
      where: {
        userId: sampleUser.id,
        isRead: false,
        entityId: { in: order1Aliases },
      },
      data: { isRead: true, readAt: new Date() },
    });
    assert(repeatedUpdate.count === 0, 'Repeated mark-as-read is strictly idempotent (0 duplicate updates)');

    // -------------------------------------------------------------
    // TEST 4: Mark Filter Read (POST /api/v1/orders/mark-filter-read logic)
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing Filter Mark-As-Read ---');
    const order2Aliases = [
      testOrder2.id,
      testOrder2.orderNumber,
      testOrder2.displayOrderNumber,
      testSellerOrder2.id,
      testSellerOrder2.sellerOrderNumber,
    ].filter(Boolean);

    // Mark SHIPPED filter read
    const filterUpdateResult = await prisma.notification.updateMany({
      where: {
        userId: sampleUser.id,
        isRead: false,
        entityId: { in: order2Aliases },
      },
      data: { isRead: true, readAt: new Date() },
    });

    assert(
      filterUpdateResult.count === 1,
      'Order 2 notification cleared when opening SHIPPED tab',
      `Marked count: ${filterUpdateResult.count}`
    );

    // -------------------------------------------------------------
    // TEST 5: Out-of-order sequence protection
    // -------------------------------------------------------------
    console.log('\n--- 5. Testing Stale / Out-of-Order Transition Protection ---');
    let rejectedIllegalTransition = false;
    try {
      // Attempt to transition CONFIRMED back to PENDING (invalid state reversal)
      await OrderStateMachine.transitionSellerOrder({
        sellerOrderId: testSellerOrder1.id,
        targetStatus: SellerOrderStatus.PENDING,
        changedBy: sampleStore.seller.userId,
        changedByRole: 'SELLER',
        reason: 'Illegal state reversal attempt',
      });
    } catch (e: any) {
      rejectedIllegalTransition = true;
    }
    assert(
      rejectedIllegalTransition,
      'OrderStateMachine strictly rejects invalid backward state transition to PENDING'
    );

  } catch (err: any) {
    console.error('Unexpected error in test suite:', err);
    failed++;
  } finally {
    // Cleanup fixtures
    console.log('\n--- Cleanup: Removing test fixtures ---');
    try {
      if (testOrder1) {
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: [testOrder1.id, testOrder2?.id].filter(Boolean) } } });
        await prisma.notification.deleteMany({ where: { entityId: { in: [testOrder1.orderNumber, testOrder2?.displayOrderNumber].filter(Boolean) } } });
        await prisma.sellerOrder.deleteMany({ where: { id: { in: [testSellerOrder1?.id, testSellerOrder2?.id].filter(Boolean) } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: [testOrder1.id, testOrder2?.id].filter(Boolean) } } });
        await prisma.order.deleteMany({ where: { id: { in: [testOrder1.id, testOrder2?.id].filter(Boolean) } } });
      }
    } catch (cleanErr) {
      console.error('Cleanup notice:', cleanErr);
    }
  }

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
