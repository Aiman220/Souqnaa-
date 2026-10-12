/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Financial Calculation Engine
 * Version: 1.0.0
 */

import { ShippingPromotionCostBearer } from '@prisma/client';
import {
  FirstOrderShippingCalculation,
  MultiSellerShippingAllocation,
  FirstOrderShippingConfigDto,
} from '../first-order-shipping.types';
import { TaxMath } from '../../tax/tax.math';

export class FirstOrderShippingCalculationService {
  /**
   * Calculates the authoritative shipping promotion discount, customer charge,
   * platform subsidy, seller contribution, and seller delivery reimbursement.
   *
   * Invariants enforced:
   * 1. originalShippingAmount = customerShippingCharge + shippingPromotionDiscount
   * 2. platformShippingSubsidy + sellerShippingContribution = shippingPromotionDiscount
   * 3. For PLATFORM: platformShippingSubsidy = shippingPromotionDiscount, sellerDeliveryReimbursement = platformShippingSubsidy
   * 4. For SELLER: sellerShippingContribution = shippingPromotionDiscount, sellerDeliveryReimbursement = 0
   * 5. customerShippingCharge >= 0, platformShippingSubsidy >= 0, sellerShippingContribution >= 0, sellerDeliveryReimbursement >= 0
   */
  public static calculateShippingPromotion(params: {
    originalShippingAmount: number;
    config: FirstOrderShippingConfigDto;
    sellerQuotes?: Array<{ sellerId: string; deliveryFee: number }>;
  }): FirstOrderShippingCalculation {
    const originalShippingAmount = Math.max(0, TaxMath.round(params.originalShippingAmount));
    const config = params.config;

    if (originalShippingAmount <= 0) {
      return {
        originalShippingAmount: 0,
        shippingPromotionDiscount: 0,
        customerShippingCharge: 0,
        platformShippingSubsidy: 0,
        sellerShippingContribution: 0,
        sellerDeliveryReimbursement: 0,
        costBearer: config.costBearer,
        isFullyFree: true,
        sellerBreakdown: [],
      };
    }

    // 1. Calculate Discount Capped by maxDiscount
    let rawDiscount = originalShippingAmount;
    if (config.maxDiscount !== null && config.maxDiscount !== undefined && config.maxDiscount >= 0) {
      rawDiscount = Math.min(originalShippingAmount, config.maxDiscount);
    }
    const shippingPromotionDiscount = TaxMath.round(rawDiscount);

    // 2. Customer shipping charge is whatever remainder is left
    const customerShippingCharge = TaxMath.round(
      Math.max(0, TaxMath.subtract(originalShippingAmount, shippingPromotionDiscount))
    );

    // 3. Determine Cost Bearer Distribution
    let platformShippingSubsidy = 0;
    let sellerShippingContribution = 0;
    let sellerDeliveryReimbursement = 0;

    switch (config.costBearer) {
      case ShippingPromotionCostBearer.SELLER: {
        platformShippingSubsidy = 0;
        sellerShippingContribution = shippingPromotionDiscount;
        sellerDeliveryReimbursement = 0; // Seller absorbs cost, no platform reimbursement
        break;
      }
      case ShippingPromotionCostBearer.SHARED: {
        const platformSharePct = Math.min(100, Math.max(0, config.sharedPlatformPercentage || 70.0));
        platformShippingSubsidy = TaxMath.round((shippingPromotionDiscount * platformSharePct) / 100);
        sellerShippingContribution = TaxMath.round(
          TaxMath.subtract(shippingPromotionDiscount, platformShippingSubsidy)
        );
        sellerDeliveryReimbursement = platformShippingSubsidy;
        break;
      }
      case ShippingPromotionCostBearer.PLATFORM:
      default: {
        platformShippingSubsidy = shippingPromotionDiscount;
        sellerShippingContribution = 0;
        sellerDeliveryReimbursement = platformShippingSubsidy; // SOUQNA reimburses the seller
        break;
      }
    }

    // Apply platform subsidy limit if configured
    if (config.platformSubsidyLimit !== null && config.platformSubsidyLimit !== undefined) {
      if (platformShippingSubsidy > config.platformSubsidyLimit) {
        const excess = TaxMath.subtract(platformShippingSubsidy, config.platformSubsidyLimit);
        platformShippingSubsidy = config.platformSubsidyLimit;
        // Shift excess to seller contribution if shared or seller-funded, otherwise customer pays
        sellerShippingContribution = TaxMath.add(sellerShippingContribution, excess);
        sellerDeliveryReimbursement = platformShippingSubsidy;
      }
    }

    // 4. Multi-Seller Proportional Breakdown
    const sellerQuotes = params.sellerQuotes || [];
    const sellerBreakdown: MultiSellerShippingAllocation[] = [];

    if (sellerQuotes.length > 0 && originalShippingAmount > 0) {
      let allocatedDiscountSum = 0;
      let allocatedSubsidySum = 0;
      let allocatedContributionSum = 0;
      let allocatedCustomerChargeSum = 0;

      sellerQuotes.forEach((sq, idx) => {
        const isLast = idx === sellerQuotes.length - 1;
        const sellerFee = Math.max(0, TaxMath.round(sq.deliveryFee));
        const ratio = sellerFee / originalShippingAmount;

        let sellerDiscount = isLast
          ? TaxMath.round(TaxMath.subtract(shippingPromotionDiscount, allocatedDiscountSum))
          : TaxMath.round(shippingPromotionDiscount * ratio);
        sellerDiscount = Math.min(sellerFee, Math.max(0, sellerDiscount));
        allocatedDiscountSum = TaxMath.add(allocatedDiscountSum, sellerDiscount);

        let sellerCustomerCharge = isLast
          ? TaxMath.round(TaxMath.subtract(customerShippingCharge, allocatedCustomerChargeSum))
          : TaxMath.round(customerShippingCharge * ratio);
        sellerCustomerCharge = Math.max(0, TaxMath.subtract(sellerFee, sellerDiscount));
        allocatedCustomerChargeSum = TaxMath.add(allocatedCustomerChargeSum, sellerCustomerCharge);

        let sellerSubsidy = isLast
          ? TaxMath.round(TaxMath.subtract(platformShippingSubsidy, allocatedSubsidySum))
          : TaxMath.round(platformShippingSubsidy * ratio);
        sellerSubsidy = Math.min(sellerDiscount, Math.max(0, sellerSubsidy));
        allocatedSubsidySum = TaxMath.add(allocatedSubsidySum, sellerSubsidy);

        let sellerContribution = isLast
          ? TaxMath.round(TaxMath.subtract(sellerShippingContribution, allocatedContributionSum))
          : TaxMath.round(sellerShippingContribution * ratio);
        sellerContribution = Math.max(0, TaxMath.subtract(sellerDiscount, sellerSubsidy));
        allocatedContributionSum = TaxMath.add(allocatedContributionSum, sellerContribution);

        const sellerReimbursement = sellerSubsidy;

        sellerBreakdown.push({
          sellerId: sq.sellerId,
          originalDeliveryFee: sellerFee,
          shippingPromotionDiscount: sellerDiscount,
          customerDeliveryCharge: sellerCustomerCharge,
          platformShippingSubsidy: sellerSubsidy,
          sellerShippingContribution: sellerContribution,
          sellerDeliveryReimbursement: sellerReimbursement,
        });
      });
    }

    const isFullyFree = customerShippingCharge === 0;

    return {
      originalShippingAmount,
      shippingPromotionDiscount,
      customerShippingCharge,
      platformShippingSubsidy,
      sellerShippingContribution,
      sellerDeliveryReimbursement,
      costBearer: config.costBearer,
      isFullyFree,
      sellerBreakdown,
    };
  }
}
