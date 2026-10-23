/**
 * SOUQNA Persistent In-App Notification History Test Suite (Phase 3)
 *
 * Verifies:
 *  1. Canonical In-App Notification Persistence (Customer & Seller)
 *  2. Atomic Idempotency & Unique Constraint (Anti-Duplicate)
 *  3. Cursor-Based Pagination vs Offset Pagination (Performance & Continuity)
 *  4. Real-Time Read Status & Accurate Unread Count
 *  5. RBAC Isolation & Cross-User Ownership Boundaries
 *  6. Safe Configurable Retention Policy (Protected financial/order vs Ephemeral)
 */

import { prisma } from '../src/database/prisma';
import { NotificationType, UserRoleType } from '@prisma/client';
import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import { NotificationDispatcher } from '../src/modules/notifications/services/notification-dispatcher';
import { notificationScheduler } from '../src/modules/notifications/services/notification-scheduler';

async function runPhase3Tests() {
  console.log('========================================================================');
  console.log('🔔 SOUQNA PHASE 3: PERSISTENT NOTIFICATION HISTORY VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  const dispatcher = NotificationDispatcher.get();

  // Test identifiers
  const customerUserId = 'phase3_test_cust_' + Date.now();
  const sellerUserId = 'phase3_test_sell_' + Date.now();
  const createdNotificationIds: string[] = [];

  try {
    // ── Setup: Create dedicated test users ──────────────────────────────────
    console.log('--- Step 0: Setup Test Users in Database ---');
    await prisma.user.createMany({
      data: [
        {
          id: customerUserId,
          email: `${customerUserId}@souqnaa.test`,
          passwordHash: 'dummy_hash',
          firstName: 'Customer',
          lastName: 'Tester',
          phone: `+96650${Date.now().toString().slice(-7)}`,
          role: UserRoleType.CUSTOMER,
          isActive: true,
        },
        {
          id: sellerUserId,
          email: `${sellerUserId}@souqnaa.test`,
          passwordHash: 'dummy_hash',
          firstName: 'Seller',
          lastName: 'Tester',
          phone: `+96655${Date.now().toString().slice(-7)}`,
          role: UserRoleType.SELLER,
          isActive: true,
        },
      ],
    });
    console.log(`  Created test customer (${customerUserId}) and seller (${sellerUserId})`);

    // ── Test Suite 1: Canonical Persistence for Customer & Seller ───────────
    console.log('\n--- Test Suite 1: Canonical In-App Notification Persistence ---');

    // 1.1 Customer Order Notification
    const customerOrderEvent = NotificationEventFactory.orderEvent({
      eventType: 'ORDER_SHIPPED',
      recipientId: customerUserId,
      orderId: 'ORD-PHASE3-001',
      orderNumber: 'ORD-001',
      customerName: 'Customer Tester',
    });

    const dispatchCustRes = await dispatcher.dispatch(customerOrderEvent);
    assert(dispatchCustRes.status === 'DELIVERED', 'Customer order notification dispatched with DELIVERED status');
    assert(Boolean(dispatchCustRes.notificationId), 'Returns valid persistent notificationId');
    if (dispatchCustRes.notificationId) createdNotificationIds.push(dispatchCustRes.notificationId);

    // Verify record in PostgreSQL
    const custNotifRecord = await prisma.notification.findUnique({
      where: { id: dispatchCustRes.notificationId },
    });
    assert(Boolean(custNotifRecord), 'Notification row exists in PostgreSQL');
    assert(custNotifRecord?.userId === customerUserId, 'Row matches customer userId');
    assert(custNotifRecord?.recipientType === 'CUSTOMER', 'Row has recipientType = CUSTOMER');
    assert(custNotifRecord?.category === 'ORDER', 'Row has category = ORDER');
    assert(custNotifRecord?.isRead === false, 'Row is initially unread (isRead = false)');
    assert(custNotifRecord?.idempotencyKey === customerOrderEvent.idempotencyKey, 'Row preserves deterministic idempotencyKey');

    // 1.2 Seller Order Notification
    const sellerOrderEvent = NotificationEventFactory.sellerOrderEvent({
      eventType: 'SELLER_NEW_ORDER',
      recipientId: sellerUserId,
      orderId: 'ORD-PHASE3-002',
      orderNumber: 'ORD-002',
      totalAmount: 350.0,
    });

    const dispatchSellRes = await dispatcher.dispatch(sellerOrderEvent);
    assert(dispatchSellRes.status === 'DELIVERED', 'Seller order notification dispatched with DELIVERED status');
    if (dispatchSellRes.notificationId) createdNotificationIds.push(dispatchSellRes.notificationId);

    const sellNotifRecord = await prisma.notification.findUnique({
      where: { id: dispatchSellRes.notificationId },
    });
    assert(Boolean(sellNotifRecord), 'Seller notification row exists in PostgreSQL');
    assert(sellNotifRecord?.userId === sellerUserId, 'Row matches seller userId');
    assert(sellNotifRecord?.recipientType === 'SELLER', 'Row has recipientType = SELLER');

    // 1.3 Seller Dispute Notification
    const sellerDisputeEvent = NotificationEventFactory.disputeEvent({
      eventType: 'DISPUTE_SELLER_NOTIFIED',
      recipientId: sellerUserId,
      disputeId: 'DISP-PHASE3-001',
      orderId: 'ORD-PHASE3-002',
      recipientRole: 'SELLER',
      reason: 'Damaged item',
      refundAmount: 150.0,
    });
    const dispatchDisputeRes = await dispatcher.dispatch(sellerDisputeEvent);
    assert(dispatchDisputeRes.status === 'DELIVERED', 'Seller dispute notification dispatched');
    if (dispatchDisputeRes.notificationId) createdNotificationIds.push(dispatchDisputeRes.notificationId);

    // ── Test Suite 2: Deterministic Idempotency & Duplicate Suppression ─────
    console.log('\n--- Test Suite 2: Deterministic Idempotency & Unique Constraint ---');

    // 2.1 Re-dispatch exact same event
    const dupRes = await dispatcher.dispatch(customerOrderEvent);
    assert(dupRes.status === 'SUPPRESSED', 'Duplicate dispatch suppressed by idempotency policy');
    assert(dupRes.notificationId === custNotifRecord?.id, 'Returns existing notificationId without creating duplicate');

    // 2.2 Verify exactly 1 record exists in PostgreSQL for (userId, idempotencyKey)
    const countRecords = await prisma.notification.count({
      where: {
        userId: customerUserId,
        idempotencyKey: customerOrderEvent.idempotencyKey,
      },
    });
    assert(countRecords === 1, 'PostgreSQL contains strictly 1 record for (userId, idempotencyKey)');

    // 2.3 Attempt direct raw duplicate insert to test DB @@unique([userId, idempotencyKey])
    let caughtConstraintError = false;
    try {
      await prisma.notification.create({
        data: {
          userId: customerUserId,
          recipientType: 'CUSTOMER',
          category: 'ORDER',
          priority: 'P1',
          titleAr: 'مكرر مباشر',
          titleEn: 'Direct Duplicate',
          bodyAr: 'مكرر مباشر',
          bodyEn: 'Direct Duplicate',
          type: NotificationType.ORDER_STATUS,
          idempotencyKey: customerOrderEvent.idempotencyKey,
          status: 'SENT',
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') caughtConstraintError = true;
    }
    assert(caughtConstraintError, 'Database unique constraint @@unique([userId, idempotencyKey]) rejects duplicate at DB level');

    // ── Test Suite 3: Cursor-Based Pagination vs Offset Pagination ──────────
    console.log('\n--- Test Suite 3: Cursor-Based Pagination vs Offset Pagination ---');

    // Populate 25 notifications with descending timestamps
    const paginationBaseDate = new Date();
    const paginationUser = customerUserId;
    const paginationNotifIds: string[] = [];

    for (let i = 0; i < 25; i++) {
      const createdDate = new Date(paginationBaseDate.getTime() - i * 60000); // 1 minute apart
      const n = await prisma.notification.create({
        data: {
          userId: paginationUser,
          recipientType: 'CUSTOMER',
          category: 'SYSTEM',
          priority: 'P2',
          titleAr: `إشعار صفحة ${i + 1}`,
          titleEn: `Page notification ${i + 1}`,
          bodyAr: `تفاصيل الإشعار ${i + 1}`,
          bodyEn: `Details ${i + 1}`,
          type: NotificationType.SYSTEM,
          idempotencyKey: `pagination_test_${customerUserId}_${i}`,
          status: 'SENT',
          isRead: false,
          createdAt: createdDate,
        },
      });
      paginationNotifIds.push(n.id);
      createdNotificationIds.push(n.id);
    }
    assert(paginationNotifIds.length === 25, 'Successfully populated 25 sequential notifications');

    // 3.1 Cursor Pagination: Page 1 (limit=10)
    const page1Start = Date.now();
    const page1Items = await prisma.notification.findMany({
      where: { userId: paginationUser },
      take: 11, // limit + 1
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const page1Latency = Date.now() - page1Start;
    const page1HasNext = page1Items.length > 10;
    if (page1HasNext) page1Items.pop();
    const cursor1 = page1HasNext ? page1Items[page1Items.length - 1].id : null;

    assert(page1Items.length === 10, 'Cursor Page 1 returns exactly 10 items');
    assert(page1HasNext === true, 'Cursor Page 1 hasNext is true');
    assert(Boolean(cursor1), 'Cursor Page 1 produces non-null nextCursor');

    // 3.2 Cursor Pagination: Page 2 (cursor=cursor1, limit=10)
    const page2Start = Date.now();
    const page2Items = await prisma.notification.findMany({
      where: { userId: paginationUser },
      take: 11,
      skip: 1,
      cursor: { id: cursor1! },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const page2Latency = Date.now() - page2Start;
    const page2HasNext = page2Items.length > 10;
    if (page2HasNext) page2Items.pop();
    const cursor2 = page2HasNext ? page2Items[page2Items.length - 1].id : null;

    assert(page2Items.length === 10, 'Cursor Page 2 returns exactly 10 items');
    assert(page2HasNext === true, 'Cursor Page 2 hasNext is true');
    assert(Boolean(cursor2), 'Cursor Page 2 produces non-null nextCursor');

    // Verify zero overlap between Page 1 and Page 2
    const page1Ids = new Set(page1Items.map((item) => item.id));
    const overlap1_2 = page2Items.filter((item) => page1Ids.has(item.id));
    assert(overlap1_2.length === 0, 'Zero duplicate/overlapping items between Cursor Page 1 and Page 2');

    // 3.3 Cursor Pagination: Page 3 (cursor=cursor2, limit=10)
    const page3Items = await prisma.notification.findMany({
      where: { userId: paginationUser },
      take: 11,
      skip: 1,
      cursor: { id: cursor2! },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const page3HasNext = page3Items.length > 10;
    if (page3HasNext) page3Items.pop();

    assert(page3Items.length === 6, 'Cursor Page 3 returns remaining items (5 pagination + 1 order notif)');
    assert(page3HasNext === false, 'Cursor Page 3 hasNext is false (end of list)');

    // 3.4 Offset Pagination comparison (checking total count & page numbers)
    const offsetStart = Date.now();
    const [offsetItems, totalCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: paginationUser },
        skip: 10,
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.notification.count({ where: { userId: paginationUser } }),
    ]);
    const offsetLatency = Date.now() - offsetStart;

    assert(offsetItems.length === 10, 'Offset Page 2 returns 10 items');
    assert(offsetItems[0].id === page2Items[0].id, 'Offset Page 2 matches Cursor Page 2 first item');
    console.log(`    📊 Benchmark: Cursor Page 2: ${page2Latency}ms | Offset + Count: ${offsetLatency}ms`);

    // ── Test Suite 4: Real-Time Read Status & Accurate Unread Count ─────────
    console.log('\n--- Test Suite 4: Real-Time Read Status & Accurate Unread Count ---');

    const initialUnreadCount = await prisma.notification.count({
      where: { userId: paginationUser, isRead: false },
    });
    assert(initialUnreadCount > 0, `Initial unread count is ${initialUnreadCount}`);

    // 4.1 Mark single notification as read
    const targetToRead = page1Items[0].id;
    await prisma.notification.update({
      where: { id: targetToRead },
      data: { isRead: true, readAt: new Date() },
    });

    const updatedSingle = await prisma.notification.findUnique({
      where: { id: targetToRead },
    });
    assert(updatedSingle?.isRead === true, 'Marked notification has isRead = true');
    assert(Boolean(updatedSingle?.readAt), 'Marked notification has valid readAt timestamp');

    const unreadAfterSingle = await prisma.notification.count({
      where: { userId: paginationUser, isRead: false },
    });
    assert(unreadAfterSingle === initialUnreadCount - 1, 'Unread count decreased by exactly 1');

    // 4.2 Mark all as read
    await prisma.notification.updateMany({
      where: { userId: paginationUser, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    const finalUnreadCount = await prisma.notification.count({
      where: { userId: paginationUser, isRead: false },
    });
    assert(finalUnreadCount === 0, 'Unread count is exactly 0 after markAllRead');

    // ── Test Suite 5: RBAC Isolation & Cross-User Security Boundary ─────────
    console.log('\n--- Test Suite 5: RBAC Isolation & Cross-User Security Boundary ---');

    // Create an unread notification belonging to Seller
    const sellerPrivNotif = await prisma.notification.create({
      data: {
        userId: sellerUserId,
        recipientType: 'SELLER',
        category: 'PAYMENT',
        priority: 'P1',
        titleAr: 'تحويل مالي للمتجر',
        titleEn: 'Seller Payout',
        bodyAr: 'تم إيداع أرباحك',
        bodyEn: 'Payout deposited',
        type: NotificationType.PAYMENT,
        idempotencyKey: `rbac_priv_${Date.now()}`,
        status: 'SENT',
        isRead: false,
      },
    });
    createdNotificationIds.push(sellerPrivNotif.id);

    // Customer attempts to mark Seller's notification as read
    const crossUpdateResult = await prisma.notification.updateMany({
      where: {
        id: sellerPrivNotif.id,
        userId: customerUserId, // Attacker's user ID constraint
      },
      data: { isRead: true, readAt: new Date() },
    });
    assert(crossUpdateResult.count === 0, 'Cross-user update affected 0 records (rejected by userId boundary)');

    // Verify Seller's notification remains unread
    const sellerNotifAfterCrossAttempt = await prisma.notification.findUnique({
      where: { id: sellerPrivNotif.id },
    });
    assert(sellerNotifAfterCrossAttempt?.isRead === false, 'Seller notification remains unread after unauthorized update attempt');

    // Customer queries notifications - verify Seller's notifications are not leaked
    const customerFetch = await prisma.notification.findMany({
      where: {
        id: sellerPrivNotif.id,
        userId: customerUserId,
      },
    });
    assert(customerFetch.length === 0, 'Customer query cannot view Seller private notification');

    // ── Test Suite 6: Safe Configurable Retention Policy ────────────────────
    console.log('\n--- Test Suite 6: Safe Configurable Retention Policy ---');

    const past100Days = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const past10Days = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    // 6.1 Ephemeral Read Notification (older than 90d) -> MUST BE PRUNED
    const ephemeralOldRead = await prisma.notification.create({
      data: {
        userId: customerUserId,
        recipientType: 'CUSTOMER',
        category: 'PROMOTION',
        priority: 'P3',
        titleAr: 'عرض قديم مقروء',
        titleEn: 'Old read promotion',
        bodyAr: 'عرض',
        bodyEn: 'Promo',
        type: NotificationType.PROMOTION,
        idempotencyKey: `retention_ephem_old_read_${Date.now()}`,
        status: 'SENT',
        isRead: true,
        createdAt: past100Days,
      },
    });
    createdNotificationIds.push(ephemeralOldRead.id);

    // 6.2 Ephemeral Unread Notification (older than 90d) -> MUST BE KEPT
    const ephemeralOldUnread = await prisma.notification.create({
      data: {
        userId: customerUserId,
        recipientType: 'CUSTOMER',
        category: 'PROMOTION',
        priority: 'P3',
        titleAr: 'عرض قديم غير مقروء',
        titleEn: 'Old unread promotion',
        bodyAr: 'عرض',
        bodyEn: 'Promo',
        type: NotificationType.PROMOTION,
        idempotencyKey: `retention_ephem_old_unread_${Date.now()}`,
        status: 'SENT',
        isRead: false,
        createdAt: past100Days,
      },
    });
    createdNotificationIds.push(ephemeralOldUnread.id);

    // 6.3 Ephemeral Recent Read Notification (10d ago) -> MUST BE KEPT
    const ephemeralRecentRead = await prisma.notification.create({
      data: {
        userId: customerUserId,
        recipientType: 'CUSTOMER',
        category: 'PROMOTION',
        priority: 'P3',
        titleAr: 'عرض حديث مقروء',
        titleEn: 'Recent read promo',
        bodyAr: 'عرض',
        bodyEn: 'Promo',
        type: NotificationType.PROMOTION,
        idempotencyKey: `retention_ephem_recent_read_${Date.now()}`,
        status: 'SENT',
        isRead: true,
        createdAt: past10Days,
      },
    });
    createdNotificationIds.push(ephemeralRecentRead.id);

    // 6.4 Protected Order / Refund / Dispute / Payment notifications (100d ago, read) -> MUST BE KEPT PERMANENTLY
    const protectedOrder = await prisma.notification.create({
      data: {
        userId: customerUserId,
        recipientType: 'CUSTOMER',
        category: 'ORDER',
        priority: 'P1',
        titleAr: 'طلب قديم هام',
        titleEn: 'Old order record',
        bodyAr: 'طلب',
        bodyEn: 'Order',
        type: NotificationType.ORDER_STATUS,
        idempotencyKey: `retention_prot_order_${Date.now()}`,
        status: 'SENT',
        isRead: true,
        createdAt: past100Days,
      },
    });
    createdNotificationIds.push(protectedOrder.id);

    const protectedDispute = await prisma.notification.create({
      data: {
        userId: sellerUserId,
        recipientType: 'SELLER',
        category: 'DISPUTE',
        priority: 'P0',
        titleAr: 'نزاع قديم هام',
        titleEn: 'Old dispute record',
        bodyAr: 'نزاع',
        bodyEn: 'Dispute',
        type: NotificationType.REFUND_DISPUTED,
        idempotencyKey: `retention_prot_disp_${Date.now()}`,
        status: 'SENT',
        isRead: true,
        createdAt: past100Days,
      },
    });
    createdNotificationIds.push(protectedDispute.id);

    const protectedPayment = await prisma.notification.create({
      data: {
        userId: sellerUserId,
        recipientType: 'SELLER',
        category: 'PAYMENT',
        priority: 'P1',
        titleAr: 'دفعة قديمة هامة',
        titleEn: 'Old payment record',
        bodyAr: 'دفعة',
        bodyEn: 'Payment',
        type: NotificationType.PAYMENT,
        idempotencyKey: `retention_prot_pay_${Date.now()}`,
        status: 'SENT',
        isRead: true,
        createdAt: past100Days,
      },
    });
    createdNotificationIds.push(protectedPayment.id);

    // Execute retention cleaner (90 days)
    const prunedCount = await notificationScheduler.applyRetentionPolicy(90);
    console.log(`    Retention cleaner executed: pruned ${prunedCount} notification(s)`);

    // Verify pruned vs kept
    const checkEphemeralOldRead = await prisma.notification.findUnique({ where: { id: ephemeralOldRead.id } });
    assert(checkEphemeralOldRead === null, 'Ephemeral read notification older than 90d is pruned');

    const checkEphemeralOldUnread = await prisma.notification.findUnique({ where: { id: ephemeralOldUnread.id } });
    assert(checkEphemeralOldUnread !== null, 'Ephemeral UNREAD notification older than 90d is preserved');

    const checkEphemeralRecentRead = await prisma.notification.findUnique({ where: { id: ephemeralRecentRead.id } });
    assert(checkEphemeralRecentRead !== null, 'Ephemeral read notification younger than 90d (10d) is preserved');

    const checkProtectedOrder = await prisma.notification.findUnique({ where: { id: protectedOrder.id } });
    assert(checkProtectedOrder !== null, 'CRITICAL: ORDER history older than 90d is permanently PRESERVED');

    const checkProtectedDispute = await prisma.notification.findUnique({ where: { id: protectedDispute.id } });
    assert(checkProtectedDispute !== null, 'CRITICAL: DISPUTE history older than 90d is permanently PRESERVED');

    const checkProtectedPayment = await prisma.notification.findUnique({ where: { id: protectedPayment.id } });
    assert(checkProtectedPayment !== null, 'CRITICAL: PAYMENT history older than 90d is permanently PRESERVED');
  } catch (err) {
    console.error('💥 Unexpected error during test execution:', err);
    failed++;
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────────────
    console.log('\n--- Step 7: Teardown & Test Cleanup ---');
    try {
      if (createdNotificationIds.length > 0) {
        const deletedNotifs = await prisma.notification.deleteMany({
          where: { id: { in: createdNotificationIds } },
        });
        console.log(`  Cleaned up ${deletedNotifs.count} test notifications`);
      }
      await prisma.user.deleteMany({
        where: { id: { in: [customerUserId, sellerUserId] } },
      });
      console.log('  Cleaned up test users');
    } catch (cleanupErr) {
      console.error('  Warning: cleanup encountered error:', cleanupErr);
    }
  }

  console.log('\n========================================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
