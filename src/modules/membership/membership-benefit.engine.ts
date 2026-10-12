import { prisma } from '../../database/prisma';
import { BenefitConfig } from './membership.types';
import { MembershipEligibilityService } from './membership-eligibility.service';

export interface MembershipEvaluationContext {
  userId: string;
  tierCode: string;
  tierLevel: number;
  status: string;
  benefits: BenefitConfig;
  coinsMultiplier: number;
  freeShippingEligible: boolean;
  minOrderForFreeShipping: number;
}

export class MembershipBenefitEngine {
  /**
   * Resolves the authoritative membership context for internal consumption by other engines
   * (e.g. Promotion Engine, Shipping Engine, Campaign Targeting, Rewards/Coins).
   */
  public static async getMembershipContext(
    userId?: string | null
  ): Promise<MembershipEvaluationContext | null> {
    if (!userId) return null;

    try {
      const summary = await MembershipEligibilityService.getCustomerSummary(userId);
      if (!summary || summary.status !== 'ACTIVE') {
        return null;
      }

      const benefits = summary.benefits || { perks: [], perksAr: [] };

      return {
        userId,
        tierCode: summary.tierCode,
        tierLevel: summary.level,
        status: summary.status,
        benefits,
        coinsMultiplier: benefits.coinsMultiplier || 1.0,
        freeShippingEligible: Boolean(benefits.freeShipping),
        minOrderForFreeShipping: benefits.minOrderForFreeShipping ?? 0,
      };
    } catch (err) {
      console.warn(`[MembershipBenefitEngine] Error fetching context for user ${userId}:`, err);
      return null;
    }
  }

  /**
   * Evaluates if customer qualifies for membership-based free shipping on a specific basket.
   */
  public static async isFreeShippingEligible(
    userId: string,
    orderSubtotal: number
  ): Promise<{ eligible: boolean; tierCode?: string; reason?: string }> {
    const ctx = await this.getMembershipContext(userId);
    if (!ctx || !ctx.freeShippingEligible) {
      return { eligible: false, reason: 'NOT_VIP_TIER' };
    }

    if (orderSubtotal < ctx.minOrderForFreeShipping) {
      return {
        eligible: false,
        tierCode: ctx.tierCode,
        reason: `MINIMUM_SPEND_NOT_MET: Required ${ctx.minOrderForFreeShipping}`,
      };
    }

    return {
      eligible: true,
      tierCode: ctx.tierCode,
    };
  }

  /**
   * Retrieves Coins bonus multiplier for purchase rewards.
   */
  public static async getCoinsMultiplier(userId: string): Promise<number> {
    const ctx = await this.getMembershipContext(userId);
    if (!ctx) return 1.0;
    return ctx.coinsMultiplier || 1.0;
  }
}
