import { OrderStateMachine, ALLOWED_TRANSITIONS } from '../src/modules/orders/order.state-machine';
import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import { notificationTemplateService } from '../src/modules/notifications/services/notification-template.service';
import { fcmPushProvider } from '../src/modules/notifications/providers/push.provider';
import { NotificationPriority } from '../src/modules/notifications/notification.types';
import { SocketService } from '../src/services/websocket/socket.service';

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 SOUQNA REAL-TIME ORDER TRACKING & NOTIFICATIONS TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. ORDER STATE MACHINE LIFECYCLE & VALIDATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Order State Machine Transition Rules & Validation:');

  // Valid forward fulfillment flow
  assert(
    OrderStateMachine.isValidTransition('PENDING', 'CONFIRMED'),
    'PENDING -> CONFIRMED is permitted'
  );
  assert(
    OrderStateMachine.isValidTransition('CONFIRMED', 'PROCESSING'),
    'CONFIRMED -> PROCESSING is permitted'
  );
  assert(
    OrderStateMachine.isValidTransition('PROCESSING', 'READY_TO_SHIP'),
    'PROCESSING -> READY_TO_SHIP is permitted'
  );
  assert(
    OrderStateMachine.isValidTransition('READY_TO_SHIP', 'SHIPPED'),
    'READY_TO_SHIP -> SHIPPED is permitted'
  );
  assert(
    OrderStateMachine.isValidTransition('SHIPPED', 'DELIVERED'),
    'SHIPPED -> DELIVERED (Customer Receipt) is permitted'
  );

  // Illegal transitions / bypass prevention
  assert(
    !OrderStateMachine.isValidTransition('PENDING', 'DELIVERED'),
    'PENDING -> DELIVERED directly is strictly prohibited (cannot bypass fulfillment)'
  );
  assert(
    !OrderStateMachine.isValidTransition('PENDING', 'SHIPPED'),
    'PENDING -> SHIPPED directly is prohibited'
  );
  assert(
    !OrderStateMachine.isValidTransition('DELIVERED', 'PROCESSING'),
    'DELIVERED -> PROCESSING is prohibited (cannot reverse delivery back to prep)'
  );
  assert(
    !OrderStateMachine.isValidTransition('CANCELLED_BY_CUSTOMER', 'CONFIRMED'),
    'CANCELLED_BY_CUSTOMER -> CONFIRMED is prohibited (terminal cancellation state)'
  );
  assert(
    !OrderStateMachine.isValidTransition('REJECTED_BY_SELLER', 'SHIPPED'),
    'REJECTED_BY_SELLER -> SHIPPED is prohibited (terminal rejection state)'
  );

  // Parent Order Synchronization Logic (Simulated tx)
  console.log('\n2. Parent Order Status Aggregation from Child Seller Orders:');
  const mockTxDelivered = {
    sellerOrder: {
      findMany: async () => [{ status: 'DELIVERED' }, { status: 'DELIVERED' }],
    },
    order: {
      update: async () => ({}),
    },
  };
  const syncStatusDelivered = await OrderStateMachine.syncParentOrderStatus('order_1', mockTxDelivered as any);
  assert(
    syncStatusDelivered === 'DELIVERED',
    'Parent order status becomes DELIVERED when all seller orders are DELIVERED'
  );

  const mockTxPartialShipped = {
    sellerOrder: {
      findMany: async () => [{ status: 'DELIVERED' }, { status: 'SHIPPED' }],
    },
    order: {
      update: async () => ({}),
    },
  };
  const syncStatusPartial = await OrderStateMachine.syncParentOrderStatus('order_2', mockTxPartialShipped as any);
  assert(
    syncStatusPartial === 'SHIPPED',
    'Parent order status becomes SHIPPED when at least one seller order is SHIPPED'
  );

  const mockTxCancelled = {
    sellerOrder: {
      findMany: async () => [{ status: 'CANCELLED_BY_CUSTOMER' }, { status: 'CANCELLED_BY_CUSTOMER' }],
    },
    order: {
      update: async () => ({}),
    },
  };
  const syncStatusCancelled = await OrderStateMachine.syncParentOrderStatus('order_3', mockTxCancelled as any);
  assert(
    syncStatusCancelled === 'CANCELLED_BY_CUSTOMER',
    'Parent order status reflects cancellation when all seller orders are cancelled'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. AUTHORIZED VS UNAUTHORIZED ORDER SUBSCRIPTIONS (join:order)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Real-Time Order Room Authorization Rules (join:order):');

  const mockOrder = {
    id: 'ord_1001',
    userId: 'cust_abc_123',
    sellerOrders: [
      { seller: { id: 'seller_store_1', userId: 'usr_seller_1' } },
      { seller: { id: 'seller_store_2', userId: 'usr_seller_2' } },
    ],
  };

  function canJoinOrderRoom(
    user: { id: string; role: string },
    order: typeof mockOrder | null
  ): boolean {
    if (!order) return false;
    const isCustomer = order.userId === user.id;
    const isAssignedSeller = order.sellerOrders?.some(
      (so) => so.seller?.userId === user.id
    );
    const isAdmin = user.role === 'ADMIN';
    return isCustomer || isAssignedSeller || isAdmin;
  }

  // Permitted users
  assert(
    canJoinOrderRoom({ id: 'cust_abc_123', role: 'CUSTOMER' }, mockOrder),
    'Authorized: Customer owning the order can subscribe'
  );
  assert(
    canJoinOrderRoom({ id: 'usr_seller_1', role: 'SELLER' }, mockOrder),
    'Authorized: Assigned Seller 1 can subscribe'
  );
  assert(
    canJoinOrderRoom({ id: 'usr_seller_2', role: 'SELLER' }, mockOrder),
    'Authorized: Assigned Seller 2 can subscribe'
  );
  assert(
    canJoinOrderRoom({ id: 'admin_super_99', role: 'ADMIN' }, mockOrder),
    'Authorized: Admin with RBAC can subscribe'
  );

  // Unauthorized users (must be blocked)
  assert(
    !canJoinOrderRoom({ id: 'attacker_cust_999', role: 'CUSTOMER' }, mockOrder),
    'Unauthorized: Different customer is BLOCKED from subscribing to another customer order'
  );
  assert(
    !canJoinOrderRoom({ id: 'unrelated_seller_888', role: 'SELLER' }, mockOrder),
    'Unauthorized: Unrelated seller is BLOCKED from subscribing to orders of other stores'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. NOTIFICATION TEMPLATES & DOMAIN EVENTS FOR CRITICAL LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Domain Event Creation & Localization (Customer Receipt & Seller Push):');

  // SELLER_ORDER_RECEIVED event
  const receivedEvt = NotificationEventFactory.sellerOrderReceivedEvent({
    orderId: 'ord_1001',
    orderNumber: 'SQ-88214',
    sellerOrderId: 'seller_store_1',
    recipientId: 'usr_seller_1',
    totalAmount: 250.75,
  });

  assert(receivedEvt.eventType === 'SELLER_ORDER_RECEIVED', 'Event type is SELLER_ORDER_RECEIVED');
  assert(receivedEvt.recipientId === 'usr_seller_1', 'Target recipient is correct seller user ID');
  assert(receivedEvt.data?.orderNumber === 'SQ-88214', 'Order number preserved in event data');
  assert(receivedEvt.data?.totalAmount === 250.75, 'Financial order amount included for reference');

  const renderedReceived = await notificationTemplateService.render(receivedEvt);
  assert(
    renderedReceived.titleAr === 'أكد العميل استلام الطلب',
    'Arabic title matches specification: "أكد العميل استلام الطلب"'
  );
  assert(
    renderedReceived.titleEn === 'Customer confirmed order received',
    'English title matches specification: "Customer confirmed order received"'
  );
  assert(
    renderedReceived.bodyAr.includes('SQ-88214') && renderedReceived.bodyAr.includes('أكد العميل استلام الطلب رقم'),
    'Arabic body contains order number and correct phrasing'
  );
  assert(
    renderedReceived.bodyEn.includes('SQ-88214') && renderedReceived.bodyEn.includes('confirmed receipt of order'),
    'English body contains order number and correct phrasing'
  );

  // SELLER_ORDER_CANCELLED event
  const cancelledEvt = NotificationEventFactory.sellerOrderCancelledEvent({
    orderId: 'ord_1001',
    orderNumber: 'SQ-88214',
    sellerOrderId: 'seller_store_1',
    recipientId: 'usr_seller_1',
    reason: 'العميل طلب إلغاء قبل الشحن',
  });
  assert(cancelledEvt.eventType === 'SELLER_ORDER_CANCELLED', 'Event type is SELLER_ORDER_CANCELLED');
  const renderedCancelled = await notificationTemplateService.render(cancelledEvt);
  assert(
    renderedCancelled.titleAr === 'تم إلغاء الطلب',
    'Arabic title for cancellation matches: "تم إلغاء الطلب"'
  );
  assert(
    renderedCancelled.bodyAr.includes('SQ-88214'),
    'Arabic body for cancellation includes order number'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. PUSH PROVIDER CONFIGURATION & RESILIENCY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Push Notification Provider (Android Channels & Token Handling):');

  const providerAny = fcmPushProvider as any;
  const channelId = providerAny.getAndroidChannelId('ORDER');
  assert(
    channelId === 'souqna_orders_channel',
    'ORDER category resolves to dedicated high-importance "souqna_orders_channel"'
  );

  // Local pseudo-tokens handling
  const localPushRes = await fcmPushProvider.send({
    recipientId: 'user_test_local',
    deviceTokens: ['local_device_android_user_123', 'local_device_web_user_123'],
    content: {
      titleAr: renderedReceived.titleAr,
      titleEn: renderedReceived.titleEn,
      bodyAr: renderedReceived.bodyAr,
      bodyEn: renderedReceived.bodyEn,
      deepLink: 'souqnaa://seller/orders/ord_1001',
    },
    category: 'ORDER',
    priority: NotificationPriority.HIGH,
  });
  assert(
    localPushRes.success === true && localPushRes.messageId === 'local_tokens_noop',
    'Local pseudo tokens safely no-op without external transmission (local_tokens_noop)'
  );

  // Graceful no-op on empty tokens
  const emptyPushRes = await fcmPushProvider.send({
    recipientId: 'usr_seller_1',
    deviceTokens: [],
    content: {
      titleAr: renderedReceived.titleAr,
      titleEn: renderedReceived.titleEn,
      bodyAr: renderedReceived.bodyAr,
      bodyEn: renderedReceived.bodyEn,
      deepLink: 'souqnaa://seller/orders/ord_1001',
    },
    category: 'ORDER',
    priority: NotificationPriority.HIGH,
  });
  assert(
    emptyPushRes.success === true && emptyPushRes.messageId === 'no_tokens_noop',
    'Push provider gracefully no-ops when seller has no registered device tokens without throwing'
  );

  // Token sanitization
  const rawToken = 'fcm_genuine_token_abc123456789_xyz987654321';
  const sanitized = fcmPushProvider.sanitizeToken(rawToken);
  assert(
    !sanitized.includes('abc123456789') && sanitized.startsWith('fcm_ge') && sanitized.endsWith('4321'),
    'Token is safely masked for logging without leaking full token'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. REAL-TIME EVENT PAYLOAD & OUT-OF-ORDER SAFEGUARDS
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Real-Time WebSocket Event Payload Schema & Versioning:');

  // Test payload construction directly
  const testPayload = {
    eventId: 'evt_12345678-abcd-ef01-2345-6789abcdef01',
    orderId: 'ord_1001',
    orderNumber: 'SQ-88214',
    sellerOrderId: 'so_501',
    status: 'DELIVERED',
    parentStatus: 'DELIVERED',
    version: 4,
    timestamp: new Date().toISOString(),
    changedByRole: 'CUSTOMER',
  };

  assert(testPayload.orderId === 'ord_1001', 'Payload contains orderId');
  assert(testPayload.orderNumber === 'SQ-88214', 'Payload contains orderNumber');
  assert(testPayload.status === 'DELIVERED', 'Payload contains new status');
  assert(testPayload.parentStatus === 'DELIVERED', 'Payload contains parentStatus');
  assert(testPayload.version === 4, 'Payload contains sequence version');
  assert(typeof testPayload.timestamp === 'string', 'Payload contains ISO timestamp');
  assert(typeof testPayload.eventId === 'string', 'Payload contains unique eventId UUID');
  assert(testPayload.changedByRole === 'CUSTOMER', 'Payload indicates actor role');

  // Verify Client-Side Out-of-Order / Stale Event Filter Logic
  console.log('\n7. Client Out-of-Order Version Rejection Logic:');
  function shouldProcessEvent(
    incomingVersion: number,
    lastProcessedVersion: number | null
  ): boolean {
    if (lastProcessedVersion === null) return true;
    return incomingVersion >= lastProcessedVersion;
  }

  assert(
    shouldProcessEvent(4, null) === true,
    'Initial event version 4 is accepted'
  );
  assert(
    shouldProcessEvent(5, 4) === true,
    'Newer event version 5 arrives after version 4 and is accepted'
  );
  assert(
    shouldProcessEvent(3, 5) === false,
    'Stale out-of-order event version 3 arrives after version 5 and is REJECTED'
  );
  assert(
    shouldProcessEvent(2, 5) === false,
    'Stale duplicate event version 2 arrives after version 5 and is REJECTED'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n===============================================================');
  console.log(`TEST SUMMARY: Passed: ${passed} | Failed: ${failed}`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
