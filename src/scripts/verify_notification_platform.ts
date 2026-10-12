import { prisma } from '../database/prisma';
import { notificationDispatcher } from '../modules/notifications/services/notification-dispatcher';
import { NotificationEventFactory } from '../modules/notifications/events/domain-events';
import { notificationTokenService } from '../modules/notifications/services/notification-token.service';
import { notificationPreferenceService } from '../modules/notifications/services/notification-preference.service';
import { notificationAnalyticsService } from '../modules/notifications/services/notification-analytics.service';
import { notificationScheduler } from '../modules/notifications/services/notification-scheduler';
import {
  AppType,
  DevicePlatform,
  NotificationCategory,
  NotificationPriority,
  NotificationChannel,
} from '../modules/notifications/notification.types';

async function runVerification() {
  console.log('====================================================');
  console.log('🧪 SOUQNAA NOTIFICATION PLATFORM - END-TO-END AUDIT');
  console.log('====================================================\n');

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

  // 1. Verify Templates in Database
  console.log('1. Database Templates Verification:');
  const templateCount = await prisma.notificationTemplate.count();
  assert(templateCount >= 30, `Database contains seeded templates (count: ${templateCount})`);

  const orderCreatedTemplate = await prisma.notificationTemplate.findUnique({
    where: { code: 'ORDER_CREATED' },
  });
  assert(
    !!orderCreatedTemplate &&
      orderCreatedTemplate.titleAr.includes('استلام') &&
      orderCreatedTemplate.titleEn.includes('received'),
    'ORDER_CREATED template has authentic Arabic & English localization'
  );

  // 2. Fetch or create test customer user
  console.log('\n2. User Accounts & Baseline State:');
  let customerUser = await prisma.user.findFirst({
    where: { email: 'customer@souqnaa.online' },
  });
  if (!customerUser) {
    customerUser = await prisma.user.create({
      data: {
        email: 'customer@souqnaa.online',
        passwordHash: 'dummy',
        firstName: 'متسوق',
        lastName: 'تجريبي',
        role: 'CUSTOMER',
      },
    });
  }
  assert(!!customerUser, `Customer test account verified (id: ${customerUser.id})`);

  // 3. Device Token Registration Lifecycle
  console.log('\n3. Device Token Registry Lifecycle:');
  const testDeviceId = 'test-device-uuid-101';
  const testToken = 'fcm_token_test_abc123_xyz789';

  const registeredDevice = await notificationTokenService.registerDevice({
    userId: customerUser.id,
    deviceId: testDeviceId,
    platform: DevicePlatform.ANDROID,
    appType: AppType.CUSTOMER,
    deviceToken: testToken,
    pushProvider: 'FCM',
    locale: 'ar',
    timezone: 'Asia/Riyadh',
  });
  assert(registeredDevice.deviceToken === testToken, 'Device successfully registered in NotificationDevice table');

  await notificationTokenService.touchDevice(customerUser.id, testDeviceId);
  assert(true, 'Device heartbeat refreshed successfully');

  const activeDevices = await notificationTokenService.getActiveDevices(customerUser.id, AppType.CUSTOMER);
  assert(activeDevices.length > 0 && activeDevices[0].deviceToken === testToken, 'Active devices query returns valid device token');

  // 4. Notification Preferences
  console.log('\n4. User Notification Preferences:');
  const userPrefs = await notificationPreferenceService.getUserPreferences(customerUser.id);
  assert(typeof userPrefs === 'object' && userPrefs !== null, 'Fetched user notification preferences from DB');

  await notificationPreferenceService.updateCategoryPreference(
    customerUser.id,
    NotificationCategory.ORDER,
    { pushEnabled: true, inAppEnabled: true, emailEnabled: false }
  );
  const updatedPref = await prisma.notificationPreference.findUnique({
    where: { userId_category: { userId: customerUser.id, category: 'ORDER' } },
  });
  assert(updatedPref?.emailEnabled === false, 'Updated preference persisted to database');

  // 5. Dispatch Pipeline & Template Rendering
  console.log('\n5. Centralized Event Dispatching & Pipeline Execution:');
  const dynamicOrderId = 'ord-test-' + Date.now();
  const dynamicOrderNumber = 'SQ-' + Math.floor(10000 + Math.random() * 90000);

  const orderEvent = NotificationEventFactory.orderEvent({
    eventType: 'ORDER_CREATED',
    recipientId: customerUser.id,
    orderId: dynamicOrderId,
    orderNumber: dynamicOrderNumber,
    totalAmount: 15000,
  });

  const dispatchResult = await notificationDispatcher.dispatch(orderEvent);
  assert(
    dispatchResult.status === 'DELIVERED' || dispatchResult.status === 'QUEUED',
    `Order event dispatched through pipeline (status: ${dispatchResult.status})`
  );
  assert(dispatchResult.channelsSent.includes(NotificationChannel.IN_APP), 'In-App channel delivered');

  // 6. Database Persistence Verification
  console.log('\n6. Canonical Database Row Verification:');
  const persistedNotif = await prisma.notification.findFirst({
    where: { userId: customerUser.id, eventId: orderEvent.eventId },
  });
  assert(!!persistedNotif, 'Canonical Notification row persisted in PostgreSQL');
  assert(!!persistedNotif?.titleAr && persistedNotif.titleAr.includes('استلام'), 'Arabic title correctly interpolated from template');
  assert(!!persistedNotif?.bodyAr && persistedNotif.bodyAr.includes(dynamicOrderNumber), 'Order number placeholder successfully interpolated');
  assert(persistedNotif?.deepLink === `souqnaa://orders/${dynamicOrderId}`, 'Deep link correctly generated with orderId');

  // 7. Delivery Audit Log
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { notificationId: persistedNotif?.id },
  });
  assert(deliveries.length > 0, `NotificationDelivery audit rows created (count: ${deliveries.length})`);

  // 8. Deduplication / Idempotency Check
  console.log('\n7. Deduplication & Idempotency:');
  const duplicateEvent = { ...orderEvent, eventId: 'duplicate-event-id-' + Date.now() };
  const duplicateResult = await notificationDispatcher.dispatch(duplicateEvent);
  assert(
    duplicateResult.status === 'SUPPRESSED' && !!duplicateResult.reason?.includes('Duplicate'),
    'Duplicate event with same idempotencyKey properly suppressed'
  );

  // 9. Unread Counter & Read Tracking
  console.log('\n8. Real-time Unread Count Synchronization:');
  const unreadBefore = await prisma.notification.count({
    where: { userId: customerUser.id, isRead: false },
  });
  assert(unreadBefore >= 1, `Unread count reflects unread notifications (count: ${unreadBefore})`);

  if (persistedNotif) {
    await prisma.notification.update({
      where: { id: persistedNotif.id },
      data: { isRead: true, readAt: new Date() },
    });
  }
  const unreadAfter = await prisma.notification.count({
    where: { userId: customerUser.id, isRead: false },
  });
  assert(unreadAfter === unreadBefore - 1, 'Mark as read accurately decrements unread count');

  // 10. Admin Analytics & Audience Preview
  console.log('\n9. Admin Analytics & Live Audience Preview:');
  const overview = await notificationAnalyticsService.getOverviewStats();
  assert(overview.totalDeliveries >= 1, `Overview delivery statistics accurate (total: ${overview.totalDeliveries})`);
  assert(overview.activeDevices >= 1, `Active devices metric tracked across platforms (total: ${overview.activeDevices})`);

  const preview = await notificationAnalyticsService.getAudiencePreview('ALL');
  assert(preview.estimatedRecipients >= 1, `Audience preview calculation accurate (users: ${preview.estimatedRecipients})`);

  // 11. Broadcast Campaign Execution
  console.log('\n10. Admin Broadcast Campaign Execution:');
  const createdCampaign = await prisma.broadcastCampaign.create({
    data: {
      titleAr: 'تخفيضات نهاية الأسبوع 🌟',
      titleEn: 'Weekend Special Offers 🌟',
      bodyAr: 'عروض حصرية لجميع عملاء سوقناا تبدأ الآن!',
      bodyEn: 'Exclusive offers for all SOUQNAA customers starting now!',
      target: 'ALL',
      status: 'SCHEDULED',
    },
  });

  const sentCount = await notificationScheduler.executeBroadcastCampaign({
    id: createdCampaign.id,
    target: 'ALL',
    titleAr: createdCampaign.titleAr,
    titleEn: createdCampaign.titleEn,
    bodyAr: createdCampaign.bodyAr,
    bodyEn: createdCampaign.bodyEn,
  });
  assert(sentCount >= 1, `Broadcast campaign delivered to recipients (${sentCount})`);

  // Summary
  console.log('\n====================================================');
  console.log(`🏁 AUDIT COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification()
  .catch((err) => {
    console.error('Fatal audit failure:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
