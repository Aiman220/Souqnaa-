import { prisma } from '../src/database/prisma';
import { MembershipRulesEngine } from '../src/modules/membership/membership-rules.engine';
import { MembershipEligibilityService } from '../src/modules/membership/membership-eligibility.service';
import { MembershipBenefitEngine } from '../src/modules/membership/membership-benefit.engine';
import { QualificationRulesConfig, CustomerMetricsSnapshot } from '../src/modules/membership/membership.types';
import { DEFAULT_MEMBERSHIP_TIERS } from '../src/database/seed_membership_tiers';

async function runMembershipTests() {
  console.log('====================================================');
  console.log('🧪 SOUQNA CUSTOMER MEMBERSHIP & VIP TIERS TEST SUITE');
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

  // ── TEST 1: Rule Engine ANY (OR) Evaluation ───────────────────────────────
  console.log('--- Test Suite 1: Pure Deterministic Rule Engine ---');
  {
    const rulesConfig: QualificationRulesConfig = {
      logic: 'ANY',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 15 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 120000 },
      ],
    };

    const metricsOrdersOnly: CustomerMetricsSnapshot = {
      userId: 'test_user_1',
      completedOrders: 15,
      periodCompletedOrders: 15,
      lifetimeSpend: 5000,
      periodSpend: 5000,
      pointsBalance: 100,
      accountAgeDays: 50,
      evaluationTimestamp: new Date().toISOString(),
    };

    const metricsSpendOnly: CustomerMetricsSnapshot = {
      userId: 'test_user_2',
      completedOrders: 2,
      periodCompletedOrders: 2,
      lifetimeSpend: 150000,
      periodSpend: 130000,
      pointsBalance: 500,
      accountAgeDays: 100,
      evaluationTimestamp: new Date().toISOString(),
    };

    const metricsNeither: CustomerMetricsSnapshot = {
      userId: 'test_user_3',
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
      'ANY logic passes when completed orders requirement met'
    );
    assert(
      MembershipRulesEngine.isEligible(rulesConfig, metricsSpendOnly) === true,
      'ANY logic passes when period spend requirement met'
    );
    assert(
      MembershipRulesEngine.isEligible(rulesConfig, metricsNeither) === false,
      'ANY logic fails when neither order nor spend requirement met'
    );
  }

  // ── TEST 2: Rule Engine ALL (AND) Evaluation ──────────────────────────────
  {
    const rulesConfigAll: QualificationRulesConfig = {
      logic: 'ALL',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 10 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 100000 },
      ],
    };

    const partialMetrics: CustomerMetricsSnapshot = {
      userId: 'test_user_4',
      completedOrders: 12,
      periodCompletedOrders: 12,
      lifetimeSpend: 80000,
      periodSpend: 80000,
      pointsBalance: 0,
      accountAgeDays: 30,
      evaluationTimestamp: new Date().toISOString(),
    };

    const fullMetrics: CustomerMetricsSnapshot = {
      userId: 'test_user_5',
      completedOrders: 12,
      periodCompletedOrders: 12,
      lifetimeSpend: 120000,
      periodSpend: 120000,
      pointsBalance: 0,
      accountAgeDays: 30,
      evaluationTimestamp: new Date().toISOString(),
    };

    assert(
      MembershipRulesEngine.isEligible(rulesConfigAll, partialMetrics) === false,
      'ALL logic fails when only orders requirement met but spend missing'
    );
    assert(
      MembershipRulesEngine.isEligible(rulesConfigAll, fullMetrics) === true,
      'ALL logic passes when both orders and spend requirements met'
    );
  }

  // ── TEST 3: Progress Engine Calculations ──────────────────────────────────
  console.log('\n--- Test Suite 2: Next-Tier Progress Calculations ---');
  {
    const targetVipRules: QualificationRulesConfig = {
      logic: 'ANY',
      rules: [
        { metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 10 },
        { metric: 'PERIOD_SPEND', operator: 'GTE', value: 100000 },
      ],
    };

    const currentMetrics: CustomerMetricsSnapshot = {
      userId: 'test_user_6',
      completedOrders: 8,
      periodCompletedOrders: 8,
      lifetimeSpend: 75000,
      periodSpend: 75000,
      pointsBalance: 0,
      accountAgeDays: 60,
      evaluationTimestamp: new Date().toISOString(),
    };

    const progress = MembershipRulesEngine.calculateProgress(targetVipRules, currentMetrics);

    assert(
      progress.spendProgress !== null && progress.spendProgress.percentage === 75,
      'Calculates spend progress correctly (75,000 / 100,000 = 75%)'
    );
    assert(
      progress.spendProgress !== null && progress.spendProgress.remaining === 25000,
      'Calculates spend remaining accurately (100,000 - 75,000 = 25,000 YER)'
    );
    assert(
      progress.orderProgress !== null && progress.orderProgress.percentage === 80,
      'Calculates order progress correctly (8 / 10 = 80%)'
    );
    assert(
      progress.percentage === 80,
      'For ANY rules, primary percentage prioritizes closest qualifying metric (80%)'
    );
  }

  // ── TEST 4: Database Integration & Customer Lifecycle ─────────────────────
  console.log('\n--- Test Suite 3: Database & Customer Lifecycle Integration ---');
  let testUserId = '';
  try {
    // Find or create test customer user
    let user = await prisma.user.findFirst({
      where: { email: 'vip_engine_tester@souqna.com' },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: 'vip_engine_tester@souqna.com',
          passwordHash: 'dummy_hash',
          firstName: 'عمار',
          lastName: 'اليمني',
          phone: '+967770001122',
          role: 'CUSTOMER',
        },
      });
    }
    testUserId = user.id;

    // 4.1 Onboarding initial membership assignment
    const initialMembership = await MembershipEligibilityService.getOrCreateMembership(testUserId);
    assert(
      initialMembership !== null && initialMembership.tier.code === 'REGULAR',
      'New customer is automatically assigned the baseline REGULAR tier (level 0)'
    );

    // 4.2 Customer Summary generation
    const summary = await MembershipEligibilityService.getCustomerSummary(testUserId);
    assert(
      summary.tierCode === 'REGULAR' && summary.level === 0,
      'Customer summary returns correct initial tier and level'
    );
    assert(
      summary.progress !== null && summary.progress.nextTierCode === 'MEMBER',
      'Customer summary identifies next tier as MEMBER'
    );

    // 4.3 Benefit Context
    const benefitsCtx = await MembershipBenefitEngine.getMembershipContext(testUserId);
    assert(
      benefitsCtx !== null && benefitsCtx.coinsMultiplier === 1.0,
      'Regular customer has default 1.0x coins multiplier'
    );
    assert(
      benefitsCtx !== null && benefitsCtx.freeShippingEligible === false,
      'Regular customer is not automatically eligible for VIP free shipping'
    );

    // 4.4 Manual Admin Override
    console.log('\n--- Test Suite 4: Manual Admin Override & Audit Trail ---');
    const vipTier = await prisma.membershipTier.findUnique({ where: { code: 'VIP' } });
    if (!vipTier) throw new Error('VIP tier not found');

    const override = await MembershipEligibilityService.applyOverride({
      userId: testUserId,
      overrideTierId: vipTier.id,
      reason: 'Special promotional VIP tier granted by Head of Commerce',
      adminId: 'admin_test_1',
    });

    assert(
      override.isActive === true && override.overrideTierId === vipTier.id,
      'Admin override created and marked active'
    );

    const overriddenSummary = await MembershipEligibilityService.getCustomerSummary(testUserId);
    assert(
      overriddenSummary.tierCode === 'VIP' && overriddenSummary.level === 3,
      'Customer summary immediately reflects VIP tier following override'
    );
    assert(
      Boolean(overriddenSummary.override?.isActive),
      'Customer summary denotes presence of active admin override'
    );

    const vipBenefitsCtx = await MembershipBenefitEngine.getMembershipContext(testUserId);
    assert(
      vipBenefitsCtx !== null && vipBenefitsCtx.coinsMultiplier === 1.2,
      'VIP customer receives 1.2x Coins multiplier'
    );
    assert(
      vipBenefitsCtx !== null && vipBenefitsCtx.freeShippingEligible === true,
      'VIP customer is eligible for VIP free shipping'
    );

    // 4.5 Audit Log Verification
    const auditLog = await prisma.membershipAuditLog.findFirst({
      where: { userId: testUserId, changeType: 'OVERRIDE_APPLIED' },
      orderBy: { createdAt: 'desc' },
    });
    assert(
      auditLog !== null && auditLog.actorRole === 'ADMIN',
      'Audit log recorded the administrative override with actor and reason'
    );

    // 4.6 Remove Override & Return to Automatic Evaluation
    await MembershipEligibilityService.removeOverride({
      userId: testUserId,
      adminId: 'admin_test_1',
    });

    const restoredSummary = await MembershipEligibilityService.getCustomerSummary(testUserId);
    assert(
      restoredSummary.tierCode === 'REGULAR',
      'Removing override immediately restores automatic rule evaluation to REGULAR'
    );
    assert(
      !restoredSummary.override,
      'Customer summary confirms override is no longer active'
    );
  } catch (err: any) {
    console.error('Database test error:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`📊 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMembershipTests()
  .catch((err) => {
    console.error('Fatal error running tests:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
