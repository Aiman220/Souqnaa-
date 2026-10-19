import {
  NotificationPriority,
  normalizePriority,
  AdminNotificationPreferences,
} from '../src/modules/notifications/notification.types';
import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import {
  NotificationPreferenceService,
  notificationPreferenceService,
} from '../src/modules/notifications/services/notification-preference.service';
import {
  AdminNotificationRouterService,
  adminNotificationRouter,
} from '../src/modules/notifications/services/admin-notification-router.service';
import { fcmPushProvider } from '../src/modules/notifications/providers/push.provider';
import { notificationDigestService } from '../src/modules/notifications/services/notification-digest.service';

async function runFatigueTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING SOUQNA ADMIN NOTIFICATION FATIGUE & PRIORITY ROUTING TESTS');
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

  // ── 1. Priority Normalization & Classification ───────────────────────────
  console.log('1. Priority Normalization & Tier Classification:');
  assert(
    normalizePriority('P0') === 'P0',
    'Maps "P0" to P0',
  );
  assert(
    normalizePriority('P1') === 'P1',
    'Maps "P1" to P1',
  );
  assert(
    normalizePriority('P2') === 'P2',
    'Maps "P2" to P2',
  );
  assert(
    normalizePriority('P3') === 'P3',
    'Maps "P3" to P3',
  );
  assert(
    normalizePriority('CRITICAL') === 'P0',
    'Backward compatibility: Maps "CRITICAL" to P0',
  );
  assert(
    normalizePriority('URGENT') === 'P0',
    'Backward compatibility: Maps "URGENT" to P0',
  );
  assert(
    normalizePriority('HIGH') === 'P1',
    'Backward compatibility: Maps "HIGH" to P1',
  );
  assert(
    normalizePriority('NORMAL') === 'P2',
    'Backward compatibility: Maps "NORMAL" to P2',
  );
  assert(
    normalizePriority('LOW') === 'P3',
    'Backward compatibility: Maps "LOW" to P3',
  );
  assert(
    normalizePriority(undefined) === 'P2',
    'Defaults undefined to P2',
  );

  // ── 2. Stable Deterministic Idempotency Keys ─────────────────────────────
  console.log('\n2. Stable Deterministic Idempotency Keys (Anti-Duplicate Delivery):');
  const event1 = NotificationEventFactory.adminAlertEvent({
    eventType: 'SECURITY_BREACH',
    recipientId: 'admin_test_1',
    titleAr: 'تنبيه أمني',
    titleEn: 'Security Alert',
    messageAr: 'محاولة تسجيل دخول مشبوهة',
    messageEn: 'Suspicious login',
    priority: NotificationPriority.P0_CRITICAL,
    incidentId: 'inc_sec_999',
  });

  const event2 = NotificationEventFactory.adminAlertEvent({
    eventType: 'SECURITY_BREACH',
    recipientId: 'admin_test_1',
    titleAr: 'تنبيه أمني مكرر',
    titleEn: 'Duplicate Alert',
    messageAr: 'نفس المحاولة',
    messageEn: 'Same attempt',
    priority: NotificationPriority.P0_CRITICAL,
    incidentId: 'inc_sec_999',
  });

  assert(
    event1.idempotencyKey === 'incident_inc_sec_999_SECURITY_BREACH',
    'Generates deterministic incident-based idempotency key without timestamp',
  );
  assert(
    event1.idempotencyKey === event2.idempotencyKey,
    'Consecutive alerts for same incident have identical idempotency key',
  );
  assert(
    !event1.idempotencyKey?.includes('Date.now'),
    'Idempotency key contains no Date.now',
  );

  const recovery = NotificationEventFactory.adminRecoveryEvent({
    recipientId: 'admin_test_1',
    incidentId: 'inc_sec_999',
    incidentType: 'SECURITY_BREACH',
    titleAr: 'تم حل البلاغ الأمني',
    titleEn: 'Incident Resolved',
    messageAr: 'تم إغلاق البلاغ بنجاح',
    messageEn: 'Incident closed',
  });
  assert(
    recovery.idempotencyKey === 'incident_inc_sec_999_resolved',
    'Recovery event generates deterministic recovery key',
  );
  assert(
    recovery.isResolved === true,
    'Recovery event marks isResolved=true',
  );

  // ── 3. FCM Payload Priority & Sound Policy ───────────────────────────────
  console.log('\n3. FCM Push Provider Fatigue Prevention (Silent Push for P1, Sound for P0):');
  const providerAny = fcmPushProvider as any;

  // Build P0 FCM message
  const p0Message = providerAny.buildFcmMessage('fake_token_p0', {
    recipientId: 'admin_test_1',
    deviceTokens: ['fake_token_p0'],
    content: { titleAr: 'طوارئ', titleEn: 'Emergency', bodyAr: 'عطل فادح', bodyEn: 'Major outage', deepLink: 'souqnaa://admin/incidents/1' },
    category: 'SECURITY',
    priority: NotificationPriority.P0_CRITICAL,
  });
  assert(
    p0Message.message.android.priority === 'HIGH',
    'P0 Android priority is "HIGH"',
  );
  assert(
    p0Message.message.android.notification.sound === 'default',
    'P0 Android notification has sound: "default"',
  );
  assert(
    p0Message.message.apns.payload.aps.sound === 'default',
    'P0 APNs has sound: "default"',
  );

  // Build P1 FCM message (Silent push by default)
  const p1Message = providerAny.buildFcmMessage('fake_token_p1', {
    recipientId: 'admin_test_1',
    deviceTokens: ['fake_token_p1'],
    content: { titleAr: 'نزاع مالي', titleEn: 'Dispute', bodyAr: 'نزاع مسترجع', bodyEn: 'Refund dispute', deepLink: 'souqnaa://admin/disputes/2' },
    category: 'DISPUTE',
    priority: NotificationPriority.P1_HIGH,
  });
  assert(
    p1Message.message.android.notification.sound === undefined,
    'P1 Android notification sound is silent (undefined) by default',
  );
  assert(
    p1Message.message.apns.payload.aps.sound === undefined,
    'P1 APNs sound is silent (undefined) by default',
  );

  // ── 4. Admin Preferences & Quiet Hours Evaluation ────────────────────────
  console.log('\n4. Admin Preferences, Quiet Hours & Temporary Mute:');
  const adminId = 'admin_tester_fatigue_1';
  const defaultPrefs = await notificationPreferenceService.getAdminPreferences(adminId);
  assert(
    defaultPrefs.p2DigestIntervalMinutes === 30,
    'Default routine digest interval is 30 minutes',
  );
  assert(
    defaultPrefs.p0PushEnabled === true,
    'P0 explicitly enabled by default',
  );
  assert(
    defaultPrefs.p1SoundEnabled === false,
    'P1 sound is disabled by default in admin preferences',
  );

  // Update admin preferences
  const updatedPrefs = await notificationPreferenceService.updateAdminPreferences(adminId, {
    p2DigestIntervalMinutes: 60,
    p1SoundEnabled: true,
  });
  assert(
    updatedPrefs.p2DigestIntervalMinutes === 60,
    'Admin preferences routine digest interval updated to 60',
  );
  assert(
    updatedPrefs.p1SoundEnabled === true,
    'Admin preferences P1 sound enabled by explicit choice',
  );

  // Test Muting
  await notificationPreferenceService.muteAdminNotifications(adminId, 4);
  const mutedPrefs = await notificationPreferenceService.getAdminPreferences(adminId);
  const isMuted = Boolean(mutedPrefs.mutedUntil && new Date(mutedPrefs.mutedUntil) > new Date());
  assert(
    isMuted === true,
    'Admin notifications temporarily muted',
  );
  assert(
    mutedPrefs.mutedUntil !== null,
    'Admin mutedUntil timestamp set',
  );

  // Quiet Hours check helper
  const isQuiet = (notificationPreferenceService as any).isQuietHoursActive({
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    timezone: 'Asia/Riyadh',
  });
  assert(typeof isQuiet === 'boolean', 'Quiet hours calculation executes safely');

  // Unmute
  await notificationPreferenceService.muteAdminNotifications(adminId, 0);
  const unmutedPrefs = await notificationPreferenceService.getAdminPreferences(adminId);
  const isStillMuted = Boolean(unmutedPrefs.mutedUntil && new Date(unmutedPrefs.mutedUntil) > new Date());
  assert(
    isStillMuted === false,
    'Admin notifications unmuted successfully',
  );

  // ── 5. Routine Digest Aggregator Service ─────────────────────────────────
  console.log('\n5. Routine Digest Aggregator (30-Minute Summary Engine):');
  const digestsCount = await notificationDigestService.processRoutineDigests();
  assert(
    typeof digestsCount === 'number',
    'Notification digest processor executes safely without errors',
  );

  // ── 6. RBAC Event Mapping & Authorized Recipient Routing ──────────────────
  console.log('\n6. Authoritative Server-Side RBAC Recipient Routing:');
  const financePermission = adminNotificationRouter.resolveRequiredPermission('WITHDRAWAL_REQUEST');
  assert(
    financePermission === 'finance:view',
    'WITHDRAWAL_REQUEST requires "finance:view" permission',
  );

  const disputePermission = adminNotificationRouter.resolveRequiredPermission('DISPUTE_OPENED');
  assert(
    disputePermission === 'disputes:resolve',
    'DISPUTE_OPENED requires "disputes:resolve" permission',
  );

  const sellerPermission = adminNotificationRouter.resolveRequiredPermission('SELLER_APPROVAL_NEEDED');
  assert(
    sellerPermission === 'sellers:approve',
    'SELLER_APPROVAL_NEEDED requires "sellers:approve" permission',
  );

  const secPermission = adminNotificationRouter.resolveRequiredPermission('CRITICAL_SECURITY_ALERT');
  assert(
    secPermission === 'settings:manage',
    'CRITICAL_SECURITY_ALERT requires "settings:manage" permission',
  );

  console.log('\n========================================================================');
  console.log(`📊 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFatigueTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
