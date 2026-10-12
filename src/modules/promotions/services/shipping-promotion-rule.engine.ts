/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Authoritative Rule Engine
 * Version: 2.0.0
 */

import { ShippingPromotion } from '@prisma/client';
import {
  UniversalPromotionRuleContext,
  RuleEvaluationResult,
  PromotionReasonCode,
} from '../universal-shipping-promotion.types';

export class ShippingPromotionRuleEngine {
  /**
   * Evaluates all rule suites (Time, Customer, Order, Seller, Delivery) against a given promotion.
   * Returns a list of evaluation results for matched/failed rules.
   */
  public static evaluateAllRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext,
    customerUsageCount: number = 0
  ): {
    allPassed: boolean;
    primaryReason: PromotionReasonCode;
    results: RuleEvaluationResult[];
  } {
    const results: RuleEvaluationResult[] = [];

    // 1. Time / Schedule Rules
    const timeResults = this.evaluateTimeRules(promotion, context);
    results.push(...timeResults);

    // 2. Customer Eligibility Rules
    const customerResults = this.evaluateCustomerRules(promotion, context, customerUsageCount);
    results.push(...customerResults);

    // 3. Order Qualification Rules
    const orderResults = this.evaluateOrderRules(promotion, context);
    results.push(...orderResults);

    // 4. Delivery Method & Zone Rules
    const deliveryResults = this.evaluateDeliveryRules(promotion, context);
    results.push(...deliveryResults);

    // 5. Seller Eligibility Rules
    const sellerResults = this.evaluateSellerRules(promotion, context);
    results.push(...sellerResults);

    const firstFailure = results.find((r) => !r.passed);

    return {
      allPassed: !firstFailure,
      primaryReason: firstFailure ? firstFailure.reasonCode : 'ELIGIBLE',
      results,
    };
  }

  /**
   * 1. TIME RULES
   */
  public static evaluateTimeRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext
  ): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const now = context.time?.now || new Date();

    // Start Date
    if (promotion.startAt && now < promotion.startAt) {
      results.push({
        ruleName: 'START_DATE',
        passed: false,
        reasonCode: 'PROMOTION_NOT_STARTED',
        message: `Promotion starts at ${promotion.startAt.toISOString()}`,
      });
    } else {
      results.push({ ruleName: 'START_DATE', passed: true, reasonCode: 'ELIGIBLE' });
    }

    // End Date
    if (promotion.endAt && now > promotion.endAt) {
      results.push({
        ruleName: 'END_DATE',
        passed: false,
        reasonCode: 'PROMOTION_EXPIRED',
        message: `Promotion ended at ${promotion.endAt.toISOString()}`,
      });
    } else {
      results.push({ ruleName: 'END_DATE', passed: true, reasonCode: 'ELIGIBLE' });
    }

    // JSON-based Day of Week & Hour restrictions
    const timeRules = (promotion.deliveryEligibilityRules as any)?.timeRules || {};
    if (Array.isArray(timeRules.allowedDaysOfWeek) && timeRules.allowedDaysOfWeek.length > 0) {
      const currentDay = now.getUTCDay();
      const passed = timeRules.allowedDaysOfWeek.includes(currentDay);
      results.push({
        ruleName: 'DAY_OF_WEEK',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'OUTSIDE_PROMOTION_WINDOW',
      });
    }

    if (timeRules.allowedHours && typeof timeRules.allowedHours === 'object') {
      const currentHour = now.getUTCHours();
      const minHour = timeRules.allowedHours.min ?? 0;
      const maxHour = timeRules.allowedHours.max ?? 24;
      const passed = currentHour >= minHour && currentHour <= maxHour;
      results.push({
        ruleName: 'TIME_OF_DAY',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'OUTSIDE_PROMOTION_WINDOW',
      });
    }

    return results;
  }

  /**
   * 2. CUSTOMER RULES
   */
  public static evaluateCustomerRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext,
    customerUsageCount: number
  ): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const customer = context.customer;

    // First Order Requirement (promotion type or rule)
    if (promotion.type === 'FIRST_ORDER') {
      const isFirst = customer.completedOrderCount === 0;
      results.push({
        ruleName: 'IS_FIRST_ORDER',
        passed: isFirst,
        reasonCode: isFirst ? 'ELIGIBLE' : 'NOT_FIRST_ORDER',
        message: isFirst ? undefined : `Customer has ${customer.completedOrderCount} prior orders`,
      });
    }

    // New Customer Requirement (promotion type or rule)
    if (promotion.type === 'NEW_CUSTOMER') {
      const isNew = customer.isNewCustomer ?? (customer.completedOrderCount === 0);
      const custRules = (promotion.customerEligibilityRules as any) || {};
      const maxAgeDays = custRules.maxAccountAgeDays;

      let agePassed = true;
      if (typeof maxAgeDays === 'number' && typeof customer.accountAgeDays === 'number') {
        agePassed = customer.accountAgeDays <= maxAgeDays;
      }

      const passed = isNew && agePassed;
      results.push({
        ruleName: 'IS_NEW_CUSTOMER',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'NOT_NEW_CUSTOMER',
        message: passed ? undefined : 'Customer does not meet new customer criteria',
      });
    }

    // Phone verification requirement
    if (promotion.requiresVerifiedPhone && !customer.isPhoneVerified) {
      results.push({
        ruleName: 'CUSTOMER_PHONE_VERIFIED',
        passed: false,
        reasonCode: 'PHONE_NOT_VERIFIED',
        message: 'Phone number verification is required',
      });
    } else {
      results.push({ ruleName: 'CUSTOMER_PHONE_VERIFIED', passed: true, reasonCode: 'ELIGIBLE' });
    }

    // Email verification requirement
    if (promotion.requiresVerifiedEmail && !customer.isEmailVerified) {
      results.push({
        ruleName: 'CUSTOMER_EMAIL_VERIFIED',
        passed: false,
        reasonCode: 'EMAIL_NOT_VERIFIED',
        message: 'Email verification is required',
      });
    } else {
      results.push({ ruleName: 'CUSTOMER_EMAIL_VERIFIED', passed: true, reasonCode: 'ELIGIBLE' });
    }

    // Customer usage limit
    if (promotion.customerUsageLimit !== null && promotion.customerUsageLimit !== undefined) {
      const passed = customerUsageCount < promotion.customerUsageLimit;
      results.push({
        ruleName: 'CUSTOMER_USAGE_COUNT',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'CUSTOMER_USAGE_LIMIT_REACHED',
        message: passed ? undefined : `Customer reached limit of ${promotion.customerUsageLimit} uses`,
      });
    }

    // Abuse / Fraud restriction
    if (customer.isRestricted) {
      results.push({
        ruleName: 'ABUSE_RESTRICTION',
        passed: false,
        reasonCode: 'ABUSE_RESTRICTED',
        message: 'Account flagged for promotional abuse',
      });
    }

    // Membership Tier Requirement
    const custRules = (promotion.customerEligibilityRules as any) || {};
    if (Array.isArray(custRules.allowedMembershipTiers) && custRules.allowedMembershipTiers.length > 0) {
      const currentTier = (customer.membershipTier || 'REGULAR').toUpperCase();
      const passed = custRules.allowedMembershipTiers.map((t: string) => t.toUpperCase()).includes(currentTier);
      results.push({
        ruleName: 'MEMBERSHIP_TIER',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'MEMBERSHIP_TIER_NOT_QUALIFIED',
        message: passed ? undefined : `Requires membership tier in [${custRules.allowedMembershipTiers.join(', ')}]`,
      });
    }

    if (typeof custRules.minMembershipLevel === 'number') {
      const currentLevel = customer.membershipTierLevel ?? 0;
      const passed = currentLevel >= custRules.minMembershipLevel;
      results.push({
        ruleName: 'MIN_MEMBERSHIP_LEVEL',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'MEMBERSHIP_TIER_NOT_QUALIFIED',
        message: passed ? undefined : `Requires membership level >= ${custRules.minMembershipLevel}`,
      });
    }

    return results;
  }

  /**
   * 3. ORDER RULES
   */
  public static evaluateOrderRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext
  ): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const order = context.order;

    // Minimum Order Amount
    const minAmount = promotion.minimumOrderAmount || 0;
    if (order.subtotal < minAmount) {
      results.push({
        ruleName: 'MINIMUM_ORDER_AMOUNT',
        passed: false,
        reasonCode: 'MINIMUM_SPEND_NOT_REACHED',
        message: `Order subtotal (${order.subtotal}) below minimum (${minAmount})`,
      });
    } else {
      results.push({ ruleName: 'MINIMUM_ORDER_AMOUNT', passed: true, reasonCode: 'ELIGIBLE' });
    }

    // Allowed Products (if specified)
    if (Array.isArray(promotion.allowedProducts) && promotion.allowedProducts.length > 0) {
      const hasProduct = order.productIds.some((pId) => promotion.allowedProducts.includes(pId));
      results.push({
        ruleName: 'ALLOWED_PRODUCTS',
        passed: hasProduct,
        reasonCode: hasProduct ? 'ELIGIBLE' : 'ORDER_STATUS_NOT_QUALIFIED',
      });
    }

    // Allowed Categories (if specified)
    if (Array.isArray(promotion.allowedCategories) && promotion.allowedCategories.length > 0) {
      const hasCategory = order.categoryIds.some((cId) => promotion.allowedCategories.includes(cId));
      results.push({
        ruleName: 'ALLOWED_CATEGORIES',
        passed: hasCategory,
        reasonCode: hasCategory ? 'ELIGIBLE' : 'ORDER_STATUS_NOT_QUALIFIED',
      });
    }

    return results;
  }

  /**
   * 4. DELIVERY RULES
   */
  public static evaluateDeliveryRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext
  ): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const delivery = context.delivery;

    // Allowed Delivery Methods
    if (
      Array.isArray(promotion.allowedDeliveryMethods) &&
      promotion.allowedDeliveryMethods.length > 0
    ) {
      const currentMethod = (delivery.deliveryMethod || '').toLowerCase();
      const passed = promotion.allowedDeliveryMethods.some(
        (m) => m.toLowerCase() === currentMethod
      );
      results.push({
        ruleName: 'DELIVERY_METHOD',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'DELIVERY_METHOD_NOT_SUPPORTED',
        message: passed ? undefined : `Delivery method '${delivery.deliveryMethod}' not supported`,
      });
    }

    // Allowed Delivery Zones
    if (Array.isArray(promotion.allowedZones) && promotion.allowedZones.length > 0) {
      const currentZone = (delivery.deliveryZone || '').trim();
      const passed = currentZone.length > 0 && promotion.allowedZones.includes(currentZone);
      results.push({
        ruleName: 'DELIVERY_ZONE',
        passed,
        reasonCode: passed ? 'ELIGIBLE' : 'ZONE_NOT_SUPPORTED',
        message: passed ? undefined : `Delivery zone '${delivery.deliveryZone}' not supported`,
      });
    }

    return results;
  }

  /**
   * 5. SELLER RULES
   */
  public static evaluateSellerRules(
    promotion: ShippingPromotion,
    context: UniversalPromotionRuleContext
  ): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const sellers = context.sellers || [];

    // Allowed Sellers (if specified)
    if (Array.isArray(promotion.allowedSellers) && promotion.allowedSellers.length > 0) {
      const hasAllowedSeller = sellers.some((s) => promotion.allowedSellers.includes(s.id));
      results.push({
        ruleName: 'ALLOWED_SELLERS',
        passed: hasAllowedSeller,
        reasonCode: hasAllowedSeller ? 'ELIGIBLE' : 'SELLER_NOT_ELIGIBLE',
      });
    }

    // Seller First Purchase (promotion type or rule)
    if (promotion.type === 'SELLER_FIRST_PURCHASE') {
      // Must have 0 previous orders specifically with at least one participating seller
      const eligibleForSeller = sellers.some(
        (s) => s.previousOrderCountFromSeller === 0 && s.isActive && s.isPromotionEnabled
      );
      results.push({
        ruleName: 'SELLER_FIRST_PURCHASE',
        passed: eligibleForSeller,
        reasonCode: eligibleForSeller ? 'ELIGIBLE' : 'NOT_FIRST_ORDER',
        message: eligibleForSeller
          ? undefined
          : 'Customer already has completed orders with this seller',
      });
    }

    return results;
  }
}
