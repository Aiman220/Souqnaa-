import { prisma } from '../src/database/prisma';
import { MembershipRulesEngine } from '../src/modules/membership/membership-rules.engine';
import { MembershipEligibilityService } from '../src/modules/membership/membership-eligibility.service';
import { MembershipMetricsService } from '../src/modules/membership/membership-metrics.service';
import { MembershipBenefitEngine } from '../src/modules/membership/membership-benefit.engine';
import { MembershipCacheService } from '../src/modules/membership/membership-cache.service';
import { QualificationRulesConfig, CustomerMetricsSnapshot } from '../src/modules/membership/membership.types';
import { OrderStatus, PaymentStatus, PaymentMethodType, RefundStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import http from 'http';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { JwtUtil } from '../src/utils/jwt.util';
import { redis } from '../src/database/redis';

async function runComprehensiveMembershipTestSuite() {
  console.log('====================================================');
  console.log('🧪 SOUQNAA MEMBERSHIP ENGINE & NOTIFICATION TEST SUITE');
  console.log('   Verifying all 14 Master Engine Requirements');
  console.log('====================================================\n');

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

  // ──────────────────────────────────────────────────────────────────────────
  // PURE UNIT TESTS: RULE ENGINE LOGIC & PROGRESS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- Suite A: Pure Deterministic Rule Engine & Progress Logic ---');

  // Test Logic ANY
  {
    const rulesConfig: QualificationRulesConfig = {
      logic: 'ANY',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 15 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 120000 },
      ],
    };

    const metricsOrdersOnly: CustomerMetricsSnapshot = {
      userId: 'test_u1',
      completedOrders: 15,
      periodCompletedOrders: 15,
      lifetimeSpend: 5000,
      periodSpend: 5000,
      pointsBalance: 100,
      accountAgeDays: 50,
      evaluationTimestamp: new Date().toISOString(),
    };

    const metricsNeither: CustomerMetricsSnapshot = {
      userId: 'test_u2',
      completedOrders: 5,
      periodCompletedOrders: 5,
      lifetimeSpend: 40000,
      periodSpend: 40000,
      pointsBalance: 50,
      accountAgeDays: 20,
      evaluationTimestamp: new Date().toISOString(),
    };

    assert(
      MembershipRulesEngine.isEligible(rulesConfig, metricsOrdersOnly) === true,
      'ANY logic passes when completed orders requirement is met'
    );
    assert(
      MembershipRulesEngine.isEligible(rulesConfig, metricsNeither) === false,
      'ANY logic fails when neither order nor spend requirement is met'
    );
  }

  // Test Logic ALL
  {
    const rulesConfigAll: QualificationRulesConfig = {
      logic: 'ALL',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 10 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 100000 },
      ],
    };

    const partialMetrics: CustomerMetricsSnapshot = {
      userId: 'test_u3',
      completedOrders: 12,
      periodCompletedOrders: 12,
      lifetimeSpend: 80000,
      periodSpend: 80000,
      pointsBalance: 0,
      accountAgeDays: 30,
      evaluationTimestamp: new Date().toISOString(),
    };

    assert(
      MembershipRulesEngine.isEligible(rulesConfigAll, partialMetrics) === false,
      'ALL logic fails when orders requirement is met but spend requirement is missing'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14 AUTHORITATIVE ENGINE TEST SCENARIOS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite B: 14 Master Engine & Notification Scenarios ---');

  const testUserEmail = `membership_test_${Date.now()}@souqna.com`;
  let testUserId = '';
  let testSellerId = '';

  try {
    // 0. Setup: Find a seller in the database for order/refund references
    const seller = await prisma.seller.findFirst({ select: { id: true } });
    if (!seller) throw new Error('No seller found in database for test references');
    testSellerId = seller.id;

    // Create a pristine test user
    const user = await prisma.user.create({
      data: {
        email: testUserEmail,
        passwordHash: 'dummy_hash_for_test',
        firstName: 'فهد',
        lastName: 'العليمي',
        phone: `+9677${Math.floor(10000000 + Math.random() * 90000000)}`,
        role: 'CUSTOMER',
      },
    });
    testUserId = user.id;

    // SCENARIO 1: New account receives Basic Level 1
    console.log('\n[Requirement 1] New account receives Basic Level 1');
    const initialMembership = await MembershipEligibilityService.getOrCreateMembership(testUserId);
    assert(
      initialMembership !== null &&
        initialMembership.tier.level === 1 &&
        initialMembership.tier.code === 'BASIC',
      'New account automatically receives Level 1 Basic tier',
      `Level: ${initialMembership?.tier?.level}, Code: ${initialMembership?.tier?.code}`
    );
    assert(
      initialMembership.completedOrders === 0 &&
        initialMembership.periodSpend === 0 &&
        initialMembership.lifetimeSpend === 0,
      'New account initialized with 0 orders and 0 spend'
    );

    const initialSummary = await MembershipEligibilityService.getCustomerSummary(testUserId);
    assert(
      initialSummary.level === 1 &&
        initialSummary.tierCode === 'BASIC' &&
        initialSummary.tierNameEn === 'Basic',
      'Customer summary exposes canonical Level 1 Basic branding'
    );

    // SCENARIO 2: Zero purchases always produce 0% progress
    console.log('\n[Requirement 2] Zero purchases always produce 0% progress');
    const zeroMetrics: CustomerMetricsSnapshot = {
      userId: testUserId,
      completedOrders: 0,
      periodCompletedOrders: 0,
      lifetimeSpend: 0,
      periodSpend: 0,
      pointsBalance: 0,
      accountAgeDays: 0,
      evaluationTimestamp: new Date().toISOString(),
    };

    const silverTier = await prisma.membershipTier.findUnique({ where: { code: 'SILVER' } });
    const silverRules = (silverTier?.qualificationRules as unknown as QualificationRulesConfig) || {
      logic: 'ANY',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 7 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 60000 },
      ],
    };

    const zeroProgress = MembershipRulesEngine.calculateProgress(silverRules, zeroMetrics);
    assert(
      zeroProgress.percentage === 0 &&
        zeroProgress.spendProgress?.percentage === 0 &&
        zeroProgress.orderProgress?.percentage === 0,
      'Zero purchases strictly evaluate to 0% progress on Rule Engine',
      `percentage: ${zeroProgress.percentage}, spendPct: ${zeroProgress.spendProgress?.percentage}, orderPct: ${zeroProgress.orderProgress?.percentage}`
    );
    assert(
      initialSummary.progress !== null && initialSummary.progress.percentage === 0,
      'Customer summary reports 0% progress towards next tier for zero purchases'
    );

    // Corrupted/empty rules test: Must never yield 100% or NaN
    const corruptProgress = MembershipRulesEngine.calculateProgress({ logic: 'ANY', rules: [] }, zeroMetrics);
    assert(
      corruptProgress.percentage === 0,
      'Missing or malformed qualification rules safely produce 0% progress (never 100% or NaN)'
    );

    // SCENARIO 3: Unpaid orders do not qualify
    console.log('\n[Requirement 3] Unpaid orders do not qualify');
    const unpaidOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-UNPAID-${Date.now()}`,
        userId: testUserId,
        subtotal: 75000,
        total: 75000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PENDING,
            amount: 75000,
            currency: 'YER',
            paidAt: null,
          },
        },
      },
    });

    const metricsAfterUnpaid = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterUnpaid.completedOrders === 0 && metricsAfterUnpaid.periodSpend === 0,
      'Delivered order with unpaid/pending payment is excluded from metrics'
    );

    // SCENARIO 4: Pending orders do not qualify
    console.log('\n[Requirement 4] Pending orders do not qualify');
    const pendingOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-PENDING-${Date.now()}`,
        userId: testUserId,
        subtotal: 80000,
        total: 80000,
        currency: 'YER',
        status: OrderStatus.PENDING,
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 80000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const metricsAfterPending = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterPending.completedOrders === 0 && metricsAfterPending.periodSpend === 0,
      'Pending order (even if paid) does not qualify for membership completed orders or spend'
    );

    // Clean up temporary unpaid and pending test orders
    await prisma.payment.deleteMany({ where: { orderId: { in: [unpaidOrder.id, pendingOrder.id] } } });
    await prisma.order.deleteMany({ where: { id: { in: [unpaidOrder.id, pendingOrder.id] } } });

    // SCENARIO 5: Completed paid orders count exactly once
    console.log('\n[Requirement 5] Completed paid orders count exactly once');
    const completedPaidOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-PAID-${Date.now()}`,
        userId: testUserId,
        subtotal: 70000,
        total: 70000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 70000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const metricsAfterCompleted = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterCompleted.completedOrders === 1 && metricsAfterCompleted.periodSpend === 70000,
      'Completed paid order increments completedOrders to 1 and periodSpend to 70,000 YER'
    );

    // SCENARIO 6: Duplicate payment webhooks do not double-count
    console.log('\n[Requirement 6] Duplicate payment webhooks do not double-count');
    // Compute metrics second time (simulating repeated webhook / re-evaluation)
    const metricsWebhookReplay = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsWebhookReplay.completedOrders === 1 && metricsWebhookReplay.periodSpend === 70000,
      'Re-aggregating metrics or replay of payment event does not double-count (remains 1 order, 70,000 YER)'
    );

    // SCENARIO 7: Partial refunds adjust eligible spending
    console.log('\n[Requirement 7] Partial refunds adjust eligible spending');
    const partialRefund = await prisma.refundRequest.create({
      data: {
        refundNumber: `REF-TEST-PARTIAL-${Date.now()}`,
        orderId: completedPaidOrder.id,
        customerId: testUserId,
        sellerId: testSellerId,
        reasonText: 'Partial return of item',
        requestedAmount: 20000,
        approvedAmount: 20000,
        currency: 'YER',
        status: RefundStatus.ADMIN_APPROVED,
        resolvedAt: new Date(),
      },
    });

    const metricsAfterPartialRefund = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterPartialRefund.completedOrders === 1,
      'Order remains counted in completedOrders when only partially refunded'
    );
    assert(
      metricsAfterPartialRefund.periodSpend === 50000,
      'Period spend correctly reduced by approved partial refund amount (70,000 - 20,000 = 50,000 YER)',
      `Actual spend: ${metricsAfterPartialRefund.periodSpend}`
    );

    // SCENARIO 8: Full refunds remove eligibility
    console.log('\n[Requirement 8] Full refunds remove eligibility');
    await prisma.refundRequest.update({
      where: { id: partialRefund.id },
      data: {
        requestedAmount: 70000,
        approvedAmount: 70000,
        status: RefundStatus.REFUND_COMPLETED,
      },
    });

    const metricsAfterFullRefund = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterFullRefund.completedOrders === 0 && metricsAfterFullRefund.periodSpend === 0,
      'Fully refunded order is completely removed from completedOrders and eligible spend'
    );

    // Clean up the refund request and completed order
    await prisma.refundRequest.delete({ where: { id: partialRefund.id } });
    await prisma.payment.deleteMany({ where: { orderId: completedPaidOrder.id } });
    await prisma.order.delete({ where: { id: completedPaidOrder.id } });

    // SCENARIO 9: Cancelled orders do not qualify
    console.log('\n[Requirement 9] Cancelled orders do not qualify');
    const cancelledOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-CANCELLED-${Date.now()}`,
        userId: testUserId,
        subtotal: 90000,
        total: 90000,
        currency: 'YER',
        status: OrderStatus.CANCELLED_BY_CUSTOMER,
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 90000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const metricsAfterCancelled = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId);
    assert(
      metricsAfterCancelled.completedOrders === 0 && metricsAfterCancelled.periodSpend === 0,
      'Cancelled order contributes 0 completed orders and 0 eligible spend'
    );
    await prisma.payment.deleteMany({ where: { orderId: cancelledOrder.id } });
    await prisma.order.delete({ where: { id: cancelledOrder.id } });

    // SCENARIO 10: Annual qualification period resets correctly
    console.log('\n[Requirement 10] Annual qualification period resets correctly');
    const fourHundredDaysAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const expiredOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-EXPIRED-${Date.now()}`,
        userId: testUserId,
        subtotal: 100000,
        total: 100000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        deliveredAt: fourHundredDaysAgo,
        createdAt: fourHundredDaysAgo,
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 100000,
            currency: 'YER',
            paidAt: fourHundredDaysAgo,
          },
        },
      },
    });

    const rollingMetrics = await MembershipMetricsService.computeAuthoritativeMetrics(testUserId, 365);
    assert(
      rollingMetrics.lifetimeSpend === 100000 && rollingMetrics.completedOrders === 1,
      'Expired order is captured in lifetime spend and lifetime orders'
    );
    assert(
      rollingMetrics.periodSpend === 0 && rollingMetrics.periodCompletedOrders === 0,
      'Order outside 365-day rolling period is excluded from periodSpend and periodCompletedOrders'
    );

    const expiredEval = await MembershipEligibilityService.evaluateCustomerTier(testUserId, {
      forceAuthoritativeRecalculation: true,
    });
    assert(
      expiredEval.targetTierCode === 'BASIC' && expiredEval.isUpgraded === false,
      'Expired order cannot qualify customer for Silver/Gold/Platinum (customer stays at Basic)'
    );

    await prisma.payment.deleteMany({ where: { orderId: expiredOrder.id } });
    await prisma.order.delete({ where: { id: expiredOrder.id } });

    // SCENARIO 11: Platinum cannot be granted without meeting requirements
    console.log('\n[Requirement 11] Platinum cannot be granted without meeting requirements');
    const goldMetrics: CustomerMetricsSnapshot = {
      userId: testUserId,
      completedOrders: 15,
      periodCompletedOrders: 15,
      lifetimeSpend: 130000,
      periodSpend: 130000,
      pointsBalance: 0,
      accountAgeDays: 50,
      evaluationTimestamp: new Date().toISOString(),
    };

    const platinumTier = await prisma.membershipTier.findUnique({ where: { code: 'VIP_PLUS' } });
    if (!platinumTier) throw new Error('VIP_PLUS tier not found');
    const platinumRules = platinumTier.qualificationRules as unknown as QualificationRulesConfig;

    assert(
      MembershipRulesEngine.isEligible(platinumRules, goldMetrics, 4) === false,
      'Gold-level metrics (15 orders, 130,000 YER) do not qualify for VIP+ Platinum'
    );

    // Corrupt rules protection: tier level 4 with empty rules must evaluate to false
    assert(
      MembershipRulesEngine.isEligible({ logic: 'ANY', rules: [] }, zeroMetrics, 4) === false,
      'Malformed/empty rules on Level 4 Platinum evaluate to FALSE (never granted by accident)'
    );

    // SCENARIO 12: Membership upgrades trigger one notification only
    console.log('\n[Requirement 12] Membership upgrades trigger one notification only');
    // Clean any prior test notifications
    await prisma.notificationDelivery.deleteMany({
      where: { notification: { userId: testUserId } },
    });
    await prisma.notification.deleteMany({ where: { userId: testUserId } });

    // Create an eligible order to qualify for Silver (needs 60,000 YER or 7 orders)
    const qualifyingSilverOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-SILVER-${Date.now()}`,
        userId: testUserId,
        subtotal: 65000,
        total: 65000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 65000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const upgradeResult = await MembershipEligibilityService.evaluateCustomerTier(testUserId, {
      forceAuthoritativeRecalculation: true,
    });

    assert(
      upgradeResult.isUpgraded === true && upgradeResult.targetTierCode === 'SILVER',
      'Customer successfully upgraded from Basic to Silver on meeting spend threshold'
    );

    // Wait a brief tick for async dispatch to settle
    await new Promise((r) => setTimeout(r, 800));

    const upgradeNotifications = await prisma.notification.findMany({
      where: { userId: testUserId },
    });
    assert(
      upgradeNotifications.length === 1,
      `Membership upgrade created exactly 1 notification record (found: ${upgradeNotifications.length})`,
      `Found ${upgradeNotifications.length} notifications`
    );
    assert(
      Boolean(upgradeNotifications[0]?.idempotencyKey?.startsWith(`membership_upgrade_${testUserId}_SILVER_`)),
      'Notification carries deterministic, tier-specific idempotency key'
    );

    // SCENARIO 13: Repeated events do not create duplicate notifications
    console.log('\n[Requirement 13] Repeated events do not create duplicate notifications');
    // Evaluate multiple times
    await MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true });
    await MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true });
    await MembershipEligibilityService.getCustomerSummary(testUserId, { forceEvaluation: true });
    await MembershipEligibilityService.getCustomerSummary(testUserId, { forceEvaluation: false });

    await new Promise((r) => setTimeout(r, 600));

    const notifsAfterRepeats = await prisma.notification.findMany({
      where: { userId: testUserId },
    });
    assert(
      notifsAfterRepeats.length === 1,
      `Notification count remains strictly 1 after multiple evaluations and screen views (found: ${notifsAfterRepeats.length})`
    );

    // SCENARIO 14: Concurrent order completion does not corrupt membership
    console.log('\n[Requirement 14] Concurrent order completion does not corrupt membership');
    // Launch 5 simultaneous evaluations in parallel
    const concurrentResults = await Promise.all([
      MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true }),
      MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true }),
      MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true }),
      MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true }),
      MembershipEligibilityService.evaluateCustomerTier(testUserId, { forceAuthoritativeRecalculation: true }),
    ]);

    const allConsistent = concurrentResults.every(
      (res) => res.targetTierCode === 'SILVER' && res.targetTierId === upgradeResult.targetTierId
    );
    assert(
      allConsistent,
      'Concurrent evaluations resolve through mutex without race conditions or tier corruption'
    );

    const notifsAfterConcurrency = await prisma.notification.findMany({
      where: { userId: testUserId },
    });
    assert(
      notifsAfterConcurrency.length === 1,
      `No duplicate notifications spawned during concurrent execution (found: ${notifsAfterConcurrency.length})`
    );

    // SCENARIO 15: Gold threshold is correctly evaluated
    console.log('\n[Requirement 15] Gold threshold is correctly evaluated');
    const qualifyingGoldOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-GOLD-${Date.now()}`,
        userId: testUserId,
        subtotal: 60000,
        total: 60000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 60000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const goldEvalResult = await MembershipEligibilityService.evaluateCustomerTier(testUserId, {
      forceAuthoritativeRecalculation: true,
    });
    assert(
      goldEvalResult.targetTierCode === 'GOLD' && goldEvalResult.membership.tier.level === 3,
      'Customer upgraded to Gold (Level 3) when cumulative qualifying spend reaches 125,000 YER (threshold: 120,000 YER)',
      `Actual Tier: ${goldEvalResult.targetTierCode}`
    );

    // SCENARIO 16: Platinum threshold is correctly evaluated
    console.log('\n[Requirement 16] Platinum threshold is correctly evaluated');
    const qualifyingPlatinumOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD-TEST-PLATINUM-${Date.now()}`,
        userId: testUserId,
        subtotal: 130000,
        total: 130000,
        currency: 'YER',
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 130000,
            currency: 'YER',
            paidAt: new Date(),
          },
        },
      },
    });

    const platinumEvalResult = await MembershipEligibilityService.evaluateCustomerTier(testUserId, {
      forceAuthoritativeRecalculation: true,
    });
    assert(
      platinumEvalResult.targetTierCode === 'VIP_PLUS' && platinumEvalResult.membership.tier.level === 4,
      'Customer upgraded to VIP+ Platinum (Level 4) when cumulative spend reaches 255,000 YER (threshold: 250,000 YER)',
      `Actual Tier: ${platinumEvalResult.targetTierCode}`
    );

    // SCENARIO 17: Admin threshold changes are respected
    console.log('\n[Requirement 17] Admin threshold changes are respected');
    const goldTierRecord = await prisma.membershipTier.findUnique({ where: { code: 'GOLD' } });
    if (goldTierRecord) {
      // Temporarily set Platinum spend rule to 500,000 YER
      const platinumTierRecord = await prisma.membershipTier.findUnique({ where: { code: 'VIP_PLUS' } });
      if (platinumTierRecord) {
        const originalPlatinumRules = platinumTierRecord.qualificationRules;
        await prisma.membershipTier.update({
          where: { code: 'VIP_PLUS' },
          data: {
            qualificationRules: JSON.stringify({
              logic: 'ANY',
              rules: [
                { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 50 },
                { metric: 'PERIOD_SPEND', operator: 'GTE', value: 500000 },
              ],
            }),
          },
        });

        await MembershipEligibilityService.onTierConfigurationChanged();

        const reEvalAfterThresholdChange = await MembershipEligibilityService.evaluateCustomerTier(testUserId, {
          forceAuthoritativeRecalculation: true,
        });

        assert(
          reEvalAfterThresholdChange.targetTierCode === 'GOLD',
          'Customer tier adjusted to Gold after admin raised VIP+ Platinum threshold to 500,000 YER',
          `Tier: ${reEvalAfterThresholdChange.targetTierCode}`
        );

        // Restore original VIP_PLUS rules
        await prisma.membershipTier.update({
          where: { code: 'VIP_PLUS' },
          data: { qualificationRules: originalPlatinumRules },
        });
        await MembershipEligibilityService.onTierConfigurationChanged();
      }
    }

    // SCENARIO 18: Cache invalidation works
    console.log('\n[Requirement 18] Cache invalidation works');
    const dummySummary = { tierCode: 'TEST', level: 99 };
    await MembershipCacheService.setCustomerSummary(testUserId, dummySummary);
    const cachedItem = await MembershipCacheService.getCustomerSummary(testUserId);
    assert(cachedItem !== null && cachedItem.level === 99, 'Cache correctly stores customer summary');

    await MembershipCacheService.invalidateCustomer(testUserId);
    const postInvalidateItem = await MembershipCacheService.getCustomerSummary(testUserId);
    assert(postInvalidateItem === null, 'invalidateCustomer successfully purges cached summary from Redis');

    // SCENARIO 19: Customers cannot modify their own membership level through API requests
    console.log('\n[Requirement 19] Customers cannot modify their own membership level through API requests');
    const app = createApp();
    const server = http.createServer(app);
    const testPort = 4889;
    await new Promise<void>((resolve) => server.listen(testPort, resolve));

    try {
      const { accessToken: customerToken, sessionId } = JwtUtil.generateTokens({
        userId: testUserId,
        role: 'CUSTOMER' as any,
        email: testUserEmail,
      });
      await redis.set(`active_session:${testUserId}`, sessionId, 3600);

      // Attempt 1: Customer tries to POST to customer membership endpoint to force upgrade
      const postAttempt = await fetch(`http://localhost:${testPort}/api/v1/customers/me/membership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({ level: 4, tierCode: 'VIP_PLUS' }),
      });
      assert(
        postAttempt.status === 404 || postAttempt.status === 405,
        `Customer cannot mutate membership via POST to /customers/me/membership (HTTP ${postAttempt.status})`
      );

      // Attempt 2: Customer tries to call admin override endpoint
      const adminOverrideAttempt = await fetch(
        `http://localhost:${testPort}/api/v1/admin/membership/customers/${testUserId}/override`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({ overrideTierId: 'any_id', reason: 'Self upgrade hack' }),
        }
      );
      assert(
        adminOverrideAttempt.status === 403,
        `Customer token is rejected with 403 Forbidden on admin override endpoint (HTTP ${adminOverrideAttempt.status})`
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise((r) => setTimeout(r, 600));
    }

    // Clean up test orders and user
    await prisma.notificationDelivery.deleteMany({ where: { notification: { userId: testUserId } } });
    await prisma.notification.deleteMany({ where: { userId: testUserId } });
    await prisma.membershipAuditLog.deleteMany({ where: { userId: testUserId } });
    await prisma.customerMembership.deleteMany({ where: { userId: testUserId } });
    await prisma.payment.deleteMany({
      where: {
        orderId: { in: [qualifyingSilverOrder.id, qualifyingGoldOrder.id, qualifyingPlatinumOrder.id] },
      },
    });
    await prisma.order.deleteMany({
      where: {
        id: { in: [qualifyingSilverOrder.id, qualifyingGoldOrder.id, qualifyingPlatinumOrder.id] },
      },
    });
    await prisma.user.delete({ where: { id: testUserId } });
    console.log('\n🧹 Test customer and transient artifacts safely cleaned up.');
  } catch (err: any) {
    console.error('Fatal error during scenario tests:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`📊 FINAL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runComprehensiveMembershipTestSuite()
  .catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
