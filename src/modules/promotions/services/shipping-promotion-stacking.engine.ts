/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Authoritative Promotion Stacking Engine
 * Version: 2.0.0
 */

import {
  PromotionEvaluationResult,
  StackingEvaluationResult,
  ShippingPromotionStackingPolicy,
  ShippingFundingBreakdown,
} from '../universal-shipping-promotion.types';
import { ShippingFundingEngine } from './shipping-funding.engine';

export class ShippingPromotionStackingEngine {
  /**
   * Applies the configured stacking policy across all eligible shipping promotions.
   * By default (`BEST_SHIPPING_PROMOTION`), selects the single promotion offering the best customer discount.
   */
  public static resolveStacking(params: {
    eligiblePromotions: PromotionEvaluationResult[];
    originalShippingAmount: number;
    defaultPolicy?: ShippingPromotionStackingPolicy;
  }): StackingEvaluationResult {
    const { eligiblePromotions, originalShippingAmount, defaultPolicy = 'BEST_SHIPPING_PROMOTION' } = params;

    if (!eligiblePromotions || eligiblePromotions.length === 0) {
      return {
        appliedPromotions: [],
        rejectedPromotions: [],
        aggregateCalculation: this.zeroBreakdown(originalShippingAmount),
      };
    }

    // Single eligible promotion - trivially applied
    if (eligiblePromotions.length === 1) {
      const single = eligiblePromotions[0];
      return {
        appliedPromotions: [single],
        rejectedPromotions: [],
        aggregateCalculation: single.calculation || this.zeroBreakdown(originalShippingAmount),
      };
    }

    // Determine dominating policy: Check if any promotion requires EXCLUSIVE_CAMPAIGN or NONE
    const hasExclusive = eligiblePromotions.some(
      (p) => (p as any).stackingPolicy === 'EXCLUSIVE_CAMPAIGN'
    );
    const hasNone = eligiblePromotions.some((p) => (p as any).stackingPolicy === 'NONE');

    const effectivePolicy: ShippingPromotionStackingPolicy = hasExclusive
      ? 'EXCLUSIVE_CAMPAIGN'
      : hasNone
      ? 'NONE'
      : defaultPolicy;

    switch (effectivePolicy) {
      case 'EXCLUSIVE_CAMPAIGN': {
        // Prioritize campaign-linked promotions
        const campaignPromo = eligiblePromotions.find(
          (p) => p.promotionType === 'CAMPAIGN' || (p as any).campaignId
        );
        const chosen = campaignPromo || eligiblePromotions[0];
        const rejected = eligiblePromotions
          .filter((p) => p.promotionId !== chosen.promotionId)
          .map((p) => ({
            promotionId: p.promotionId,
            promotionCode: p.promotionCode,
            reasonCode: 'STACKING_NOT_ALLOWED' as const,
          }));

        return {
          appliedPromotions: [chosen],
          rejectedPromotions: rejected,
          aggregateCalculation: chosen.calculation || this.zeroBreakdown(originalShippingAmount),
        };
      }

      case 'PRIORITY': {
        // Sort descending by priority, then by discount amount
        const sorted = [...eligiblePromotions].sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          const discA = a.calculation?.shippingPromotionDiscount ?? 0;
          const discB = b.calculation?.shippingPromotionDiscount ?? 0;
          return discB - discA;
        });

        const chosen = sorted[0];
        const rejected = sorted.slice(1).map((p) => ({
          promotionId: p.promotionId,
          promotionCode: p.promotionCode,
          reasonCode: 'STACKING_NOT_ALLOWED' as const,
        }));

        return {
          appliedPromotions: [chosen],
          rejectedPromotions: rejected,
          aggregateCalculation: chosen.calculation || this.zeroBreakdown(originalShippingAmount),
        };
      }

      case 'NONE': {
        // Only the first highest priority promotion is accepted; all others rejected
        const chosen = eligiblePromotions[0];
        const rejected = eligiblePromotions.slice(1).map((p) => ({
          promotionId: p.promotionId,
          promotionCode: p.promotionCode,
          reasonCode: 'STACKING_NOT_ALLOWED' as const,
        }));

        return {
          appliedPromotions: [chosen],
          rejectedPromotions: rejected,
          aggregateCalculation: chosen.calculation || this.zeroBreakdown(originalShippingAmount),
        };
      }

