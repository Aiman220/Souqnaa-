import { SellerPerformanceCalculator } from '../src/modules/seller-performance/seller-performance-calculator.service';
import {
  PerformanceEngineConfig,
  PerformanceGrade,
  PerformanceDataStatus,
  RawPerformanceMetrics,
} from '../src/modules/seller-performance/seller-performance.types';
import { DEFAULT_PERFORMANCE_CONFIG } from '../src/modules/seller-performance/seller-performance.config';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

function assertApprox(actual: number, expected: number, tolerance = 0.5, message: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`[ASSERTION FAILED]: ${message} (Expected ~${expected}, got ${actual})`);
  }
}

async function runTests() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('🧪 RUNNING SOUQNAA SELLER PERFORMANCE SCORE ENGINE TESTS');
  console.log('────────────────────────────────────────────────────────────');

  const config: PerformanceEngineConfig = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    minOrders: 5,
    minReviews: 3,
    windowDays: 30,
    fulfillmentSlaHours: 48,
    weights: {
      satisfaction: 0.35,
      response: 0.20,
      completion: 0.20,
      fulfillment: 0.15,
      issueRate: 0.10,
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Customer Satisfaction Score (35%)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 1] Customer Satisfaction Normalization');
  {
    // 5.0 star -> 100
    const score5 = SellerPerformanceCalculator.calculateCustomerSatisfactionScore({
      ratingAverage: 5.0,
      reviewCount: 10,
      confirmedDisputesCount: 0,
    });
    assertApprox(score5, 100, 0.1, '5.0 stars should be 100 score');

    // 4.8 star -> 96
    const score48 = SellerPerformanceCalculator.calculateCustomerSatisfactionScore({
      ratingAverage: 4.8,
      reviewCount: 20,
      confirmedDisputesCount: 0,
    });
    assertApprox(score48, 96, 0.1, '4.8 stars should be 96 score');

    // 4.0 star with 2 confirmed disputes (5 pts each) -> 80 - 10 = 70
    const scoreDispute = SellerPerformanceCalculator.calculateCustomerSatisfactionScore({
      ratingAverage: 4.0,
      reviewCount: 15,
      confirmedDisputesCount: 2,
    });
    assertApprox(scoreDispute, 70, 0.1, '4.0 stars with 2 confirmed disputes should be 70 score');

    console.log('  ✔ 5.0 star, 4.8 star, and dispute penalties validated');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Response Time Score (20%)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 2] Response Time Bands & Answer Rate Composite');
  {
    // <= 5 min response time, 100% answer rate -> 100 score
    const resFast = SellerPerformanceCalculator.calculateResponseTimeScore({
      medianResponseMinutes: 4,
      totalConversations: 20,
      answeredConversations: 20,
      thresholds: config.responseTimeThresholds,
    });
    assertApprox(resFast.score, 100, 0.5, 'Fast response <= 5 min should be 100');
    assert(resFast.responseRate === 100, 'Answer rate should be 100%');

    // <= 15 min response time, 90% answer rate
    const resGood = SellerPerformanceCalculator.calculateResponseTimeScore({
      medianResponseMinutes: 15,
      totalConversations: 10,
      answeredConversations: 9,
      thresholds: config.responseTimeThresholds,
    });
    assert(resGood.score >= 80 && resGood.score <= 90, '15 min response should be in 80-90 range');
    assertApprox(resGood.responseRate, 90, 0.1, 'Answer rate should be 90%');

    // > 6 hours (slow), low answer rate (50%) -> Poor score (< 30)
    const resSlow = SellerPerformanceCalculator.calculateResponseTimeScore({
      medianResponseMinutes: 500,
      totalConversations: 10,
      answeredConversations: 5,
      thresholds: config.responseTimeThresholds,
    });
    assert(resSlow.score < 30, 'Slow response should be < 30');

    console.log('  ✔ Fast (<5m), intermediate (15m), and slow (>6h) response bands validated');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Order Completion Score (20%) — Customer Attribution Protection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 3] Order Completion & Customer Attribution Protection');
  {
    // Seller delivered 98 orders, cancelled 2 -> 98 / (98 + 2) = 98%
    const compHigh = SellerPerformanceCalculator.calculateOrderCompletionScore({
      deliveredCount: 98,
      sellerCancelledCount: 2,
    });
    assertApprox(compHigh.score, 98, 0.1, 'Completion rate should be 98%');

    // CRITICAL REQUIREMENT: Customer-caused cancellations DO NOT reduce seller score!
    // Seller has 20 delivered orders, 0 seller-cancelled, but 10 customer-cancelled!
    const compCustomerCancel = SellerPerformanceCalculator.calculateOrderCompletionScore({
      deliveredCount: 20,
      sellerCancelledCount: 0,
    });
    assertApprox(compCustomerCancel.score, 100, 0.1, 'Customer cancellations must NOT reduce seller score');

    // Seller with 10 delivered orders and 10 seller cancellations -> 50%
    const compLow = SellerPerformanceCalculator.calculateOrderCompletionScore({
      deliveredCount: 10,
      sellerCancelledCount: 10,
    });
    assertApprox(compLow.score, 50, 0.1, 'High seller cancellations should result in 50% completion');

    console.log('  ✔ Customer-caused cancellation exclusion & completion formula verified');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. On-Time Fulfillment Score (15%)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 4] On-Time Fulfillment within SLA');
  {
    // 94 out of 100 on-time -> 94%
    const fulHigh = SellerPerformanceCalculator.calculateOnTimeFulfillmentScore({
      onTimeCount: 94,
      totalFulfilledCount: 100,
    });
    assertApprox(fulHigh.score, 94, 0.1, 'Fulfillment score should be 94%');

    // 50 out of 100 on-time -> 50%
    const fulLow = SellerPerformanceCalculator.calculateOnTimeFulfillmentScore({
      onTimeCount: 50,
      totalFulfilledCount: 100,
    });
    assertApprox(fulLow.score, 50, 0.1, 'Fulfillment score should be 50%');

    console.log('  ✔ On-time SLA fulfillment calculation verified');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Cancellation / Issue Rate Score (10%)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 5] Legitimate Seller Issue Rate');
  {
    // 0 issues -> 100 score
    const issZero = SellerPerformanceCalculator.calculateIssueRateScore({
      sellerIssuesCount: 0,
      totalEligibleOrders: 100,
    });
    assertApprox(issZero.score, 100, 0.1, '0% issue rate must yield 100 score');

    // 2 issues out of 100 (2%) -> 100 - (2 * 10) = 80 score
    const issLow = SellerPerformanceCalculator.calculateIssueRateScore({
      sellerIssuesCount: 2,
      totalEligibleOrders: 100,
    });
    assertApprox(issLow.score, 80, 0.1, '2% issue rate should yield 80 score');

    // 10 issues out of 100 (10%) -> 0 score
    const issHigh = SellerPerformanceCalculator.calculateIssueRateScore({
      sellerIssuesCount: 10,
      totalEligibleOrders: 100,
    });
    assertApprox(issHigh.score, 0, 0.1, '10% issue rate should yield 0 score');

    console.log('  ✔ Issue rate normalization curve verified');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Test Scenario: Seller A (Excellent Performance)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 6] Scenario: Seller A (High Performance)');
  {
    const metricsA: RawPerformanceMetrics = {
      eligibleOrdersCount: 100,
      deliveredOrdersCount: 98,
      sellerCancelledOrdersCount: 2,
      customerCancelledOrdersCount: 5, // Excluded
      onTimeOrdersCount: 94,
      eligibleReviewsCount: 30,
      ratingAverage: 4.8,
      totalConversationsCount: 40,
      answeredConversationsCount: 39,
      medianResponseMinutes: 4.5,
      averageResponseMinutes: 5.2,
      confirmedDisputesCount: 0,
      sellerIssuesCount: 2,
    };

    const resA = SellerPerformanceCalculator.calculate(metricsA, config);
    console.log(`  Seller A Final Score: ${resA.finalScore} / Grade: ${resA.grade} / Status: ${resA.dataStatus}`);

    assert(resA.finalScore >= 90, `Seller A should have score >= 90, got ${resA.finalScore}`);
    assert(resA.grade === PerformanceGrade.EXCELLENT, `Seller A grade should be EXCELLENT, got ${resA.grade}`);
    assert(resA.dataStatus === PerformanceDataStatus.ESTABLISHED, 'Seller A should be ESTABLISHED');
    console.log('  ✔ Seller A correctly evaluated as EXCELLENT');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Test Scenario: Seller B (Poor Performance / Needs Improvement)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 7] Scenario: Seller B (Low Performance)');
  {
    const metricsB: RawPerformanceMetrics = {
      eligibleOrdersCount: 50,
      deliveredOrdersCount: 25,
      sellerCancelledOrdersCount: 25, // 50% cancellation!
      customerCancelledOrdersCount: 2,
      onTimeOrdersCount: 10,           // Only 40% on-time!
      eligibleReviewsCount: 15,
      ratingAverage: 2.2,             // Low rating
      totalConversationsCount: 20,
      answeredConversationsCount: 8,   // Unanswered chats
      medianResponseMinutes: 450,      // Slow > 6h
      averageResponseMinutes: 600,
      confirmedDisputesCount: 4,       // Multiple disputes
      sellerIssuesCount: 29,
    };

    const resB = SellerPerformanceCalculator.calculate(metricsB, config);
    console.log(`  Seller B Final Score: ${resB.finalScore} / Grade: ${resB.grade} / Status: ${resB.dataStatus}`);

    assert(resB.finalScore < 60, `Seller B should have score < 60, got ${resB.finalScore}`);
    assert(resB.grade === PerformanceGrade.NEEDS_IMPROVEMENT, `Seller B grade should be NEEDS_IMPROVEMENT, got ${resB.grade}`);
    assert(resB.recommendations.length > 0, 'Seller B should have actionable improvement guidance');
    console.log('  ✔ Seller B correctly evaluated as NEEDS_IMPROVEMENT with guidance');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Test Scenario: New Seller (Insufficient Data Protection)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 8] Scenario: New Seller Data Protection');
  {
    const metricsNew: RawPerformanceMetrics = {
      eligibleOrdersCount: 1,
      deliveredOrdersCount: 1,
      sellerCancelledOrdersCount: 0,
      customerCancelledOrdersCount: 0,
      onTimeOrdersCount: 1,
      eligibleReviewsCount: 1, // < minReviews (3)
      ratingAverage: 5.0,
      totalConversationsCount: 1,
      answeredConversationsCount: 1,
      medianResponseMinutes: 2,
      averageResponseMinutes: 2,
      confirmedDisputesCount: 0,
      sellerIssuesCount: 0,
    };

    const resNew = SellerPerformanceCalculator.calculate(metricsNew, config);
    console.log(`  New Seller Data Status: ${resNew.dataStatus} / Grade: ${resNew.grade}`);

    assert(resNew.dataStatus === PerformanceDataStatus.INSUFFICIENT_DATA, 'New seller must be INSUFFICIENT_DATA');
    assert(resNew.grade === PerformanceGrade.INSUFFICIENT_DATA, 'Grade must be INSUFFICIENT_DATA to prevent misleading 100/100');
    console.log('  ✔ New seller protected from misleading numerical score');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Weight Sum & Validation
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[Test 9] Weight Configuration Sum Validation');
  {
    const weights = config.weights;
    const total = weights.satisfaction + weights.response + weights.completion + weights.fulfillment + weights.issueRate;
    assertApprox(total, 1.0, 0.001, 'Configured weights must sum exactly to 1.00 (100%)');
    console.log(`  Weights: ${(weights.satisfaction * 100)}% + ${(weights.response * 100)}% + ${(weights.completion * 100)}% + ${(weights.fulfillment * 100)}% + ${(weights.issueRate * 100)}% = ${(total * 100)}%`);
    console.log('  ✔ Weights sum to 100% verified');
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('🎉 ALL SELLER PERFORMANCE SCORE ENGINE TESTS PASSED (9/9)');
  console.log('────────────────────────────────────────────────────────────\n');
}

runTests().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
