import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import { notificationTemplateService } from '../src/modules/notifications/services/notification-template.service';
import { fcmPushProvider } from '../src/modules/notifications/providers/push.provider';
import { notificationDispatcher } from '../src/modules/notifications/services/notification-dispatcher';
import {
  NotificationCategory,
  NotificationPriority,
  AppType,
} from '../src/modules/notifications/notification.types';

async function runStoreVerificationNotificationTests() {
  console.log('===============================================================');
  console.log('🧪 RUNNING STORE VERIFICATION PUSH NOTIFICATION BACKEND TESTS');
  console.log('===============================================================\n');

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

  // 1. Factory Event Generation Tests
  console.log('1. Store Verification Event Factory Generation:');
  const approvedEvent = NotificationEventFactory.storeVerificationEvent({
    eventType: 'STORE_VERIFICATION_APPROVED',
    recipientId: 'user_seller_123',
    sellerId: 'seller_456',
    storeId: 'store_789',
    storeName: 'متجر التميز اليمني',
    sellerName: 'أحمد التاجر',
    notes: 'تمت مطابقة الهوية والسجل التجاري بنجاح',
    deepLink: 'souqnaa://seller/verification',
  });

  assert(approvedEvent.eventType === 'STORE_VERIFICATION_APPROVED', 'Approved event has correct eventType');
  assert(approvedEvent.category === NotificationCategory.SELLER, 'Category is NotificationCategory.SELLER');
  assert(approvedEvent.recipientId === 'user_seller_123', 'Recipient is seller User ID');
  assert(approvedEvent.recipientType === AppType.SELLER, 'Recipient type is AppType.SELLER');
  assert(approvedEvent.entityType === 'store_verification', 'Entity type is store_verification');
  assert(approvedEvent.entityId === 'store_789', 'Entity ID is store_789');
  assert(approvedEvent.priority === NotificationPriority.HIGH, 'Approved event has HIGH priority');
  assert(approvedEvent.bypassQuietHours === true, 'Verification approved bypasses quiet hours');
  assert(approvedEvent.bypassRateLimit === true, 'Verification approved bypasses rate limiting');
  assert(approvedEvent.data?.storeName === 'متجر التميز اليمني', 'Store name populated in event data');
  assert(approvedEvent.data?.notes === 'تمت مطابقة الهوية والسجل التجاري بنجاح', 'Verification notes populated in event data');
  assert(approvedEvent.data?.deepLink === 'souqnaa://seller/verification', 'Deep link points to souqnaa://seller/verification');

  // 2. Rejection Event Generation
  console.log('\n2. Store Verification Rejection Event Generation:');
  const rejectedEvent = NotificationEventFactory.storeVerificationEvent({
    eventType: 'STORE_VERIFICATION_REJECTED',
    recipientId: 'user_seller_123',
    sellerId: 'seller_456',
    storeId: 'store_789',
    storeName: 'متجر الأمل',
    reason: 'صورة الهوية الوطنية غير واضحة ومنتهية الصلاحية',
  });

  assert(rejectedEvent.eventType === 'STORE_VERIFICATION_REJECTED', 'Rejected event has correct eventType');
  assert(rejectedEvent.priority === NotificationPriority.URGENT, 'Rejection event has URGENT priority');
  assert(rejectedEvent.data?.reason === 'صورة الهوية الوطنية غير واضحة ومنتهية الصلاحية', 'Rejection reason populated in event data');
  assert(rejectedEvent.data?.deepLink === 'souqnaa://seller/verification', 'Default deep link routes to seller verification screen');

  // 3. Other Store Verification Lifecycle Events (Suspended, Activated, Badges)
  console.log('\n3. Store Verification & Status Lifecycle Events:');
  const suspendedEvent = NotificationEventFactory.storeVerificationEvent({
    eventType: 'STORE_SUSPENDED',
    recipientId: 'user_seller_123',
    sellerId: 'seller_456',
    storeName: 'متجر الأمل',
    reason: 'مخالفة سياسة بيع المنتجات',
  });
  assert(suspendedEvent.priority === NotificationPriority.URGENT, 'Suspension event is URGENT');
  assert(suspendedEvent.data?.deepLink === 'souqnaa://seller/settings', 'Suspension routes to seller settings');

  const badgeEvent = NotificationEventFactory.storeVerificationEvent({
    eventType: 'STORE_BADGE_GRANTED',
    recipientId: 'user_seller_123',
    sellerId: 'seller_456',
    storeName: 'متجر النجوم',
  });
  assert(badgeEvent.data?.deepLink === 'souqnaa://seller/store', 'Badge event routes to seller store');

  // 4. Template Rendering Tests
  console.log('\n4. Notification Template Rendering:');
  const renderedApproved = await notificationTemplateService.render(approvedEvent);
  assert(renderedApproved.titleAr.includes('تم توثيق متجرك بنجاح'), 'Approved Arabic title renders correctly');
  assert(renderedApproved.titleEn.includes('Store Verification Approved'), 'Approved English title renders correctly');
  assert(renderedApproved.bodyAr.includes('متجر التميز اليمني'), 'Approved body interpolates storeName');
  assert(renderedApproved.deepLink === 'souqnaa://seller/verification', 'Approved deepLink matches');

  const renderedRejected = await notificationTemplateService.render(rejectedEvent);
  assert(renderedRejected.titleAr.includes('تعذر اعتماد توثيق المتجر'), 'Rejected Arabic title renders correctly');
  assert(renderedRejected.titleEn.includes('Store Verification Rejected'), 'Rejected English title renders correctly');
  assert(renderedRejected.bodyAr.includes('صورة الهوية الوطنية غير واضحة ومنتهية الصلاحية'), 'Rejected body interpolates rejection reason');
  assert(renderedRejected.bodyAr.includes('متجر الأمل'), 'Rejected body interpolates storeName');

  const renderedSuspended = await notificationTemplateService.render(suspendedEvent);
  assert(renderedSuspended.titleAr.includes('تم إيقاف حساب المتجر مؤقتاً'), 'Suspended Arabic title renders correctly');
  assert(renderedSuspended.bodyAr.includes('مخالفة سياسة بيع المنتجات'), 'Suspended body interpolates suspension reason');

  const renderedBadge = await notificationTemplateService.render(badgeEvent);
  assert(renderedBadge.titleAr.includes('شارة التوثيق والتميز'), 'Badge Arabic title renders correctly');

  // 5. FCM HTTP v1 Push Payload Compliance for Store Verification
  console.log('\n5. FCM Push Payload Compliance:');
  const dummyToken = 'fcm_test_device_token_store_verification_999';
  const fcmPayload = fcmPushProvider.buildFcmMessage(dummyToken, {
    recipientId: approvedEvent.recipientId,
    content: renderedApproved,
    category: approvedEvent.category,
    priority: approvedEvent.priority,
    entityType: approvedEvent.entityType,
    entityId: approvedEvent.entityId,
    data: approvedEvent.data,
  });

  assert(fcmPayload.message.token === dummyToken, 'FCM message targeted to device token');
  assert(fcmPayload.message.notification.title === renderedApproved.titleAr, 'FCM notification title is localized Arabic');
  assert(fcmPayload.message.notification.body === renderedApproved.bodyAr, 'FCM notification body contains full Arabic text');
  assert(fcmPayload.message.data.storeName === 'متجر التميز اليمني', 'Store name present in FCM data dictionary');
  assert(fcmPayload.message.data.deepLink === 'souqnaa://seller/verification', 'Deep link present in FCM data dictionary');
  assert(fcmPayload.message.android.priority === 'HIGH', 'Android message priority is set to HIGH');
  assert(fcmPayload.message.apns.headers['apns-priority'] === '10', 'APNs priority is set to 10 for timely delivery');

  // 6. Safe Dispatch Pipeline
  console.log('\n6. Safe Dispatch Pipeline Execution:');
  const dispatchRes = await notificationDispatcher.dispatch(approvedEvent);
  assert(dispatchRes !== null && dispatchRes !== undefined, 'Dispatcher processes store verification event');
  assert(dispatchRes.status === 'DELIVERED' || dispatchRes.status === 'SUPPRESSED', 'Dispatcher returns valid delivery status');

  console.log('\n===============================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStoreVerificationNotificationTests()
  .then(() => {
    console.log('✅ Store verification notification test suite finished.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Store verification notification test suite failed with error:', err);
    process.exit(1);
  });