      case 'COMBINE_ALLOWED': {
        // Combine discounts up to originalShippingAmount
        let totalDiscount = 0;
        let totalPlatformSubsidy = 0;
        let totalSellerContribution = 0;
        const applied: PromotionEvaluationResult[] = [];
        const rejected: Array<{
          promotionId: string;
          promotionCode: string;
          reasonCode: 'STACKING_NOT_ALLOWED';
        }> = [];

        for (const promo of eligiblePromotions) {
          const promoDiscount = promo.calculation?.shippingPromotionDiscount ?? 0;
          if (totalDiscount + promoDiscount <= originalShippingAmount) {
            totalDiscount += promoDiscount;
            totalPlatformSubsidy += promo.calculation?.platformShippingSubsidy ?? 0;
            totalSellerContribution += promo.calculation?.sellerShippingContribution ?? 0;
            applied.push(promo);
          } else {
            // Can partially take or reject
            const remainingAllowed = originalShippingAmount - totalDiscount;
            if (remainingAllowed > 0) {
              totalDiscount += remainingAllowed;
              totalPlatformSubsidy += remainingAllowed; // Default to platform remainder
              applied.push(promo);
            } else {
              rejected.push({
                promotionId: promo.promotionId,
                promotionCode: promo.promotionCode,
                reasonCode: 'STACKING_NOT_ALLOWED',
              });
            }
          }
        }

        const customerShippingCharge = Math.max(0, originalShippingAmount - totalDiscount);
        const aggregateCalculation: ShippingFundingBreakdown = {
          originalShippingAmount,
          customerShippingCharge,
          shippingPromotionDiscount: totalDiscount,
          platformShippingSubsidy: totalPlatformSubsidy,
          sellerShippingContribution: totalSellerContribution,
          sellerDeliveryReimbursement: totalPlatformSubsidy,
          fundingType: totalPlatformSubsidy > 0 && totalSellerContribution > 0 ? 'SHARED' : totalSellerContribution > 0 ? 'SELLER' : 'PLATFORM',
          isFreeShipping: customerShippingCharge === 0,
          sellerBreakdown: applied[0]?.calculation?.sellerBreakdown || [],
        };

        ShippingFundingEngine.assertInvariants({
          originalShippingAmount,
          customerShippingCharge,
          shippingPromotionDiscount: totalDiscount,
          platformShippingSubsidy: totalPlatformSubsidy,
          sellerShippingContribution: totalSellerContribution,
        });

        return {
          appliedPromotions: applied,
          rejectedPromotions: rejected,
          aggregateCalculation,
        };
      }

      case 'BEST_SHIPPING_PROMOTION':
      default: {
        // Pick the promotion with the highest customer discount (or highest priority on tie)
        const sorted = [...eligiblePromotions].sort((a, b) => {
          const discA = a.calculation?.shippingPromotionDiscount ?? 0;
          const discB = b.calculation?.shippingPromotionDiscount ?? 0;
          if (discB !== discA) return discB - discA;
          return b.priority - a.priority;
        });

        const best = sorted[0];
        const rejected = sorted.slice(1).map((p) => ({
          promotionId: p.promotionId,
          promotionCode: p.promotionCode,
          reasonCode: 'STACKING_NOT_ALLOWED' as const,
        }));

        return {
          appliedPromotions: [best],
          rejectedPromotions: rejected,
          aggregateCalculation: best.calculation || this.zeroBreakdown(originalShippingAmount),
        };
      }
    }
  }

  private static zeroBreakdown(originalShippingAmount: number): ShippingFundingBreakdown {
    return {
      originalShippingAmount,
      customerShippingCharge: originalShippingAmount,
      shippingPromotionDiscount: 0,
      platformShippingSubsidy: 0,
      sellerShippingContribution: 0,
      sellerDeliveryReimbursement: 0,
      fundingType: 'PLATFORM',
      isFreeShipping: originalShippingAmount === 0,
      sellerBreakdown: [],
    };
  }
}
