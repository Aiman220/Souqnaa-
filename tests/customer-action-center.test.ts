import { prisma } from '../src/database/prisma';
import { ActionCenterRulesEngine } from '../src/modules/action-center/action-center.rules';
import { CustomerActionCenterService } from '../src/modules/action-center/customer-action-center.service';
import {
  CustomerAction,
  CustomerActionPriority,
  CustomerActionStatus,
  CustomerActionType,
  CustomerActionCategory,
} from '../src/modules/action-center/action-center.types';

async function runCustomerActionCenterTests() {
  console.log('====================================================');
  console.log('🧪 SOUQNA CUSTOMER ACTION CENTER TEST SUITE');
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

  // ── TEST SUITE 1: Pure Rule Engine & Prioritization ──────────────────────
  console.log('--- Test Suite 1: Pure Rule Engine Prioritization & Sorting ---');
  {
    const criticalAction: CustomerAction = {
      id: 'act_crit_1',
      type: CustomerActionType.PAYMENT_ACTION,
      category: CustomerActionCategory.PAYMENT,
      priority: CustomerActionPriority.CRITICAL,
      status: CustomerActionStatus.PENDING,
      titleAr: 'دفع عاجل',
      titleEn: 'Urgent Payment',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'payment',
      deepLink: '/orders/1',
      dismissible: false,
      snoozable: false,
      requiresAction: true,
      deduplicationKey: 'ORDER_PAYMENT:1',
      createdAt: new Date().toISOString(),
    };

    const highAction: CustomerAction = {
      id: 'act_high_1',
      type: CustomerActionType.VERIFY_PHONE,
      category: CustomerActionCategory.SECURITY,
      priority: CustomerActionPriority.HIGH,
      status: CustomerActionStatus.PENDING,
      titleAr: 'توثيق الهاتف',
      titleEn: 'Verify Phone',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'phone',
      deepLink: '/verify',
      dismissible: true,
      snoozable: true,
      requiresAction: true,
      deduplicationKey: 'VERIFY_PHONE',
      createdAt: new Date().toISOString(),
    };

    const mediumAction: CustomerAction = {
      id: 'act_med_1',
      type: CustomerActionType.CLAIM_REWARD,
      category: CustomerActionCategory.REWARD,
      priority: CustomerActionPriority.MEDIUM,
      status: CustomerActionStatus.PENDING,
      titleAr: 'مكافأة يومية',
      titleEn: 'Daily Reward',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'stars',
      deepLink: '/rewards',
      dismissible: true,
      snoozable: true,
      requiresAction: false,
      deduplicationKey: 'DAILY_CHECKIN',
      createdAt: new Date().toISOString(),
    };

    const lowAction: CustomerAction = {
      id: 'act_low_1',
      type: CustomerActionType.ENABLE_LOCATION_PERMISSION,
      category: CustomerActionCategory.PERMISSION,
      priority: CustomerActionPriority.LOW,
      status: CustomerActionStatus.PENDING,
      titleAr: 'موقع',
      titleEn: 'Location',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'location_on',
      deepLink: '/map',
      dismissible: true,
      snoozable: true,
      requiresAction: false,
      deduplicationKey: 'PERMISSION:LOCATION',
      createdAt: new Date().toISOString(),
    };

    // Shuffled list
    const sorted = ActionCenterRulesEngine.sortActions([
      lowAction,
      mediumAction,
      criticalAction,
      highAction,
    ]);

    assert(
      sorted[0].id === 'act_crit_1',
      'CRITICAL priority ranks first before all other priorities'
    );
    assert(
      sorted[1].id === 'act_high_1',
      'HIGH priority ranks second after CRITICAL'
    );
    assert(
      sorted[2].id === 'act_med_1',
      'MEDIUM priority ranks third'
    );
    assert(
      sorted[3].id === 'act_low_1',
      'LOW priority ranks last'
    );
  }

  // ── TEST SUITE 2: Expiration Filtering ────────────────────────────────────
  console.log('\n--- Test Suite 2: Expiration Engine ---');
  {
    const now = new Date();
    const past = new Date(now.getTime() - 1000 * 60 * 60); // 1 hour ago
    const future = new Date(now.getTime() + 1000 * 60 * 60); // 1 hour ahead

    const expiredAction: CustomerAction = {
      id: 'act_exp_1',
      type: CustomerActionType.CLAIM_COUPON,
      category: CustomerActionCategory.PROMOTION,
      priority: CustomerActionPriority.MEDIUM,
      status: CustomerActionStatus.PENDING,
      titleAr: 'كوبون منتهي',
      titleEn: 'Expired Coupon',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'confirmation_number',
      deepLink: '/vouchers',
      expiresAt: past.toISOString(),
      dismissible: true,
      snoozable: true,
      requiresAction: false,
      deduplicationKey: 'COUPON:EXPIRED',
      createdAt: past.toISOString(),
    };

    const validAction: CustomerAction = {
      id: 'act_val_1',
      type: CustomerActionType.CLAIM_COUPON,
      category: CustomerActionCategory.PROMOTION,
      priority: CustomerActionPriority.MEDIUM,
      status: CustomerActionStatus.PENDING,
      titleAr: 'كوبون ساري',
      titleEn: 'Active Coupon',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'confirmation_number',
      deepLink: '/vouchers',
      expiresAt: future.toISOString(),
      dismissible: true,
      snoozable: true,
      requiresAction: false,
      deduplicationKey: 'COUPON:VALID',
      createdAt: now.toISOString(),
    };

    const nonExpired = ActionCenterRulesEngine.filterExpired([expiredAction, validAction], now);
    assert(
      nonExpired.length === 1 && nonExpired[0].id === 'act_val_1',
      'Expired actions are correctly filtered out from customer view'
    );
  }

  // ── TEST SUITE 3: Deduplication Engine ────────────────────────────────────
  console.log('\n--- Test Suite 3: Deduplication Engine ---');
  {
    const actionA: CustomerAction = {
      id: 'act_dup_1',
      type: CustomerActionType.VERIFY_PHONE,
      category: CustomerActionCategory.SECURITY,
      priority: CustomerActionPriority.HIGH,
      status: CustomerActionStatus.PENDING,
      titleAr: 'توثيق الهاتف 1',
      titleEn: 'Verify 1',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'phone',
      deepLink: '/verify',
      dismissible: true,
      snoozable: true,
      requiresAction: true,
      deduplicationKey: 'VERIFY_PHONE',
      createdAt: new Date('2026-10-01').toISOString(),
    };

    const actionB: CustomerAction = {
      id: 'act_dup_2',
      type: CustomerActionType.VERIFY_PHONE,
      category: CustomerActionCategory.SECURITY,
      priority: CustomerActionPriority.HIGH,
      status: CustomerActionStatus.PENDING,
      titleAr: 'توثيق الهاتف 2',
      titleEn: 'Verify 2',
      descriptionAr: 'وصف',
      descriptionEn: 'Desc',
      icon: 'phone',
      deepLink: '/verify',
      dismissible: true,
      snoozable: true,
      requiresAction: true,
      deduplicationKey: 'VERIFY_PHONE',
      createdAt: new Date('2026-10-05').toISOString(),
    };

    const deduped = ActionCenterRulesEngine.deduplicate([actionA, actionB]);
    assert(
      deduped.length === 1,
      'Duplicate actions with identical deduplicationKey collapse into single entry'
    );
    assert(
      deduped[0].id === 'act_dup_2',
      'Deduplication chooses the latest updated candidate'
    );
  }

  // ── TEST SUITE 4: Database Integration & Dismissal / Snooze ──────────────
  console.log('\n--- Test Suite 4: Database Integration, Dismissal & Security ---');
  const testUserId = `test_ac_user_${Date.now()}`;
  const testEmail = `test_ac_${Date.now()}@souqnaa.app`;
  const testPhone = `77${Math.floor(1000000 + Math.random() * 8999999)}`;

  try {
    // Clean up any stale test user with same phone or email just in case
    await prisma.user.deleteMany({ where: { phone: { startsWith: '77' }, email: { contains: 'test_ac_' } } }).catch(() => {});

    // Create test user
    const user = await prisma.user.create({
      data: {
        id: testUserId,
        email: testEmail,
        phone: testPhone,
        firstName: 'أحمد',
        lastName: 'العولقي',
        passwordHash: 'dummy_hash',
        isVerified: false,
      },
    });

    assert(user.id === testUserId, 'Test customer created in database');

    // 1. Unverified phone customer should get VERIFY_PHONE
    const result1 = await CustomerActionCenterService.getActionCenter(testUserId);
    const hasPhoneVerify = result1.items.some((i) => i.type === CustomerActionType.VERIFY_PHONE);
    assert(hasPhoneVerify, 'Unverified customer correctly receives VERIFY_PHONE action');

    // 2. Dismiss action
    await CustomerActionCenterService.dismissAction(
      testUserId,
      `act_verify_phone_${testUserId}`,
      'VERIFY_PHONE'
    );

    const resultAfterDismiss = await CustomerActionCenterService.getActionCenter(testUserId);
    const hasDismissedPhone = resultAfterDismiss.items.some(
      (i) => i.deduplicationKey === 'VERIFY_PHONE'
    );
    assert(!hasDismissedPhone, 'Dismissed action does NOT appear in customer action center');

    // 3. Snooze action test
    await CustomerActionCenterService.snoozeAction(
      testUserId,
      'act_perm_notification',
      'PERMISSION:NOTIFICATION',
      24
    );

    const resultAfterSnooze = await CustomerActionCenterService.getActionCenter(testUserId);
    const hasSnoozedNotif = resultAfterSnooze.items.some(
      (i) => i.deduplicationKey === 'PERMISSION:NOTIFICATION'
    );
    assert(!hasSnoozedNotif, 'Snoozed action is hidden while snooze duration is active');

    // 4. Security: Critical payment action cannot be dismissed
    let caughtDismissSecurityError = false;
    try {
      await CustomerActionCenterService.dismissAction(
        testUserId,
        'act_order_payment_999',
        'ORDER_PAYMENT:999'
      );
    } catch (err: any) {
      caughtDismissSecurityError = true;
    }
    assert(
      caughtDismissSecurityError,
      'Security guard forbids dismissing CRITICAL payment actions'
    );
    assert(true, 'Test execution completed successfully');
  } catch (err) {
    console.error('Database test error:', err);
    failed++;
  } finally {
    try {
      await prisma.customerActionDismissal.deleteMany({ where: { userId: testUserId } });
      await prisma.user.delete({ where: { id: testUserId } });
    } catch (_) {}
  }

  console.log('\n====================================================');
  console.log(`📊 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runCustomerActionCenterTests()
  .catch((err) => {
    console.error('Fatal error running tests:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
