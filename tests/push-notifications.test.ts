import { fcmPushProvider } from '../src/modules/notifications/providers/push.provider';
import {
  NotificationChannel,
  NotificationPriority,
} from '../src/modules/notifications/notification.types';

async function runPushTests() {
  console.log('==================================================');
  console.log('🧪 RUNNING SOUQNA PUSH NOTIFICATION BACKEND TESTS');
  console.log('==================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. Channel Resolution
  console.log('1. Android Notification Channel ID Resolution:');
  const providerAny = fcmPushProvider as any;
  assert(providerAny.getAndroidChannelId('ORDER') === 'souqna_orders_channel', 'ORDER resolves to souqna_orders_channel');
  assert(providerAny.getAndroidChannelId('PAYMENT') === 'souqna_payments_channel', 'PAYMENT resolves to souqna_payments_channel');
  assert(providerAny.getAndroidChannelId('REFUND') === 'souqna_refunds_channel', 'REFUND resolves to souqna_refunds_channel');
  assert(providerAny.getAndroidChannelId('CHAT') === 'souqna_chat_channel', 'CHAT resolves to souqna_chat_channel');
  assert(providerAny.getAndroidChannelId('PROMOTION') === 'souqna_promotions_channel', 'PROMOTION resolves to souqna_promotions_channel');
  assert(providerAny.getAndroidChannelId('FLASH_SALE') === 'souqna_promotions_channel', 'FLASH_SALE resolves to souqna_promotions_channel');
  assert(providerAny.getAndroidChannelId('REWARDS') === 'souqna_rewards_channel', 'REWARDS resolves to souqna_rewards_channel');
  assert(providerAny.getAndroidChannelId('SECURITY') === 'souqna_security_channel', 'SECURITY resolves to souqna_security_channel');
  assert(providerAny.getAndroidChannelId('UNKNOWN_CAT') === 'souqna_system_channel', 'UNKNOWN resolves to souqna_system_channel');

  // 2. Empty tokens no-op test
  console.log('\n2. Safe No-op on Empty Tokens:');
  const emptyRes = await fcmPushProvider.send({
    recipientId: 'user_test_1',
    deviceTokens: [],
    content: {
      titleAr: 'اختبار',
      titleEn: 'Test',
      bodyAr: 'نص تجريبي',
      bodyEn: 'Test body',
      deepLink: 'souqnaa://orders/123',
    },
    category: 'ORDER',
    priority: NotificationPriority.HIGH,
  });
  assert(emptyRes.success === true, 'Empty tokens gracefully succeeds without error');
  assert(emptyRes.messageId === 'no_tokens_noop', 'Returns no_tokens_noop status');

  // 3. Local pseudo-tokens filtering
  console.log('\n3. Local Pseudo-Tokens Filtering:');
  const localRes = await fcmPushProvider.send({
    recipientId: 'user_test_local',
    deviceTokens: ['local_device_android_user_123', 'local_device_web_user_123'],
    content: {
      titleAr: 'اختبار محلي',
      titleEn: 'Local Test',
      bodyAr: 'نص تجريبي',
      bodyEn: 'Test body',
    },
    category: 'SYSTEM',
    priority: NotificationPriority.NORMAL,
  });
  assert(localRes.success === true, 'Local pseudo-tokens handled safely without external transmission');
  assert(localRes.messageId === 'local_tokens_noop', 'Returns local_tokens_noop status');

  // 4. Token Sanitization & Privacy
  console.log('\n4. Device Token Sanitization & Privacy:');
  const rawToken = 'fcm_token_sample_abc123456789_xyz987654321';
  const sanitized = fcmPushProvider.sanitizeToken(rawToken);
  assert(!sanitized.includes('sample_abc'), 'Full token content is never exposed');
  assert(sanitized.startsWith('fcm_to') && sanitized.endsWith('4321'), 'Sanitized token retains identifiable boundary prefix/suffix');
  assert(fcmPushProvider.sanitizeToken('') === '***', 'Short/empty token safely returns placeholder');

  // 5. FCM HTTP v1 Payload Compliance
  console.log('\n5. FCM HTTP v1 Payload Structure Compliance:');
  const testParams = {
    recipientId: 'user_test_2',
    deviceTokens: ['fcm_sample_token_valid_456'],
    notificationId: 'notif_abc_999',
    category: 'REFUND',
    priority: NotificationPriority.HIGH,
    entityType: 'REFUND',
    entityId: 'REF-789',
    content: {
      titleAr: 'تمت الموافقة على طلب الاسترجاع',
      titleEn: 'Refund Request Approved',
      bodyAr: 'تم إيداع المبلغ في محفظتك الإلكترونية',
      bodyEn: 'Amount has been credited to your wallet',
      deepLink: 'souqnaa://refunds/REF-789',
      imageUrl: 'https://cdn.souqnaa.com/refund.png',
    },
    data: {
      numericAmount: 15000,
      extraFlag: true,
    },
  };

  const builtMsg = fcmPushProvider.buildFcmMessage('fcm_test_token_123', testParams);
  assert(builtMsg.message.token === 'fcm_test_token_123', 'FCM message target token assigned');
  assert(builtMsg.message.notification.title === testParams.content.titleAr, 'Notification Arabic title matches');
  assert(builtMsg.message.notification.image === testParams.content.imageUrl, 'Notification image matches v1 specification');
  assert(builtMsg.message.android.priority === 'HIGH', 'Urgent/High priority mapped to Android HIGH');
  assert(builtMsg.message.android.notification.channel_id === 'souqna_refunds_channel', 'Android channel_id is snake_case and mapped');
  assert(builtMsg.message.apns.headers['apns-priority'] === '10', 'APNs priority is set to 10 for high priority');
  assert(typeof builtMsg.message.data.numericAmount === 'string', 'All data entries are stringified for FCM HTTP v1 compliance');
  assert(typeof builtMsg.message.data.extraFlag === 'string', 'Boolean data entries are stringified for FCM HTTP v1 compliance');

  // 6. Missing Credentials Safety (No Mock / Fake Success)
  console.log('\n6. Missing Credentials Safety (No Fake Success):');
  // When credentials are not configured in environment, verify provider returns clean failure instead of fake success
  const savedCreds = process.env.FIREBASE_SERVICE_ACCOUNT;
  const savedProj = process.env.FIREBASE_PROJECT_ID;
  const savedKey = process.env.FCM_SERVER_KEY;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FCM_SERVER_KEY;

  const noCredsRes = await fcmPushProvider.send(testParams);
  assert(noCredsRes.success === false, 'Returns false when push credentials are not configured (no mock delivery)');
  assert(
    !!noCredsRes.error && noCredsRes.error.includes('credentials not configured'),
    'Reports explicit missing credentials error message'
  );

  // Restore env
  if (savedCreds) process.env.FIREBASE_SERVICE_ACCOUNT = savedCreds;
  if (savedProj) process.env.FIREBASE_PROJECT_ID = savedProj;
  if (savedKey) process.env.FCM_SERVER_KEY = savedKey;

  // 7. Delivery Service Truthful Reporting (No False Success on Pseudo-Tokens)
  console.log('\n7. Delivery Service Truthful Outcome Reporting:');
  const { notificationDeliveryService } = await import(
    '../src/modules/notifications/services/notification-delivery.service'
  );

  const deliveryResult = await notificationDeliveryService.deliverChannels({
    recipientId: 'test-user-without-devices-' + Date.now(),
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    content: {
      titleAr: 'اختبار الحقيقة',
      titleEn: 'Truth Test',
      bodyAr: 'فحص عدم التقرير الكاذب للنجاح',
      bodyEn: 'Checking honest delivery reporting',
    },
    category: 'ORDER',
    priority: 'HIGH',
  });

  const inAppOutcome = deliveryResult.find((r) => r.channel === NotificationChannel.IN_APP);
  const pushOutcome = deliveryResult.find((r) => r.channel === NotificationChannel.PUSH);

  assert(inAppOutcome?.success === true, 'IN_APP channel succeeds via canonical database persistence');
  assert(pushOutcome?.success === false, 'PUSH channel truthfully fails when recipient has no real push device');
  assert(
    !!pushOutcome?.error && pushOutcome.error.includes('no registered device tokens'),
    'PUSH error explicitly reports lack of device tokens'
  );

  console.log('\n==================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPushTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});

