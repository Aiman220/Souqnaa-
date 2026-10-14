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

  // 3. Payload Construction & Sending
  console.log('\n3. FCM Payload Compliance & Transmission:');
  const sendRes = await fcmPushProvider.send({
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
    },
  });
  assert(sendRes.success === true, 'FCM send operation completes successfully');
  assert(sendRes.provider === 'FCM', 'Provider is identified as FCM');
  assert(sendRes.channel === NotificationChannel.PUSH, 'Channel is NotificationChannel.PUSH');
  assert(!!sendRes.messageId && sendRes.messageId.startsWith('fcm_'), 'Generates valid FCM message ID');

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
