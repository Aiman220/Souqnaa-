/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Authoritative Funding & Financial Allocation Engine
 * Version: 2.0.0
 */

import { ShippingPromotion, ShippingFundingType } from '@prisma/client';
import {
  ShippingFundingBreakdown,
  SellerShippingFundingAllocation,
} from '../universal-shipping-promotion.types';

export class ShippingFundingEngine {
  /**
   * Calculates the exact funding breakdown enforcing all financial invariants.
   *
   * Invariants:
   * 1. originalShippingAmount === customerShippingCharge + shippingPromotionDiscount
   * 2. shippingPromotionDiscount === platformShippingSubsidy + sellerShippingContribution
   * 3. sellerDeliveryReimbursement === platformShippingSubsidy (Platform reimburses seller for the platform's subsidy)
   * 4. Zero negative amounts permitted.
   * 5. isFreeShipping is true ONLY when customerShippingCharge === 0.
   */
  public static calculateFunding(params: {
    originalShippingAmount: number;
    promotion: ShippingPromotion;
    sellerDeliveries?: Array<{ sellerId: string; deliveryFee: number }>;
  }): ShippingFundingBreakdown {
    const rawShipping = Math.max(0, this.round(params.originalShippingAmount));
    if (rawShipping === 0) {
      return this.zeroBreakdown(params.promotion.fundingType);
    }

    const { promotion, sellerDeliveries } = params;

    // 1. Calculate Gross Discount
    let targetDiscount = 0;
    if (promotion.percentageDiscount !== null && promotion.percentageDiscount !== undefined) {
      const pct = Math.max(0, Math.min(100, promotion.percentageDiscount));
      targetDiscount = (rawShipping * pct) / 100;
    } else if (promotion.fixedDiscount !== null && promotion.fixedDiscount !== undefined) {
      targetDiscount = Math.max(0, promotion.fixedDiscount);
    } else {
      // Default: 100% full shipping discount
      targetDiscount = rawShipping;
    }

    // 2. Cap by maximumDiscountAmount if configured
    if (promotion.maximumDiscountAmount !== null && promotion.maximumDiscountAmount !== undefined) {
      targetDiscount = Math.min(targetDiscount, Math.max(0, promotion.maximumDiscountAmount));
    }

    // 3. Absolute cap: discount cannot exceed original shipping
    const shippingPromotionDiscount = this.round(Math.min(rawShipping, Math.max(0, targetDiscount)));
    const customerShippingCharge = this.round(Math.max(0, rawShipping - shippingPromotionDiscount));

    // 4. Funding Breakdown based on FundingType
    let platformShippingSubsidy = 0;
    let sellerShippingContribution = 0;
    let sellerDeliveryReimbursement = 0;

    switch (promotion.fundingType) {
      case 'PLATFORM': {
        platformShippingSubsidy = shippingPromotionDiscount;
        sellerShippingContribution = 0;
        sellerDeliveryReimbursement = platformShippingSubsidy;
        break;
      }

      case 'SELLER': {
        platformShippingSubsidy = 0;
        sellerShippingContribution = shippingPromotionDiscount;
        sellerDeliveryReimbursement = 0;
        break;
      }

      case 'SHARED': {
        const platformRate = promotion.platformSubsidyRate ?? 70.0;
        const sellerRate = promotion.sellerContributionRate ?? 30.0;
        const totalRate = platformRate + sellerRate;
        const normalizedPlatformFraction = totalRate > 0 ? platformRate / totalRate : 0.7;

        let rawPlatformSubsidy = this.round(shippingPromotionDiscount * normalizedPlatformFraction);

        // Check subsidy limits
        if (promotion.platformSubsidyLimit !== null && promotion.platformSubsidyLimit !== undefined) {
          rawPlatformSubsidy = Math.min(rawPlatformSubsidy, promotion.platformSubsidyLimit);
        }

        let rawSellerContribution = this.round(shippingPromotionDiscount - rawPlatformSubsidy);
        if (
          promotion.sellerContributionLimit !== null &&
          promotion.sellerContributionLimit !== undefined
        ) {
          rawSellerContribution = Math.min(rawSellerContribution, promotion.sellerContributionLimit);
        }

        // Enforce sum invariant exactly
        platformShippingSubsidy = rawPlatformSubsidy;
        sellerShippingContribution = this.round(shippingPromotionDiscount - platformShippingSubsidy);
        sellerDeliveryReimbursement = platformShippingSubsidy;
        break;
      }
    }

    // 5. Multi-Seller Proportional Allocation
    const sellerBreakdown = this.allocateAcrossSellers({
      originalShippingAmount: rawShipping,
      shippingPromotionDiscount,
      platformShippingSubsidy,
      sellerShippingContribution,
      sellerDeliveries: sellerDeliveries || [],
      fundingType: promotion.fundingType,
    });

    const isFreeShipping = customerShippingCharge === 0;

    // 6. Final Invariant Validation
    this.assertInvariants({
      originalShippingAmount: rawShipping,
      customerShippingCharge,
      shippingPromotionDiscount,
      platformShippingSubsidy,
      sellerShippingContribution,
    });

    return {
      originalShippingAmount: rawShipping,
      customerShippingCharge,
      shippingPromotionDiscount,
      platformShippingSubsidy,
      sellerShippingContribution,
      sellerDeliveryReimbursement,
      fundingType: promotion.fundingType,
      isFreeShipping,
      sellerBreakdown,
    };
  }

