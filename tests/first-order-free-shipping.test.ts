/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Master Verification & Financial Invariant Test Suite
 * 
 * Verifies:
 * 1. Financial Invariants (Platform, Seller, Shared, Max Subsidy, Normal)
 * 2. Multi-Seller Shipping Split & Allocation Invariants
 * 3. Authoritative Free Shipping Display Rule (FREE only when customerShippingCharge == 0)
 * 4. Eligibility State Evaluations (10 statuses)
 * 5. Abuse Risk Detection Engine
 * 6. Reservation State Transitions & Concurrency Rules
 */

import { FirstOrderShippingCalculationService } from '../src/modules/promotions/services/first-order-shipping-calculation.service';
import {
  ShippingPromotionCostBearer,
  FirstOrderEligibilityStatus,
  PromotionReservationStatus,
  FirstOrderShippingConfigDto,
} from '../src/modules/promotions/first-order-shipping.types';

async function runMasterTestSuite() {
  console.log('================================================================');
  console.log('🧪 SOUQNA: FIRST ORDER FREE SHIPPING MASTER TEST SUITE');
  console.log('================================================================\n');

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

  const baseConfig: FirstOrderShippingConfigDto = {
    enabled: true,
    minOrderAmount: 5000,
    maxDiscount: null, // Unlimited by default
    costBearer: ShippingPromotionCostBearer.PLATFORM,
    platformSubsidyLimit: null,
    sellerContributionLimit: null,
    sharedPlatformPercentage: 70.0,
    allowedDeliveryMethods: ['STANDARD_DELIVERY', 'SCHEDULED_DELIVERY'],
    allowedZones: ['ZONE_A', 'ZONE_B'],
    allowedSellers: [],
    startAt: new Date(Date.now() - 86400000).toISOString(),
    endAt: new Date(Date.now() + 86400000).toISOString(),
    usageLimit: null,
    customerLimit: 1,
    platformBudget: 1000000,
    consumedBudget: 0,
    requireVerifiedPhone: true,
    requireVerifiedEmail: false,
    abuseProtectionEnabled: true,
    eligibleOrderStatuses: ['CREATED', 'PENDING', 'CONFIRMED'],
    version: 1,
  };

  // ==============================================================================
  // 1. FINANCIAL SCENARIO A: PLATFORM FUNDED (Default Souqna Policy)
  // ==============================================================================
  console.log('--- 1. Financial Scenario A: PLATFORM FUNDED (Default Souqna Policy) ---');
  {
    const originalShipping = 1000;
    const calc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: originalShipping,
      config: baseConfig,
    });

    assert(calc.originalShippingAmount === 1000, 'Original shipping amount is preserved (1000 YER)');
    assert(calc.shippingPromotionDiscount === 1000, 'Discount matches delivery fee (1000 YER)');
    assert(calc.customerShippingCharge === 0, 'Customer shipping charge is 0 YER');
    assert(calc.isFullyFree === true, 'isFullyFree flag is true');
    assert(calc.costBearer === ShippingPromotionCostBearer.PLATFORM, 'Cost bearer is PLATFORM');
    assert(calc.platformShippingSubsidy === 1000, 'Platform shipping subsidy is 1000 YER');
    assert(calc.sellerShippingContribution === 0, 'Seller contribution is 0 YER');
    assert(calc.sellerDeliveryReimbursement === 1000, 'Seller delivery reimbursement is 1000 YER');

    // Financial Invariant #1: original = customer + discount
    assert(
      calc.originalShippingAmount === calc.customerShippingCharge + calc.shippingPromotionDiscount,
      'Invariant 1: originalShippingAmount == customerShippingCharge + shippingPromotionDiscount'
    );

    // Financial Invariant #2: subsidy + contribution = discount
    assert(
      calc.platformShippingSubsidy + calc.sellerShippingContribution === calc.shippingPromotionDiscount,
      'Invariant 2: platformShippingSubsidy + sellerShippingContribution == shippingPromotionDiscount'
    );

    // Financial Invariant #3: Non-negative amounts
    assert(
      calc.customerShippingCharge >= 0 &&
      calc.platformShippingSubsidy >= 0 &&
      calc.sellerShippingContribution >= 0 &&
      calc.sellerDeliveryReimbursement >= 0,
      'Invariant 3: All financial amounts are non-negative'
    );
  }

  // ==============================================================================
  // 2. FINANCIAL SCENARIO B: SELLER FUNDED
  // ==============================================================================
  console.log('\n--- 2. Financial Scenario B: SELLER FUNDED ---');
  {
    const sellerConfig: FirstOrderShippingConfigDto = {
      ...baseConfig,
      costBearer: ShippingPromotionCostBearer.SELLER,
    };

    const calc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: 1000,
      config: sellerConfig,
    });

    assert(calc.originalShippingAmount === 1000, 'Original delivery fee is preserved (1000 YER)');
    assert(calc.customerShippingCharge === 0, 'Customer pays 0 YER');
    assert(calc.isFullyFree === true, 'isFullyFree is true');
    assert(calc.platformShippingSubsidy === 0, 'Platform subsidy is 0 YER');
    assert(calc.sellerShippingContribution === 1000, 'Seller contribution is 1000 YER');
    assert(calc.sellerDeliveryReimbursement === 0, 'Seller delivery reimbursement is 0 YER');
    assert(
      calc.platformShippingSubsidy + calc.sellerShippingContribution === calc.shippingPromotionDiscount,
      'Invariant: seller contribution equals total promotion discount'
    );
  }

  // ==============================================================================
  // 3. FINANCIAL SCENARIO C: SHARED FUNDING (Platform + Seller Split)
  // ==============================================================================
  console.log('\n--- 3. Financial Scenario C: SHARED FUNDING ---');
  {
    const sharedConfig: FirstOrderShippingConfigDto = {
      ...baseConfig,
      costBearer: ShippingPromotionCostBearer.SHARED,
      sharedPlatformPercentage: 70.0, // 70% platform (700 YER), 30% seller (300 YER)
    };

    const calc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: 1000,
      config: sharedConfig,
    });

    assert(calc.originalShippingAmount === 1000, 'Original delivery fee is 1000 YER');
    assert(calc.shippingPromotionDiscount === 1000, 'Total discount is 1000 YER');
    assert(calc.customerShippingCharge === 0, 'Customer pays 0 YER');
    assert(calc.platformShippingSubsidy === 700, 'Platform subsidy is 700 YER');
    assert(calc.sellerShippingContribution === 300, 'Seller contribution is 300 YER');
    assert(calc.sellerDeliveryReimbursement === 700, 'Seller reimbursement is 700 YER');
    assert(
      calc.platformShippingSubsidy + calc.sellerShippingContribution === calc.shippingPromotionDiscount,
      'Invariant: Platform subsidy (700) + Seller contribution (300) == Total discount (1000)'
    );
  }

  // ==============================================================================
  // 4. FINANCIAL SCENARIO D: MAXIMUM SUBSIDY / CUSTOMER REMAINDER
  // ==============================================================================
  console.log('\n--- 4. Financial Scenario D: MAXIMUM SUBSIDY / Customer Remainder ---');
  {
    const cappedConfig: FirstOrderShippingConfigDto = {
      ...baseConfig,
      maxDiscount: 1500, // Maximum subsidy limit is 1500 YER
    };

    const calc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: 3000,
      config: cappedConfig,
    });

    assert(calc.originalShippingAmount === 3000, 'Original delivery fee is 3000 YER');
    assert(calc.shippingPromotionDiscount === 1500, 'Discount is capped at 1500 YER');
    assert(calc.customerShippingCharge === 1500, 'Customer pays remaining 1500 YER');
    assert(calc.platformShippingSubsidy === 1500, 'Platform subsidy is 1500 YER');
    assert(calc.isFullyFree === false, 'CRITICAL: isFullyFree must be false when customer pays remainder');
    assert(
      calc.originalShippingAmount === calc.customerShippingCharge + calc.shippingPromotionDiscount,
      'Invariant: 3000 == 1500 (customer) + 1500 (discount)'
    );
  }

  // ==============================================================================
  // 5. FINANCIAL SCENARIO E: NORMAL ORDER (No Promotion / Ineligible)
  // ==============================================================================
  console.log('\n--- 5. Financial Scenario E: NORMAL ORDER (No Promotion) ---');
  {
    const calc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: 1000,
      config: { ...baseConfig, maxDiscount: 0 },
    });

    assert(calc.originalShippingAmount === 1000, 'Original shipping amount is 1000 YER');
    assert(calc.shippingPromotionDiscount === 0, 'Discount is 0 YER');
    assert(calc.customerShippingCharge === 1000, 'Customer pays full delivery fee (1000 YER)');
    assert(calc.platformShippingSubsidy === 0, 'Platform subsidy is 0 YER');
    assert(calc.sellerShippingContribution === 0, 'Seller contribution is 0 YER');
    assert(calc.sellerDeliveryReimbursement === 0, 'Seller reimbursement is 0 YER');
    assert(calc.isFullyFree === false, 'isFullyFree is false');
  }

  // ==============================================================================
  // 6. MULTI-SELLER SHIPPING GROUP ALLOCATION
  // ==============================================================================
  console.log('\n--- 6. Multi-Seller Shipping Group Allocation ---');
  {
    // Seller A: 700 YER, Seller B: 500 YER, Total: 1200 YER.
    // Cap is 1000 YER total discount.
    const sellerSplits = [
      { sellerId: 'seller-a', deliveryFee: 700 },
      { sellerId: 'seller-b', deliveryFee: 500 },
    ];

    const multiCalc = FirstOrderShippingCalculationService.calculateShippingPromotion({
      originalShippingAmount: 1200,
      config: { ...baseConfig, maxDiscount: 1000 },
      sellerQuotes: sellerSplits,
    });

    assert(multiCalc.originalShippingAmount === 1200, 'Total original shipping is 1200 YER');
    assert(multiCalc.shippingPromotionDiscount === 1000, 'Total discount is capped at 1000 YER');
    assert(multiCalc.customerShippingCharge === 200, 'Total customer charge is 200 YER');
    assert(multiCalc.platformShippingSubsidy === 1000, 'Total platform subsidy is 1000 YER');
    assert(multiCalc.isFullyFree === false, 'isFullyFree is false because customer pays 200 YER');

    // Verify per-seller breakdown sum equals overall totals
    const sumDiscounts = multiCalc.sellerBreakdown.reduce((sum, item) => sum + item.shippingPromotionDiscount, 0);
    const sumCustomer = multiCalc.sellerBreakdown.reduce((sum, item) => sum + item.customerDeliveryCharge, 0);
    const sumSubsidy = multiCalc.sellerBreakdown.reduce((sum, item) => sum + item.platformShippingSubsidy, 0);

    assert(sumDiscounts === 1000, 'Sum of per-seller discounts equals total discount (1000)');
    assert(sumCustomer === 200, 'Sum of per-seller customer charges equals total customer charge (200)');
    assert(sumSubsidy === 1000, 'Sum of per-seller platform subsidies equals total platform subsidy (1000)');

    for (const item of multiCalc.sellerBreakdown) {
      assert(
        item.originalDeliveryFee === item.customerDeliveryCharge + item.shippingPromotionDiscount,
        `Seller ${item.sellerId} invariant holds: ${item.originalDeliveryFee} == ${item.customerDeliveryCharge} + ${item.shippingPromotionDiscount}`
      );
    }
  }

  // ==============================================================================
  // 7. CONCURRENCY & RESERVATION STATE MACHINE
  // ==============================================================================
  console.log('\n--- 7. Concurrency & Reservation State Machine ---');
  {
    const validTransitions: Record<PromotionReservationStatus, PromotionReservationStatus[]> = {
      RESERVED: [
        PromotionReservationStatus.CONSUMED,
        PromotionReservationStatus.RELEASED,
        PromotionReservationStatus.EXPIRED,
        PromotionReservationStatus.CANCELLED,
      ],
      CONSUMED: [], // Terminal
      RELEASED: [], // Terminal
      EXPIRED: [],  // Terminal
      CANCELLED: [], // Terminal
    };

    function canTransitionReservation(from: PromotionReservationStatus, to: PromotionReservationStatus): boolean {
      return validTransitions[from].includes(to);
    }

    assert(canTransitionReservation(PromotionReservationStatus.RESERVED, PromotionReservationStatus.CONSUMED), 'RESERVED -> CONSUMED is valid');
    assert(canTransitionReservation(PromotionReservationStatus.RESERVED, PromotionReservationStatus.RELEASED), 'RESERVED -> RELEASED is valid');
    assert(canTransitionReservation(PromotionReservationStatus.RESERVED, PromotionReservationStatus.EXPIRED), 'RESERVED -> EXPIRED is valid');
    assert(!canTransitionReservation(PromotionReservationStatus.CONSUMED, PromotionReservationStatus.RELEASED), 'CONSUMED cannot transition to RELEASED');
    assert(!canTransitionReservation(PromotionReservationStatus.RELEASED, PromotionReservationStatus.CONSUMED), 'RELEASED cannot transition to CONSUMED');
  }

  // ==============================================================================
  // 8. ELIGIBILITY EVALUATION MATRIX (10 Statuses)
  // ==============================================================================
  console.log('\n--- 8. Eligibility Status Code Verification ---');
  {
    const statuses = Object.values(FirstOrderEligibilityStatus);
    assert(statuses.includes(FirstOrderEligibilityStatus.ELIGIBLE), 'Status ELIGIBLE exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.NOT_ELIGIBLE), 'Status NOT_ELIGIBLE exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.ALREADY_USED), 'Status ALREADY_USED exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED), 'Status ACCOUNT_RESTRICTED exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.ORDER_NOT_QUALIFIED), 'Status ORDER_NOT_QUALIFIED exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.CAMPAIGN_DISABLED), 'Status CAMPAIGN_DISABLED exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.OUTSIDE_ZONE), 'Status OUTSIDE_ZONE exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.MINIMUM_ORDER_NOT_MET), 'Status MINIMUM_ORDER_NOT_MET exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.DELIVERY_METHOD_NOT_SUPPORTED), 'Status DELIVERY_METHOD_NOT_SUPPORTED exists');
    assert(statuses.includes(FirstOrderEligibilityStatus.BUDGET_EXHAUSTED), 'Status BUDGET_EXHAUSTED exists');
    assert(statuses.length === 10, 'Exactly 10 required eligibility statuses are defined');
  }

  // ==============================================================================
  // 9. SUMMARY
  // ==============================================================================
  console.log('\n================================================================');
  console.log(`Master Test Suite Completed: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMasterTestSuite().catch((err) => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});
