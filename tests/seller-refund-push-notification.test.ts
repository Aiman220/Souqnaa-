import { NotificationPriority, AppType, NotificationCategory } from '../src/modules/notifications/notification.types';
import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import { NotificationTemplateService } from '../src/modules/notifications/services/notification-template.service';
import { NotificationDeduplicationService } from '../src/modules/notifications/services/notification-deduplication.service';
import { FcmPushProvider } from '../src/modules/notifications/providers/push.provider';

async function runSellerRefundPushTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING SOUQNA SELLER REFUND PUSH NOTIFICATION REGRESSION TESTS');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${details ? ' - ' + details : ''}`);
      failed++;
    }
  }

  const templateService = NotificationTemplateService.get();
  const dedupService = NotificationDeduplicationService.get();
  const pushProvider = new FcmPushProvider();

  // ── 1. Event Generation & Seller Account Isolation ─────────────────────────
  console.log('1. Event Generation, Idempotency & Multi-Seller Isolation:');
  {
    const refundId = 'ref_test_001';
    const customerUserId = 'user_cust_123';
    const sellerAUserId = 'user_seller_a';
    const sellerBUserId = 'user_seller_b';
    const orderNumber = 'ORD-2026-9901';
    const orderId = 'ord_test_9901';

    // Seller A event
    const sellerEvent = NotificationEventFactory.refundEvent({
      eventType: 'SELLER_REFUND_REQUEST',
      recipientId: sellerAUserId,
      refundId,
      refundNumber: 'RF-9901-01',
      orderId,
      orderNumber,
      amount: 15000,
      currency: 'YER',
      isSeller: true,
    });

    // Customer event
    const customerEvent = NotificationEventFactory.refundEvent({
      eventType: 'REFUND_REQUESTED',
      recipientId: customerUserId,
      refundId,
      refundNumber: 'RF-9901-01',
      orderId,
      orderNumber,
      amount: 15000,
      currency: 'YER',
    });

    assert(
      sellerEvent.eventType === 'SELLER_REFUND_REQUEST',
      'Seller event type resolved to SELLER_REFUND_REQUEST'
    );
    assert(
      sellerEvent.recipientType === AppType.SELLER,
      'Seller event recipientType is SELLER'
    );
    assert(
      sellerEvent.recipientId === sellerAUserId,
      'Seller event recipient is seller A (and not seller B or customer)'
    );
    assert(
      sellerEvent.idempotencyKey !== customerEvent.idempotencyKey,
      'Seller and customer have distinct idempotency keys (no collision)'
    );

    // Multi-seller isolation check
    const isSellerBDuplicate = await dedupService.isDuplicate(sellerEvent);
    assert(!isSellerBDuplicate, 'First dispatch to Seller A is not marked duplicate');

    // Duplicate submission check
    const isDuplicateSubmission = await dedupService.isDuplicate(sellerEvent);
    assert(isDuplicateSubmission, 'Second identical request for Seller A is properly marked duplicate');

    // Seller B receives a different refund request for their own items
    const sellerBEvent = NotificationEventFactory.refundEvent({
      eventType: 'SELLER_REFUND_REQUEST',
      recipientId: sellerBUserId,
      refundId: 'ref_test_002',
      refundNumber: 'RF-9901-02',
      orderId,
      orderNumber,
      amount: 8000,
      isSeller: true,
    });
    const isSellerBUnique = await dedupService.isDuplicate(sellerBEvent);
    assert(isSellerBUnique === false, 'Seller B receives independent notification for their own items');
  }

  // ── 2. Bilingual Content & Template Rendering ─────────────────────────────
  console.log('\n2. Bilingual Content & Template Rendering (Arabic & English):');
  {
    const refundEvent = NotificationEventFactory.refundEvent({
      eventType: 'SELLER_REFUND_REQUEST',
      recipientId: 'user_seller_a',
      refundId: 'ref_bilingual_01',
      refundNumber: 'RF-1001',
      orderId: 'ord_1001',
      orderNumber: 'ORD-5544',
      amount: 25000,
      isSeller: true,
    });

    const rendered = await templateService.render(refundEvent);

    assert(
      rendered.titleEn === 'New Refund Request',
      'English title matches exact specification: "New Refund Request"',
      `Actual: "${rendered.titleEn}"`
    );
    assert(
      rendered.bodyEn === 'A customer has requested a refund for order #ORD-5544.',
      'English body matches exact specification: "A customer has requested a refund for order #{orderNumber}."',
      `Actual: "${rendered.bodyEn}"`
    );
    assert(
      rendered.titleAr === 'طلب استرجاع جديد',
      'Arabic title matches exact specification: "طلب استرجاع جديد"',
      `Actual: "${rendered.titleAr}"`
    );
    assert(
      rendered.bodyAr === 'طلب العميل استرجاع الطلب #ORD-5544.',
      'Arabic body matches exact specification: "طلب العميل استرجاع الطلب #{orderNumber}."',
      `Actual: "${rendered.bodyAr}"`
    );
    assert(
      rendered.deepLink === 'souqnaa://seller/refunds/ref_bilingual_01',
      'Deep link routes to seller refund details screen'
    );
  }

  // ── 3. FCM Push Payload Construction & Data Integrity ──────────────────────
  console.log('\n3. FCM Push Payload Construction & Data Integrity:');
  {
    const rendered = await templateService.render(
      NotificationEventFactory.refundEvent({
        eventType: 'SELLER_REFUND_REQUEST',
        recipientId: 'user_seller_a',
        refundId: 'ref_payload_77',
        refundNumber: 'RF-77',
        orderId: 'ord_payload_88',
        orderNumber: 'ORD-88',
        amount: 12000,
        isSeller: true,
      })
    );

    const fcmMessage = pushProvider.buildFcmMessage('fcm_token_device_abc', {
      recipientId: 'user_seller_a',
      notificationId: 'notif_uuid_999',
      content: rendered,
      category: NotificationCategory.REFUND,
      priority: NotificationPriority.HIGH,
      entityType: 'refund',
      entityId: 'ref_payload_77',
      data: {
        type: 'REFUND_REQUESTED',
        refundId: 'ref_payload_77',
        orderId: 'ord_payload_88',
        customerName: 'SENSITIVE_CUSTOMER_NAME', // should be stripped!
        customerEmail: 'customer@example.com',    // should be stripped!
        customerPhone: '+96777000000',           // should be stripped!
      },
    });

    const data = fcmMessage.message.data;
    assert(
      data.type === 'REFUND_REQUESTED',
      'FCM data payload includes type: "REFUND_REQUESTED"'
    );
    assert(
      data.refundId === 'ref_payload_77',
      'FCM data payload includes refundId'
    );
    assert(
      data.orderId === 'ord_payload_88',
      'FCM data payload includes orderId'
    );
    assert(
      data.notificationId === 'notif_uuid_999',
      'FCM data payload includes notificationId'
    );
    assert(
      data.deepLink === 'souqnaa://seller/refunds/ref_payload_77',
      'FCM data payload includes valid seller deepLink'
    );

    // Verify privacy & security (Customer PII is stripped)
    assert(
      data.customerName === undefined &&
      data.customerEmail === undefined &&
      data.customerPhone === undefined,
      'Customer sensitive PII is stripped and not exposed in FCM data payload'
    );

    // Verify Android configuration
    const android = fcmMessage.message.android;
    assert(
      android?.priority === 'HIGH',
      'Android priority is HIGH for instant delivery'
    );
    assert(
      android?.notification?.channel_id === 'souqna_refunds_channel',
      'Uses dedicated souqna_refunds_channel'
    );
  }

  // ── 4. Token Invalidation & Missing Tokens Handling ────────────────────────
  console.log('\n4. Token Invalidation & Missing Tokens Handling:');
  {
    // Empty tokens no-op
    const noTokensResult = await pushProvider.send({
      recipientId: 'user_no_tokens',
      content: {
        titleAr: 'اختبار',
        titleEn: 'Test',
        bodyAr: 'اختبار',
        bodyEn: 'Test',
      },
      category: NotificationCategory.REFUND,
      priority: NotificationPriority.HIGH,
      deviceTokens: [],
    });

    assert(
      noTokensResult.success === true && noTokensResult.messageId === 'no_tokens_noop',
      'Missing device tokens handled safely as no-op without crashing'
    );

    // Local pseudo-tokens no-op
    const localTokensResult = await pushProvider.send({
      recipientId: 'user_local_tokens',
      content: {
        titleAr: 'اختبار',
        titleEn: 'Test',
        bodyAr: 'اختبار',
        bodyEn: 'Test',
      },
      category: NotificationCategory.REFUND,
      priority: NotificationPriority.HIGH,
      deviceTokens: ['local_mock_token_123'],
    });

    assert(
      localTokensResult.success === true && localTokensResult.messageId === 'local_tokens_noop',
      'Local pseudo-tokens filtered out safely'
    );
  }

  // ── 5. Transient Error Retries & Error Logging ─────────────────────────────
  console.log('\n5. Transient Error Retries & Credentials Isolation:');
  {
    // Mock credentials to test retry and invalid token detection
    pushProvider.credentialsOverride = {
      projectId: 'test-project',
      clientEmail: 'test@souqnaa.iam.gserviceaccount.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----',
    };

    // Override getAccessToken to avoid hitting real Google OAuth
    (pushProvider as any).getAccessToken = async () => 'mock_access_token_123';

    let fetchAttempts = 0;
    const originalFetch = global.fetch;

    // Simulate transient 503 Service Unavailable, then success on attempt 2
    global.fetch = (async (url: any, init: any) => {
      fetchAttempts++;
      if (fetchAttempts === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable (High Load)',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'projects/test-project/messages/msg_recovered_001' }),
      } as any;
    }) as any;

    try {
      const retryResult = await pushProvider.send({
        recipientId: 'user_seller_transient',
        content: {
          titleAr: 'طلب استرجاع جديد',
          titleEn: 'New Refund Request',
          bodyAr: 'طلب العميل استرجاع الطلب #ORD-1',
          bodyEn: 'A customer has requested a refund for order #ORD-1.',
        },
        category: NotificationCategory.REFUND,
        priority: NotificationPriority.HIGH,
        deviceTokens: ['fcm_token_valid_transient_retry'],
      });

      assert(
        fetchAttempts === 2,
        'Transient Firebase error (503) triggered retry'
      );
      assert(
        retryResult.success === true && retryResult.messageId === 'projects/test-project/messages/msg_recovered_001',
        'Notification successfully delivered after retry'
      );
    } finally {
      global.fetch = originalFetch;
    }

    // Simulate permanent 404 UNREGISTERED token
    fetchAttempts = 0;
    global.fetch = (async (url: any, init: any) => {
      fetchAttempts++;
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error: {
            code: 404,
            message: 'Requested entity was not found.',
            status: 'NOT_FOUND',
            details: [{ errorCode: 'UNREGISTERED' }],
          },
        }),
      } as any;
    }) as any;

    try {
      const invalidTokenResult = await pushProvider.send({
        recipientId: 'user_seller_unregistered',
        content: {
          titleAr: 'طلب استرجاع جديد',
          titleEn: 'New Refund Request',
          bodyAr: 'طلب العميل استرجاع الطلب #ORD-2',
          bodyEn: 'A customer has requested a refund for order #ORD-2.',
        },
        category: NotificationCategory.REFUND,
        priority: NotificationPriority.HIGH,
        deviceTokens: ['fcm_expired_token_xyz'],
      });

      assert(
        fetchAttempts === 1,
        'Permanent invalid token (UNREGISTERED) is NOT retried'
      );
      assert(
        invalidTokenResult.invalidTokens?.includes('fcm_expired_token_xyz') === true,
        'Invalid token collected in invalidTokens for database deactivation'
      );
    } finally {
      global.fetch = originalFetch;
      pushProvider.credentialsOverride = undefined;
    }
  }

  // ── 6. Refund Lifecycle Event Isolation ────────────────────────────────────
  console.log('\n6. Refund Lifecycle Event Isolation:');
  {
    const requested = NotificationEventFactory.refundEvent({
      eventType: 'SELLER_REFUND_REQUEST',
      recipientId: 'user_seller_a',
      refundId: 'ref_lifecycle',
      refundNumber: 'RF-1',
      isSeller: true,
    });
    const approved = NotificationEventFactory.refundEvent({
      eventType: 'REFUND_ACCEPTED',
      recipientId: 'user_cust',
      refundId: 'ref_lifecycle',
      refundNumber: 'RF-1',
    });
    const rejected = NotificationEventFactory.refundEvent({
      eventType: 'REFUND_REJECTED',
      recipientId: 'user_cust',
      refundId: 'ref_lifecycle',
      refundNumber: 'RF-1',
    });
    const completed = NotificationEventFactory.refundEvent({
      eventType: 'REFUND_COMPLETED',
      recipientId: 'user_cust',
      refundId: 'ref_lifecycle',
      refundNumber: 'RF-1',
    });

    assert(
      requested.eventType === 'SELLER_REFUND_REQUEST',
      'REFUND_REQUESTED for seller maps to SELLER_REFUND_REQUEST'
    );
    assert(
      approved.eventType === 'REFUND_ACCEPTED',
      'REFUND_ACCEPTED is distinct'
    );
    assert(
      rejected.eventType === 'REFUND_REJECTED',
      'REFUND_REJECTED is distinct'
    );
    assert(
      completed.eventType === 'REFUND_COMPLETED',
      'REFUND_COMPLETED is distinct'
    );
  }

  console.log('\n========================================================================');
  console.log(`🏁 TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSellerRefundPushTests().catch((err) => {
  console.error('Test runner encountered unexpected error:', err);
  process.exit(1);
});
