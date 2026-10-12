/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Universal Shipping Promotion Calculation Engine
 * Version: 2.0.0
 */

import { ShippingPromotion } from '@prisma/client';
import {
  UniversalPromotionRuleContext,
  PromotionEvaluationResult,
} from '../universal-shipping-promotion.types';
import { ShippingPromotionRuleEngine } from './shipping-promotion-rule.engine';
import { ShippingFundingEngine } from './shipping-funding.engine';

export class ShippingPromotionCalculationEngine {
  /**
   * Evaluates eligibility and computes full funding breakdown for a given shipping promotion.
   */
  public static evaluatePromotion(params: {
    promotion: ShippingPromotion;
    context: UniversalPromotionRuleContext;
    customerUsageCount?: number;
  }): PromotionEvaluationResult {
    const { promotion, context, customerUsageCount = 0 } = params;

    // 1. Quick status check
    if (promotion.status !== 'ACTIVE') {
      const reasonCode =
        promotion.status === 'EXHAUSTED'
          ? 'PROMOTION_BUDGET_EXHAUSTED'
          : promotion.status === 'EXPIRED'
          ? 'PROMOTION_EXPIRED'
          : promotion.status === 'PAUSED'
          ? 'PROMOTION_PAUSED'
          : 'PROMOTION_INACTIVE';

      return {
        eligible: false,
        promotionId: promotion.id,
        promotionCode: promotion.code,
        promotionName: promotion.name,
        promotionNameAr: promotion.nameAr,
        promotionType: promotion.type,
        fundingType: promotion.fundingType,
        priority: promotion.priority,
        reasonCode,
        matchedRules: [],
        failedRules: [reasonCode],
        expiresAt: promotion.endAt,
      };
    }

    // 2. Budget check (if remainingBudget is configured and <= 0)
    if (promotion.remainingBudget !== null && promotion.remainingBudget <= 0) {
      return {
        eligible: false,
        promotionId: promotion.id,
        promotionCode: promotion.code,
        promotionName: promotion.name,
        promotionNameAr: promotion.nameAr,
        promotionType: promotion.type,
        fundingType: promotion.fundingType,
        priority: promotion.priority,
        reasonCode: 'PROMOTION_BUDGET_EXHAUSTED',
        matchedRules: [],
        failedRules: ['BUDGET_EXHAUSTED'],
        expiresAt: promotion.endAt,
      };
    }

    // 3. Global usage limit check
    if (
      promotion.globalUsageLimit !== null &&
      promotion.currentUsageCount >= promotion.globalUsageLimit
    ) {
      return {
        eligible: false,
        promotionId: promotion.id,
        promotionCode: promotion.code,
        promotionName: promotion.name,
        promotionNameAr: promotion.nameAr,
        promotionType: promotion.type,
        fundingType: promotion.fundingType,
        priority: promotion.priority,
        reasonCode: 'GLOBAL_USAGE_LIMIT_REACHED',
        matchedRules: [],
        failedRules: ['GLOBAL_USAGE_LIMIT_REACHED'],
        expiresAt: promotion.endAt,
      };
    }

    // 4. Rule Engine Evaluation
    const ruleEvaluation = ShippingPromotionRuleEngine.evaluateAllRules(
      promotion,
      context,
      customerUsageCount
    );

    const matchedRules = ruleEvaluation.results.filter((r) => r.passed).map((r) => r.ruleName);
    const failedRules = ruleEvaluation.results.filter((r) => !r.passed).map((r) => r.ruleName);

    if (!ruleEvaluation.allPassed) {
      return {
        eligible: false,
        promotionId: promotion.id,
        promotionCode: promotion.code,
        promotionName: promotion.name,
        promotionNameAr: promotion.nameAr,
        promotionType: promotion.type,
        fundingType: promotion.fundingType,
        priority: promotion.priority,
        reasonCode: ruleEvaluation.primaryReason,
        matchedRules,
        failedRules,
        expiresAt: promotion.endAt,
      };
    }

    // 5. Eligible! Compute authoritative funding breakdown
    const calculation = ShippingFundingEngine.calculateFunding({
      originalShippingAmount: context.delivery.originalShippingAmount,
      promotion,
      sellerDeliveries: context.delivery.sellerDeliveries,
    });

    return {
      eligible: true,
      promotionId: promotion.id,
      promotionCode: promotion.code,
      promotionName: promotion.name,
      promotionNameAr: promotion.nameAr,
      promotionType: promotion.type,
      fundingType: promotion.fundingType,
      priority: promotion.priority,
      reasonCode: 'ELIGIBLE',
      matchedRules,
      failedRules: [],
      expiresAt: promotion.endAt,
      calculation,
    };
  }
}
