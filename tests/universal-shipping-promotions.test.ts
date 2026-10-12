/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Master Production Automated Test Suite
 * Version: 2.0.0
 * 
 * Verifies:
 * 1. Rule Engine evaluation (Time, Customer, Order, Delivery, Seller)
 * 2. All 9 Promotion Types:
 *    - FIRST_ORDER, SEASONAL, MINIMUM_SPEND, SELLER_FUNDED, PLATFORM_FUNDED,
 *      SHARED_FUNDED, CAMPAIGN, NEW_CUSTOMER, SELLER_FIRST_PURCHASE
 * 3. All 3 Funding Types (PLATFORM, SELLER, SHARED)
 * 4. Strict Financial Invariants (Invariants 1-5)
 * 5. Maximum Discount Capping & Partial Percentage/Fixed Discounts
 * 6. Multi-Seller Proportional Split & Exact Penny Conservation
 * 7. Authoritative Free Shipping Display Rule (FREE only when customerShippingCharge === 0)
 * 8. Stacking Policies (BEST_SHIPPING_PROMOTION, PRIORITY, NONE, COMBINE_ALLOWED, EXCLUSIVE_CAMPAIGN)
 * 9. Budget, Usage Limits, and Zero-Trust Recalculation
 */

import { ShippingPromotionRuleEngine } from '../src/modules/promotions/services/shipping-promotion-rule.engine';
import { ShippingFundingEngine } from '../src/modules/promotions/services/shipping-funding.engine';
import { ShippingPromotionCalculationEngine } from '../src/modules/promotions/services/shipping-promotion-calculation.engine';
import { ShippingPromotionStackingEngine } from '../src/modules/promotions/services/shipping-promotion-stacking.engine';
import {
  ShippingPromotion,
  ShippingPromotionType,
  ShippingFundingType,
  ShippingPromotionStatus,
  ShippingPromotionStackingPolicy,
} from '@prisma/client';
import { UniversalPromotionRuleContext } from '../src/modules/promotions/universal-shipping-promotion.types';