  /**
   * Allocates discounts and funding deterministically across seller sub-orders.
   */
  private static allocateAcrossSellers(params: {
    originalShippingAmount: number;
    shippingPromotionDiscount: number;
    platformShippingSubsidy: number;
    sellerShippingContribution: number;
    sellerDeliveries: Array<{ sellerId: string; deliveryFee: number }>;
    fundingType: ShippingFundingType;
  }): SellerShippingFundingAllocation[] {
    const {
      originalShippingAmount,
      shippingPromotionDiscount,
      platformShippingSubsidy,
      sellerShippingContribution,
      sellerDeliveries,
    } = params;

    if (!sellerDeliveries || sellerDeliveries.length === 0) {
      return [];
    }

    const allocations: SellerShippingFundingAllocation[] = [];
    let remainingDiscount = shippingPromotionDiscount;
    let remainingSubsidy = platformShippingSubsidy;
    let remainingContribution = sellerShippingContribution;

    for (let i = 0; i < sellerDeliveries.length; i++) {
      const item = sellerDeliveries[i];
      const isLast = i === sellerDeliveries.length - 1;
      const originalFee = Math.max(0, this.round(item.deliveryFee));

      if (originalShippingAmount === 0 || originalFee === 0) {
        allocations.push({
          sellerId: item.sellerId,
          originalDeliveryFee: originalFee,
          shippingPromotionDiscount: 0,
          customerDeliveryCharge: originalFee,
          platformShippingSubsidy: 0,
          sellerShippingContribution: 0,
          sellerDeliveryReimbursement: 0,
        });
        continue;
      }

      // Proportional ratio of this seller to total shipping fee
      const ratio = originalFee / originalShippingAmount;

      const itemDiscount = isLast
        ? remainingDiscount
        : Math.min(originalFee, this.round(shippingPromotionDiscount * ratio));

      const itemSubsidy = isLast
        ? remainingSubsidy
        : this.round(platformShippingSubsidy * ratio);

      const itemContribution = isLast
        ? remainingContribution
        : this.round(sellerShippingContribution * ratio);

      const customerPaid = this.round(originalFee - itemDiscount);

      allocations.push({
        sellerId: item.sellerId,
        originalDeliveryFee: originalFee,
        shippingPromotionDiscount: itemDiscount,
        customerDeliveryCharge: Math.max(0, customerPaid),
        platformShippingSubsidy: itemSubsidy,
        sellerShippingContribution: itemContribution,
        sellerDeliveryReimbursement: itemSubsidy,
      });

      remainingDiscount = this.round(remainingDiscount - itemDiscount);
      remainingSubsidy = this.round(remainingSubsidy - itemSubsidy);
      remainingContribution = this.round(remainingContribution - itemContribution);
    }

    return allocations;
  }

  /**
   * Strictly enforces financial invariants at runtime.
   */
  public static assertInvariants(values: {
    originalShippingAmount: number;
    customerShippingCharge: number;
    shippingPromotionDiscount: number;
    platformShippingSubsidy: number;
    sellerShippingContribution: number;
  }): void {
    const {
      originalShippingAmount,
      customerShippingCharge,
      shippingPromotionDiscount,
      platformShippingSubsidy,
      sellerShippingContribution,
    } = values;

    if (
      originalShippingAmount < 0 ||
      customerShippingCharge < 0 ||
      shippingPromotionDiscount < 0 ||
      platformShippingSubsidy < 0 ||
      sellerShippingContribution < 0
    ) {
      throw new Error('Financial Invariant Violation: Negative shipping amount detected.');
    }

    const shippingSum = this.round(customerShippingCharge + shippingPromotionDiscount);
    if (Math.abs(originalShippingAmount - shippingSum) > 0.01) {
      throw new Error(
        `Financial Invariant Violation: originalShippingAmount (${originalShippingAmount}) != customerShippingCharge (${customerShippingCharge}) + shippingPromotionDiscount (${shippingPromotionDiscount})`
      );
    }

    const fundingSum = this.round(platformShippingSubsidy + sellerShippingContribution);
    if (Math.abs(shippingPromotionDiscount - fundingSum) > 0.01) {
      throw new Error(
        `Financial Invariant Violation: shippingPromotionDiscount (${shippingPromotionDiscount}) != platformShippingSubsidy (${platformShippingSubsidy}) + sellerShippingContribution (${sellerShippingContribution})`
      );
    }
  }

  private static zeroBreakdown(fundingType: ShippingFundingType): ShippingFundingBreakdown {
    return {
      originalShippingAmount: 0,
      customerShippingCharge: 0,
      shippingPromotionDiscount: 0,
      platformShippingSubsidy: 0,
      sellerShippingContribution: 0,
      sellerDeliveryReimbursement: 0,
      fundingType,
      isFreeShipping: true,
      sellerBreakdown: [],
    };
  }

  private static round(val: number): number {
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }
}
