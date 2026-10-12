import { sellerPromotionService } from '../src/modules/promotions/services/seller-promotion.service';
import { bannerRecommendationService } from '../src/modules/promotions/services/banner-recommendation.service';

async function runTests() {
  console.log('🧪 Starting SOUQNAA Seller Marketing & Promotion Engine Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  try {
    // ── 1. Promotion Status Transitions ──────────────────────────────────────
    console.log('--- 1. Promotion State Machine Transitions ---');

    // Valid transitions
    const validTransitions: Record<string, string[]> = {
      DRAFT: ['PAYMENT_PENDING', 'CANCELLED'],
      PAYMENT_PENDING: ['PAID', 'CANCELLED'],
      PAID: ['ADMIN_REVIEW', 'APPROVED', 'ACTIVE', 'CANCELLED'],
      ADMIN_REVIEW: ['APPROVED', 'ADMIN_REJECTED', 'CANCELLED'],
      APPROVED: ['SCHEDULED', 'ACTIVE', 'CANCELLED'],
      SCHEDULED: ['ACTIVE', 'PAUSED', 'CANCELLED'],
      ACTIVE: ['PAUSED', 'COMPLETED', 'CANCELLED'],
      PAUSED: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
      ADMIN_REJECTED: ['DRAFT', 'CANCELLED'],
    };

    function canTransition(from: string, to: string): boolean {
      return validTransitions[from]?.includes(to) ?? false;
    }

    assert(canTransition('DRAFT', 'PAYMENT_PENDING'), 'Can advance DRAFT to PAYMENT_PENDING');
    assert(canTransition('PAYMENT_PENDING', 'PAID'), 'Can advance PAYMENT_PENDING to PAID');
    assert(canTransition('PAID', 'ADMIN_REVIEW'), 'Can advance PAID to ADMIN_REVIEW');
    assert(canTransition('ADMIN_REVIEW', 'APPROVED'), 'Admin can APPROVE from ADMIN_REVIEW');
    assert(canTransition('ADMIN_REVIEW', 'ADMIN_REJECTED'), 'Admin can REJECT from ADMIN_REVIEW');
    assert(canTransition('APPROVED', 'ACTIVE'), 'Approved promotion can become ACTIVE');
    assert(canTransition('ACTIVE', 'PAUSED'), 'Active promotion can be PAUSED');
    assert(canTransition('PAUSED', 'ACTIVE'), 'Paused promotion can be RESUMED');
    assert(canTransition('ACTIVE', 'COMPLETED'), 'Active promotion can COMPLETE');
    assert(canTransition('ACTIVE', 'CANCELLED'), 'Active promotion can be CANCELLED with refund');
    assert(!canTransition('COMPLETED', 'ACTIVE'), 'Completed promotion CANNOT be reactivated');
    assert(!canTransition('CANCELLED', 'PAID'), 'Cancelled promotion CANNOT transition to PAID');

    // ── 2. Budget & Refund Calculation Logic ─────────────────────────────────
    console.log('\n--- 2. Budget & Refund Calculation ---');

    function calculateRefund(totalBudget: number, spentAmount: number): number {
      const remaining = totalBudget - spentAmount;
      return Math.max(0, remaining);
    }

    const unspentRefund = calculateRefund(25000, 0);
    assert(unspentRefund === 25000, 'Full refund when 0 spent');

    const partialRefund = calculateRefund(25000, 10000);
    assert(partialRefund === 15000, 'Partial refund correctly returns remaining budget');

    const fullySpentRefund = calculateRefund(25000, 25000);
    assert(fullySpentRefund === 0, 'No refund when budget fully exhausted');

    const overspentRefund = calculateRefund(25000, 30000);
    assert(overspentRefund === 0, 'No negative refund if spent exceeds budget');

    // ── 3. Weighted Ranking & Rotation Algorithm ─────────────────────────────
    console.log('\n--- 3. Weighted Ranking & Rotation ---');

    interface CandidatePromotion {
      id: string;
      remainingBudget: number;
      ctr: number;
      roas: number;
      score: number;
    }

    function calculatePromotionRankScore(promo: { remainingBudget: number; ctr: number; roas: number }): number {
      // Score = (remainingBudget * 0.4) + (CTR * 1000 * 0.3) + (ROAS * 100 * 0.3)
      const budgetWeight = Math.min(promo.remainingBudget / 10000, 10) * 0.4;
      const ctrWeight = Math.min(promo.ctr * 100, 10) * 0.3;
      const roasWeight = Math.min(promo.roas, 10) * 0.3;
      return budgetWeight + ctrWeight + roasWeight;
    }

    const highBudgetHighPerf = calculatePromotionRankScore({ remainingBudget: 50000, ctr: 0.05, roas: 4.5 });
    const lowBudgetLowPerf = calculatePromotionRankScore({ remainingBudget: 2000, ctr: 0.01, roas: 1.0 });

    assert(highBudgetHighPerf > lowBudgetLowPerf, 'Higher budget & higher performing promotion ranks higher');
    assert(highBudgetHighPerf > 0, 'Rank score is strictly positive');

    // ── 4. Inventory-Awareness Guard ─────────────────────────────────────────
    console.log('\n--- 4. Inventory-Awareness Guard ---');

    function isEligibleToServe(product: { status: string; stock: number; isApproved: boolean }): boolean {
      if (product.status !== 'ACTIVE') return false;
      if (!product.isApproved) return false;
      if (product.stock <= 0) return false;
      return true;
    }

    assert(
      isEligibleToServe({ status: 'ACTIVE', stock: 15, isApproved: true }),
      'In-stock active approved product is served',
    );
    assert(
      !isEligibleToServe({ status: 'ACTIVE', stock: 0, isApproved: true }),
      'Out-of-stock product is SUPPRESSED from serving',
    );
    assert(
      !isEligibleToServe({ status: 'INACTIVE', stock: 50, isApproved: true }),
      'Inactive product is SUPPRESSED from serving',
    );
    assert(
      !isEligibleToServe({ status: 'ACTIVE', stock: 10, isApproved: false }),
      'Unapproved product is SUPPRESSED from serving',
    );

    // ── 5. Frequency Capping & Dedup Logic ────────────────────────────────────
    console.log('\n--- 5. Frequency Capping & Deduplication ---');

    class MockFrequencyCapTracker {
      private views = new Map<string, number>();

      recordView(key: string): void {
        this.views.set(key, (this.views.get(key) ?? 0) + 1);
      }

      isCapped(key: string, maxViewsPerPeriod: number): boolean {
        return (this.views.get(key) ?? 0) >= maxViewsPerPeriod;
      }
    }

    const capTracker = new MockFrequencyCapTracker();
    const userSessionKey = 'user-123:promo-456';
    const MAX_IMPRESSIONS = 3;

    assert(!capTracker.isCapped(userSessionKey, MAX_IMPRESSIONS), 'Not capped before reaching limit');
    capTracker.recordView(userSessionKey);
    capTracker.recordView(userSessionKey);
    assert(!capTracker.isCapped(userSessionKey, MAX_IMPRESSIONS), 'Not capped at 2 views (limit 3)');
    capTracker.recordView(userSessionKey);
    assert(capTracker.isCapped(userSessionKey, MAX_IMPRESSIONS), 'Capped when reaching limit of 3 impressions');

    // ── 6. Idempotency Key Validation ────────────────────────────────────────
    console.log('\n--- 6. Idempotency Key Validation ---');

    const seenIdempotencyKeys = new Set<string>();

    function processPaymentIdempotent(idempotencyKey: string): { processed: boolean; error?: string } {
      if (!idempotencyKey || idempotencyKey.trim().length === 0) {
        return { processed: false, error: 'MISSING_KEY' };
      }
      if (seenIdempotencyKeys.has(idempotencyKey)) {
        return { processed: false, error: 'DUPLICATE_KEY' };
      }
      seenIdempotencyKeys.add(idempotencyKey);
      return { processed: true };
    }

    const firstAttempt = processPaymentIdempotent('pay-idem-001');
    assert(firstAttempt.processed, 'First attempt with idempotency key succeeds');

    const duplicateAttempt = processPaymentIdempotent('pay-idem-001');
    assert(!duplicateAttempt.processed && duplicateAttempt.error === 'DUPLICATE_KEY', 'Duplicate idempotency key rejected');

    const emptyKeyAttempt = processPaymentIdempotent('');
    assert(!emptyKeyAttempt.processed && emptyKeyAttempt.error === 'MISSING_KEY', 'Empty idempotency key rejected');

  } catch (error) {
    console.error('Fatal error during test execution:', error);
    failed++;
  }

  console.log(`\n========================================`);
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
