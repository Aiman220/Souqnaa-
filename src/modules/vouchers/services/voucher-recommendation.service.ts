import { prisma } from '../../../database/prisma';
import { CartEvaluationItem, VoucherCalculationResult } from '../voucher.types';
import { VoucherCalculationService } from './voucher-calculation.service';
import { VoucherValidationService } from './voucher-validation.service';

export interface RecommendedVoucherOption {
  combinationName: string;
  vouchers: any[];
  totalSavings: number;
  discountAmount: number;
  shippingDiscountAmount: number;
  isBest: boolean;
  summaryAr: string;
  summaryEn: string;
}

export class VoucherRecommendationService {
  /**
   * Finds all candidate vouchers (claimed by customer + auto-apply + available public)
   * and computes the optimal combination that yields the highest monetary savings.
   */
  public static async recommendBestVouchers(params: {
    customerId?: string;
    items: CartEvaluationItem[];
    shippingFee?: number;
    currency?: string;
  }): Promise<{
    bestCombination: RecommendedVoucherOption | null;
    alternatives: RecommendedVoucherOption[];
    bestCalculation: VoucherCalculationResult | null;
  }> {
    const { customerId, items, shippingFee = 0, currency = 'SAR' } = params;
    const now = new Date();

    // 1. Fetch available active candidate vouchers
    const activeVouchers = await prisma.voucher.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gt: now },
      },
      include: {
        products: true,
        categories: true,
      },
    });

    // 2. Fetch customer's claimed vouchers if logged in
    let claimedVoucherIds = new Set<string>();
    if (customerId) {
      const customerVouchers = await prisma.customerVoucher.findMany({
        where: {
          customerId,
          status: 'CLAIMED',
        },
        select: { voucherId: true },
      });
      claimedVoucherIds = new Set(customerVouchers.map((cv) => cv.voucherId));
    }

    // A candidate voucher must be either auto-apply, or claimed by customer, or code/public
    const candidates = activeVouchers.filter((v) => {
      if (v.isAutoApply) return true;
      if (claimedVoucherIds.has(v.id)) return true;
      if (!v.isClaimable) return true;
      return false;
    });

    if (candidates.length === 0) {
      return {
        bestCombination: null,
        alternatives: [],
        bestCalculation: null,
      };
    }

    // 3. Separate candidate vouchers by category
    const platformDiscountCandidates = candidates.filter(
      (v) => v.ownerType === 'PLATFORM' && (v.voucherType === 'DISCOUNT' || v.voucherType === 'DISCOUNT_AND_FREE_SHIPPING')
    );
    const sellerDiscountCandidates = candidates.filter(
      (v) => v.ownerType === 'SELLER' && (v.voucherType === 'DISCOUNT' || v.voucherType === 'DISCOUNT_AND_FREE_SHIPPING')
    );
    const shippingCandidates = candidates.filter((v) => v.voucherType === 'FREE_SHIPPING');

    // Group seller candidates by seller
    const sellerCandidatesMap = new Map<string, any[]>();
    for (const sv of sellerDiscountCandidates) {
      const sId = (sv.sellerId || sv.ownerId) as string;
      if (!sId) continue;
      const list = sellerCandidatesMap.get(sId) || [];
      list.push(sv);
      sellerCandidatesMap.set(sId, list);
    }

    // 4. Generate candidate combinations
    const combinations: any[][] = [];

    // Base option: empty
    combinations.push([]);

    // Single vouchers
    for (const v of candidates) {
      combinations.push([v]);
    }

    // Stacked combinations: (1 Platform) + (1 Seller per seller) + (1 Shipping)
    const bestShipping = shippingCandidates.length > 0 ? [shippingCandidates[0]] : [];

    for (const pv of platformDiscountCandidates.slice(0, 5)) {
      // Platform only
      combinations.push([pv]);

      // Platform + Shipping
      if (bestShipping.length > 0) {
        combinations.push([pv, ...bestShipping]);
      }

      // Platform + Seller Vouchers
      const combinedWithSellers = [pv];
      for (const [_, sVouchers] of sellerCandidatesMap.entries()) {
        if (sVouchers.length > 0) {
          combinedWithSellers.push(sVouchers[0]);
        }
      }
      combinations.push(combinedWithSellers);

      // Platform + Sellers + Shipping
      if (bestShipping.length > 0) {
        combinations.push([...combinedWithSellers, ...bestShipping]);
      }
    }

    // Evaluate all combinations through calculation engine
    const evaluatedResults: Array<{
      combination: any[];
      calc: VoucherCalculationResult;
      totalSavings: number;
    }> = [];

    for (const combo of combinations) {
      if (combo.length === 0) continue;
      const calc = await VoucherCalculationService.calculateCartDiscounts({
        customerId,
        items,
        shippingFee,
        vouchers: combo,
        currency,
      });

      const totalSavings = calc.totalDiscount + calc.shippingDiscount;
      if (totalSavings > 0 && calc.appliedVouchers.length > 0) {
        evaluatedResults.push({
          combination: calc.appliedVouchers,
          calc,
          totalSavings,
        });
      }
    }

    // Sort by total monetary savings descending
    evaluatedResults.sort((a, b) => b.totalSavings - a.totalSavings);

    if (evaluatedResults.length === 0) {
      return {
        bestCombination: null,
        alternatives: [],
        bestCalculation: null,
      };
    }

    const best = evaluatedResults[0];

    // Filter alternatives with distinct voucher combinations
    const seenCombos = new Set<string>();
    seenCombos.add(best.combination.map((v) => v.id).sort().join(','));

    const alternatives: RecommendedVoucherOption[] = [];
    for (let i = 1; i < evaluatedResults.length; i++) {
      const alt = evaluatedResults[i];
      const key = alt.combination.map((v) => v.id).sort().join(',');
      if (!seenCombos.has(key)) {
        seenCombos.add(key);
        alternatives.push({
          combinationName: alt.combination.map((v) => v.name).join(' + '),
          vouchers: alt.combination,
          totalSavings: alt.totalSavings,
          discountAmount: alt.calc.totalDiscount,
          shippingDiscountAmount: alt.calc.shippingDiscount,
          isBest: false,
          summaryAr: `وفر ${alt.totalSavings.toFixed(2)} ${currency}`,
          summaryEn: `Save ${alt.totalSavings.toFixed(2)} ${currency}`,
        });
        if (alternatives.length >= 3) break;
      }
    }

    const bestOption: RecommendedVoucherOption = {
      combinationName: best.combination.map((v) => v.name).join(' + '),
      vouchers: best.combination,
      totalSavings: best.totalSavings,
      discountAmount: best.calc.totalDiscount,
      shippingDiscountAmount: best.calc.shippingDiscount,
      isBest: true,
      summaryAr: `أفضل خيار — وفر ${best.totalSavings.toFixed(2)} ${currency}`,
      summaryEn: `Best Option — Save ${best.totalSavings.toFixed(2)} ${currency}`,
    };

    return {
      bestCombination: bestOption,
      alternatives,
      bestCalculation: best.calc,
    };
  }
}