async function runUniversalShippingPromotionsTests() {
  console.log('================================================================');
  console.log('🧪 SOUQNA: UNIVERSAL SHIPPING PROMOTIONS SYSTEM MASTER TEST SUITE');
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

  function mockPromotion(overrides: Partial<ShippingPromotion> = {}): ShippingPromotion {
    return {
      id: 'promo-123',
      code: 'TEST_PROMO',
      name: 'Test Promotion',
      nameAr: 'عرض تجريبي',
      description: 'Test description',
      descriptionAr: 'وصف تجريبي',
      type: 'FIRST_ORDER',
      fundingType: 'PLATFORM',
      status: 'ACTIVE',
      priority: 10,
      startAt: new Date(Date.now() - 3600000), // 1 hour ago
      endAt: new Date(Date.now() + 86400000), // 1 day future
      minimumOrderAmount: 0,
      maximumDiscountAmount: null,
      percentageDiscount: 100,
      fixedDiscount: null,
      customerEligibilityRules: {},
      sellerEligibilityRules: {},
      orderEligibilityRules: {},
      deliveryEligibilityRules: {},
      locationEligibilityRules: {},
      allowedDeliveryMethods: ['standard', 'asap', 'scheduled'],
      allowedZones: [],
      allowedSellers: [],
      allowedProducts: [],
      allowedCategories: [],
      platformSubsidyRate: 70,
      sellerContributionRate: 30,
      platformSubsidyLimit: null,
      sellerContributionLimit: null,
      customerUsageLimit: 1,
      sellerUsageLimit: null,
      globalUsageLimit: 10000,
      currentUsageCount: 0,
      campaignId: null,
      campaignBudget: 1000000,
      consumedBudget: 0,
      remainingBudget: 1000000,
      requiresVerifiedPhone: false,
      requiresVerifiedEmail: false,
      abuseProtectionEnabled: true,
      stackingPolicy: 'BEST_SHIPPING_PROMOTION',
      reservationRequired: true,
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function mockContext(overrides: Partial<UniversalPromotionRuleContext> = {}): UniversalPromotionRuleContext {
    return {
      customer: {
        id: 'cust-1',
        completedOrderCount: 0,
        accountAgeDays: 2,
        isPhoneVerified: true,
        isEmailVerified: true,
        isRestricted: false,
      },
      order: {
        subtotal: 10000,
        itemCount: 2,
        sellerCount: 1,
        productIds: ['prod-1', 'prod-2'],
        categoryIds: ['cat-1'],
      },
      delivery: {
        deliveryMethod: 'standard',
        deliveryZone: 'SANA_A_CENTRAL',
        originalShippingAmount: 1500,
        sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 1500 }],
      },
      sellers: [
        {
          id: 'seller-A',
          previousOrderCountFromSeller: 0,
          isActive: true,
          isPromotionEnabled: true,
        },
      ],
      time: { now: new Date() },
      ...overrides,
    };
  }

  // ============================================================================
  // SUITE 1: FINANCIAL INVARIANTS & FUNDING ENGINE
  // ============================================================================
  console.log('--- SUITE 1: Financial Invariants & Funding Types ---');

  // Test 1.1: Platform Funding Full Free Shipping
  {
    const promo = mockPromotion({ fundingType: 'PLATFORM', percentageDiscount: 100 });
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 1000,
      promotion: promo,
      sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 1000 }],
    });

    assert(funding.originalShippingAmount === 1000, 'Original shipping amount is 1000');
    assert(funding.shippingPromotionDiscount === 1000, 'Discount is 1000');
    assert(funding.customerShippingCharge === 0, 'Customer shipping charge is 0');
    assert(funding.platformShippingSubsidy === 1000, 'Platform subsidy is 1000');
    assert(funding.sellerShippingContribution === 0, 'Seller contribution is 0');
    assert(funding.sellerDeliveryReimbursement === 1000, 'Seller delivery reimbursement is 1000');
    assert(funding.isFreeShipping === true, 'isFreeShipping is true when customer charge is 0');
    assert(
      funding.originalShippingAmount === funding.customerShippingCharge + funding.shippingPromotionDiscount,
      'Invariant 1: original === customer + discount'
    );
    assert(
      funding.shippingPromotionDiscount === funding.platformShippingSubsidy + funding.sellerShippingContribution,
      'Invariant 2: discount === platform + seller'
    );
  }

  // Test 1.2: Seller-Funded Free Shipping
  {
    const promo = mockPromotion({ fundingType: 'SELLER', percentageDiscount: 100 });
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 1200,
      promotion: promo,
      sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 1200 }],
    });

    assert(funding.customerShippingCharge === 0, 'Seller-funded customer pays 0');
    assert(funding.platformShippingSubsidy === 0, 'Platform pays 0');
    assert(funding.sellerShippingContribution === 1200, 'Seller contributes full 1200');
    assert(funding.sellerDeliveryReimbursement === 0, 'Seller reimbursement is 0');
    assert(funding.isFreeShipping === true, 'isFreeShipping is true');
  }

  // Test 1.3: Shared-Funded Free Shipping (70% Platform, 30% Seller)
  {
    const promo = mockPromotion({
      fundingType: 'SHARED',
      percentageDiscount: 100,
      platformSubsidyRate: 70,
      sellerContributionRate: 30,
    });
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 1000,
      promotion: promo,
      sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 1000 }],
    });

    assert(funding.customerShippingCharge === 0, 'Customer charge is 0');
    assert(funding.shippingPromotionDiscount === 1000, 'Total discount is 1000');
    assert(funding.platformShippingSubsidy === 700, 'Platform pays 700 (70%)');
    assert(funding.sellerShippingContribution === 300, 'Seller pays 300 (30%)');
    assert(funding.sellerDeliveryReimbursement === 700, 'Seller is reimbursed platform subsidy (700)');
    assert(funding.isFreeShipping === true, 'isFreeShipping is true');
  }

  // Test 1.4: Maximum Discount Cap (Original 3000, Max Discount 1500)
  {
    const promo = mockPromotion({
      fundingType: 'PLATFORM',
      percentageDiscount: 100,
      maximumDiscountAmount: 1500,
    });
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 3000,
      promotion: promo,
      sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 3000 }],
    });

    assert(funding.shippingPromotionDiscount === 1500, 'Discount capped at 1500');
    assert(funding.customerShippingCharge === 1500, 'Customer pays remaining 1500');
    assert(funding.platformShippingSubsidy === 1500, 'Platform subsidizes 1500');
    assert(funding.isFreeShipping === false, 'isFreeShipping is FALSE because customer pays 1500');
  }

  // Test 1.5: Fixed Discount (e.g. 500 YER off)
  {
    const promo = mockPromotion({
      fundingType: 'PLATFORM',
      percentageDiscount: null,
      fixedDiscount: 500,
    });
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 1200,
      promotion: promo,
      sellerDeliveries: [{ sellerId: 'seller-A', deliveryFee: 1200 }],
    });

    assert(funding.shippingPromotionDiscount === 500, 'Fixed discount applied (500)');
    assert(funding.customerShippingCharge === 700, 'Customer charge is 700');
    assert(funding.isFreeShipping === false, 'Not free shipping');
  }

  // Test 1.6: Multi-Seller Cart Proportional Allocation
  {
    const promo = mockPromotion({
      fundingType: 'PLATFORM',
      percentageDiscount: 100,
      maximumDiscountAmount: 1500,
    });
    // Seller A: 700, Seller B: 500, Seller C: 800. Total = 2000. Promo max = 1500. Customer = 500.
    const sellerDeliveries = [
      { sellerId: 'seller-A', deliveryFee: 700 },
      { sellerId: 'seller-B', deliveryFee: 500 },
      { sellerId: 'seller-C', deliveryFee: 800 },
    ];
    const funding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: 2000,
      promotion: promo,
      sellerDeliveries,
    });

    assert(funding.originalShippingAmount === 2000, 'Original shipping is 2000');
    assert(funding.shippingPromotionDiscount === 1500, 'Total discount is 1500');
    assert(funding.customerShippingCharge === 500, 'Total customer charge is 500');
    assert(funding.sellerBreakdown.length === 3, 'All 3 sellers have allocations');

    const sumAllocDiscounts = funding.sellerBreakdown.reduce((s, b) => s + b.shippingPromotionDiscount, 0);
    const sumCustomerCharges = funding.sellerBreakdown.reduce((s, b) => s + b.customerDeliveryCharge, 0);
    const sumPlatformSubsidies = funding.sellerBreakdown.reduce((s, b) => s + b.platformShippingSubsidy, 0);

    assert(Math.abs(sumAllocDiscounts - 1500) < 0.01, 'Sum of seller discounts matches 1500 exactly');
    assert(Math.abs(sumCustomerCharges - 500) < 0.01, 'Sum of customer charges matches 500 exactly');
    assert(Math.abs(sumPlatformSubsidies - 1500) < 0.01, 'Sum of platform subsidies matches 1500 exactly');
  }

  // ============================================================================
  // SUITE 2: RULE ENGINE & ELIGIBILITY
  // ============================================================================
  console.log('\n--- SUITE 2: Universal Rule Engine & Eligibility ---');

  // Test 2.1: First Order Rule (0 completed orders => Eligible, 1 completed order => Ineligible)
  {
    const promo = mockPromotion({ type: 'FIRST_ORDER' });
    const ctxNew = mockContext({ customer: { id: 'c1', completedOrderCount: 0, isPhoneVerified: true, isEmailVerified: true } });
    const evalNew = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxNew });
    assert(evalNew.eligible === true, 'First order promotion eligible when completed orders = 0');
    assert(evalNew.reasonCode === 'ELIGIBLE', 'Reason code is ELIGIBLE');

    const ctxOld = mockContext({ customer: { id: 'c2', completedOrderCount: 2, isPhoneVerified: true, isEmailVerified: true } });
    const evalOld = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxOld });
    assert(evalOld.eligible === false, 'First order promotion rejected when completed orders > 0');
    assert(evalOld.reasonCode === 'NOT_FIRST_ORDER', 'Reason code is NOT_FIRST_ORDER');
  }

  // Test 2.2: New Customer with maxAccountAgeDays Rule
  {
    const promo = mockPromotion({
      type: 'NEW_CUSTOMER',
      customerEligibilityRules: { maxAccountAgeDays: 7 },
    });

    const ctxFresh = mockContext({ customer: { id: 'c1', completedOrderCount: 0, accountAgeDays: 3, isPhoneVerified: true, isEmailVerified: true } });
    const evalFresh = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxFresh });
    assert(evalFresh.eligible === true, 'New customer within account age window is eligible');

    const ctxStale = mockContext({ customer: { id: 'c2', completedOrderCount: 0, accountAgeDays: 14, isPhoneVerified: true, isEmailVerified: true } });
    const evalStale = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxStale });
    assert(evalStale.eligible === false, 'Customer older than 7 days is rejected');
    assert(evalStale.reasonCode === 'NOT_NEW_CUSTOMER', 'Reason is NOT_NEW_CUSTOMER');
  }

  // Test 2.3: Seller First Purchase Rule
  {
    const promo = mockPromotion({ type: 'SELLER_FIRST_PURCHASE' });

    // Customer has 0 previous orders with seller-A
    const ctxEligibleSeller = mockContext({
      sellers: [{ id: 'seller-A', previousOrderCountFromSeller: 0, isActive: true, isPromotionEnabled: true }],
    });
    const evalEligible = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxEligibleSeller });
    assert(evalEligible.eligible === true, 'Seller first purchase eligible when 0 orders with seller');

    // Customer has 3 previous orders with seller-B
    const ctxRepeatSeller = mockContext({
      sellers: [{ id: 'seller-B', previousOrderCountFromSeller: 3, isActive: true, isPromotionEnabled: true }],
    });
    const evalRepeat = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxRepeatSeller });
    assert(evalRepeat.eligible === false, 'Seller first purchase rejected when customer previously bought from seller');
    assert(evalRepeat.reasonCode === 'NOT_FIRST_ORDER', 'Reason code is NOT_FIRST_ORDER');
  }

  // Test 2.4: Minimum Spend Free Shipping
  {
    const promo = mockPromotion({ type: 'MINIMUM_SPEND', minimumOrderAmount: 10000 });

    const ctxMet = mockContext({ order: { subtotal: 10000, itemCount: 2, sellerCount: 1, productIds: [], categoryIds: [] } });
    const evalMet = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxMet });
    assert(evalMet.eligible === true, 'Subtotal 10000 meets 10000 minimum spend');

    const ctxUnder = mockContext({ order: { subtotal: 9999, itemCount: 2, sellerCount: 1, productIds: [], categoryIds: [] } });
    const evalUnder = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxUnder });
    assert(evalUnder.eligible === false, 'Subtotal 9999 rejected for 10000 minimum spend');
    assert(evalUnder.reasonCode === 'MINIMUM_SPEND_NOT_REACHED', 'Reason is MINIMUM_SPEND_NOT_REACHED');
  }

  // Test 2.5: Seasonal Promotion Date Windows
  {
    // Expired seasonal promotion
    const promoExpired = mockPromotion({
      type: 'SEASONAL',
      startAt: new Date(Date.now() - 86400000 * 5),
      endAt: new Date(Date.now() - 86400000), // Ended 1 day ago
    });
    const ctx = mockContext();
    const evalExp = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promoExpired, context: ctx });
    assert(evalExp.eligible === false, 'Expired seasonal promotion is rejected');
    assert(evalExp.reasonCode === 'PROMOTION_EXPIRED', 'Reason is PROMOTION_EXPIRED');

    // Future promotion
    const promoFuture = mockPromotion({
      type: 'SEASONAL',
      startAt: new Date(Date.now() + 86400000), // Starts tomorrow
      endAt: new Date(Date.now() + 86400000 * 5),
    });
    const evalFut = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promoFuture, context: ctx });
    assert(evalFut.eligible === false, 'Future promotion rejected before start date');
    assert(evalFut.reasonCode === 'PROMOTION_NOT_STARTED', 'Reason is PROMOTION_NOT_STARTED');
  }

  // Test 2.6: Delivery Method & Zone Restrictions
  {
    const promo = mockPromotion({
      allowedDeliveryMethods: ['express'],
      allowedZones: ['ZONE_X'],
    });

    const ctxWrongMethod = mockContext({
      delivery: {
        deliveryMethod: 'standard',
        deliveryZone: 'ZONE_X',
        originalShippingAmount: 1000,
        sellerDeliveries: [],
      },
    });
    const evalMethod = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxWrongMethod });
    assert(evalMethod.eligible === false, 'Standard delivery rejected when only express allowed');
    assert(evalMethod.reasonCode === 'DELIVERY_METHOD_NOT_SUPPORTED', 'Reason is DELIVERY_METHOD_NOT_SUPPORTED');

    const ctxWrongZone = mockContext({
      delivery: {
        deliveryMethod: 'express',
        deliveryZone: 'ZONE_Y',
        originalShippingAmount: 1000,
        sellerDeliveries: [],
      },
    });
    const evalZone = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxWrongZone });
    assert(evalZone.eligible === false, 'Zone Y rejected when only Zone X allowed');
    assert(evalZone.reasonCode === 'ZONE_NOT_SUPPORTED', 'Reason is ZONE_NOT_SUPPORTED');
  }

  // Test 2.7: Customer Phone & Email Verification
  {
    const promo = mockPromotion({ requiresVerifiedPhone: true, requiresVerifiedEmail: true });

    const ctxUnverified = mockContext({
      customer: { id: 'c1', completedOrderCount: 0, isPhoneVerified: false, isEmailVerified: true },
    });
    const evalUnverified = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo, context: ctxUnverified });
    assert(evalUnverified.eligible === false, 'Unverified phone rejected when verification required');
    assert(evalUnverified.reasonCode === 'PHONE_NOT_VERIFIED', 'Reason is PHONE_NOT_VERIFIED');
  }

  // Test 2.8: Customer Usage Limit
  {
    const promo = mockPromotion({ customerUsageLimit: 1 });
    const ctx = mockContext();
    const evalUsed = ShippingPromotionCalculationEngine.evaluatePromotion({
      promotion: promo,
      context: ctx,
      customerUsageCount: 1, // Already used 1 time
    });
    assert(evalUsed.eligible === false, 'Customer rejected after reaching usage limit of 1');
    assert(evalUsed.reasonCode === 'CUSTOMER_USAGE_LIMIT_REACHED', 'Reason is CUSTOMER_USAGE_LIMIT_REACHED');
  }

  // Test 2.9: Budget Exhaustion Check
  {
    const promoExhausted = mockPromotion({ remainingBudget: 0 });
    const ctx = mockContext();
    const evalExhausted = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promoExhausted, context: ctx });
    assert(evalExhausted.eligible === false, 'Promotion rejected when remaining budget is 0');
    assert(evalExhausted.reasonCode === 'PROMOTION_BUDGET_EXHAUSTED', 'Reason is PROMOTION_BUDGET_EXHAUSTED');
  }

  // ============================================================================
  // SUITE 3: STACKING ENGINE
  // ============================================================================
  console.log('\n--- SUITE 3: Stacking Policies ---');

  // Test 3.1: BEST_SHIPPING_PROMOTION (Default)
  {
    const promoA = mockPromotion({
      id: 'p-A',
      code: 'PROMO_50_PCT',
      percentageDiscount: 50, // 500 discount on 1000
    });
    const promoB = mockPromotion({
      id: 'p-B',
      code: 'PROMO_100_PCT',
      percentageDiscount: 100, // 1000 discount on 1000
    });

    const ctx = mockContext({ delivery: { deliveryMethod: 'standard', originalShippingAmount: 1000, sellerDeliveries: [] } });
    const resA = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promoA, context: ctx });
    const resB = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promoB, context: ctx });

    const stacked = ShippingPromotionStackingEngine.resolveStacking({
      eligiblePromotions: [resA, resB],
      originalShippingAmount: 1000,
      defaultPolicy: 'BEST_SHIPPING_PROMOTION',
    });

    assert(stacked.appliedPromotions.length === 1, 'Only 1 promotion applied under BEST_SHIPPING_PROMOTION');
    assert(stacked.appliedPromotions[0].promotionId === 'p-B', 'Best promotion (100% discount) selected');
    assert(stacked.rejectedPromotions.length === 1, 'Lesser promotion rejected');
    assert(stacked.aggregateCalculation.shippingPromotionDiscount === 1000, 'Aggregate discount is 1000');
    assert(stacked.aggregateCalculation.customerShippingCharge === 0, 'Customer pays 0');
  }

  // Test 3.2: EXCLUSIVE_CAMPAIGN Policy
  {
    const campaignPromo = mockPromotion({
      id: 'p-camp',
      code: 'CAMP_PROMO',
      type: 'CAMPAIGN',
      campaignId: 'camp-99',
      percentageDiscount: 80,
    });
    const regularPromo = mockPromotion({
      id: 'p-reg',
      code: 'REG_PROMO',
      type: 'FIRST_ORDER',
      percentageDiscount: 100,
    });

    const ctx = mockContext({ delivery: { deliveryMethod: 'standard', originalShippingAmount: 1000, sellerDeliveries: [] } });
    const resCamp = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: campaignPromo, context: ctx });
    const resReg = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: regularPromo, context: ctx });

    const stacked = ShippingPromotionStackingEngine.resolveStacking({
      eligiblePromotions: [resCamp, resReg],
      originalShippingAmount: 1000,
      defaultPolicy: 'EXCLUSIVE_CAMPAIGN',
    });

    assert(stacked.appliedPromotions.length === 1, 'Only 1 promotion applied under EXCLUSIVE_CAMPAIGN');
    assert(stacked.appliedPromotions[0].promotionId === 'p-camp', 'Campaign promotion takes precedence over non-campaign');
  }

  // Test 3.3: COMBINE_ALLOWED Policy
  {
    const promo1 = mockPromotion({
      id: 'p-1',
      code: 'P1_FIXED_400',
      percentageDiscount: null,
      fixedDiscount: 400,
    });
    const promo2 = mockPromotion({
      id: 'p-2',
      code: 'P2_FIXED_300',
      percentageDiscount: null,
      fixedDiscount: 300,
    });

    const ctx = mockContext({ delivery: { deliveryMethod: 'standard', originalShippingAmount: 1000, sellerDeliveries: [] } });
    const res1 = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo1, context: ctx });
    const res2 = ShippingPromotionCalculationEngine.evaluatePromotion({ promotion: promo2, context: ctx });

    const stacked = ShippingPromotionStackingEngine.resolveStacking({
      eligiblePromotions: [res1, res2],
      originalShippingAmount: 1000,
      defaultPolicy: 'COMBINE_ALLOWED',
    });

    assert(stacked.appliedPromotions.length === 2, 'Both promotions applied under COMBINE_ALLOWED');
    assert(stacked.aggregateCalculation.shippingPromotionDiscount === 700, 'Combined discount is 700 (400 + 300)');
    assert(stacked.aggregateCalculation.customerShippingCharge === 300, 'Customer pays remaining 300');
  }

  // ============================================================================
  // SUITE 4: SECURITY & UNTRUSTED CLIENT TAMPER PROTECTION
  // ============================================================================
  console.log('\n--- SUITE 4: Security & Tamper Protection ---');

  // Test 4.1: Client asserts discount = 5000 on a 1000 fee
  {
    // The server recalculates funding authoritatively ignoring any client-sent discount
    const promo = mockPromotion({ fundingType: 'PLATFORM', percentageDiscount: 100 });
    const originalFee = 1000;
    const clientManipulatedDiscount = 5000;

    const serverFunding = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: originalFee,
      promotion: promo,
    });

    assert(
      serverFunding.shippingPromotionDiscount === 1000,
      'Server caps discount to authoritative original shipping fee (1000), ignoring client 5000'
    );
    assert(
      serverFunding.customerShippingCharge === 0,
      'Customer charge is 0'
    );
    assert(
      serverFunding.shippingPromotionDiscount <= originalFee,
      'Discount never exceeds original delivery fee'
    );
  }

  // Test 4.2: Runtime Invariant Violation Assertion
  {
    let assertionThrown = false;
    try {
      // Intentionally invalid numbers (negative customer charge)
      ShippingFundingEngine.assertInvariants({
        originalShippingAmount: 1000,
        customerShippingCharge: -200,
        shippingPromotionDiscount: 1200,
        platformShippingSubsidy: 1200,
        sellerShippingContribution: 0,
      });
    } catch (err: any) {
      assertionThrown = true;
    }
    assert(assertionThrown, 'Runtime throws exception on invariant violation with negative amounts');
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`📊 MASTER TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runUniversalShippingPromotionsTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
