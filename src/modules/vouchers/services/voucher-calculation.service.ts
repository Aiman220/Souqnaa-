import {
  CartEvaluationItem,
  VoucherCalculationResult,
  SellerCartBreakdown,
  ItemDiscountAllocation,
  VoucherErrorCode,
  VOUCHER_ERROR_MESSAGES,
} from '../voucher.types';
import { VoucherValidationService } from './voucher-validation.service';
import { VoucherStackingService, StackingGroup } from './voucher-stacking.service';
import { config } from '../../../config';

export class VoucherCalculationService {
  /**
   * Main calculation engine for multi-vendor carts and vouchers
   */
  public static async calculateCartDiscounts(params: {
    customerId?: string;
    items: CartEvaluationItem[];
    shippingFee?: number;
    sellerDeliveryFees?: Record<string, number> | Array<{ sellerId: string; deliveryFee: number }>;
    vouchers: any[];
    currency?: string;
  }): Promise<VoucherCalculationResult> {
    const { customerId, items, shippingFee = 0, sellerDeliveryFees, vouchers, currency = config.marketplace.currency || 'YER' } = params;

    // Build seller delivery map if provided
    const sellerDeliveryMap = new Map<string, number>();
    if (sellerDeliveryFees) {
      if (Array.isArray(sellerDeliveryFees)) {
        for (const it of sellerDeliveryFees) {
          sellerDeliveryMap.set(it.sellerId, it.deliveryFee);
        }
      } else {
        for (const [sId, fee] of Object.entries(sellerDeliveryFees)) {
          sellerDeliveryMap.set(sId, fee);
        }
      }
    }

    // 1. Group items by seller
    const sellerMap = new Map<string, CartEvaluationItem[]>();
    let rawSubtotal = 0;

    for (const item of items) {
      // Base price is flashSaleUnitPrice if flash sale active, else unitPrice
      const effectivePrice = item.isFlashSale && item.flashSaleUnitPrice ? item.flashSaleUnitPrice : item.unitPrice;
      const itemTotal = effectivePrice * item.quantity;
      rawSubtotal += itemTotal;

      const group = sellerMap.get(item.sellerId) || [];
      group.push({ ...item, unitPrice: effectivePrice, totalPrice: itemTotal });
      sellerMap.set(item.sellerId, group);
    }

    const appliedVouchers: any[] = [];
    const rejectedVouchers: Array<{
      code: string;
      voucherId?: string;
      codeName?: string;
      reasonCode: VoucherErrorCode;
      reasonAr: string;
      reasonEn: string;
    }> = [];

    // 2. Filter through Validation Pipeline
    const validatedVouchers: any[] = [];
    for (const v of vouchers) {
      const valResult = await VoucherValidationService.validateVoucherForCart({
        voucher: v,
        customerId,
        items,
        subtotal: rawSubtotal,
        shippingFee,
      });

      if (!valResult.isValid && valResult.error) {
        const meta = VOUCHER_ERROR_MESSAGES[valResult.error.code] || {
          en: valResult.error.messageEn,
          ar: valResult.error.messageAr,
        };
        rejectedVouchers.push({
          code: v.code,
          voucherId: v.id,
          codeName: v.name,
          reasonCode: valResult.error.code,
          reasonEn: meta.en,
          reasonAr: meta.ar,
        });
      } else {
        validatedVouchers.push(v);
      }
    }

    // 3. Apply Stacking Rules
    const stackResult = VoucherStackingService.validateVoucherStack(validatedVouchers);
    for (const rej of stackResult.rejectedVouchers) {
      const meta = VOUCHER_ERROR_MESSAGES[rej.reason];
      rejectedVouchers.push({
        code: rej.voucher.code,
        voucherId: rej.voucher.id,
        codeName: rej.voucher.name,
        reasonCode: rej.reason,
        reasonEn: meta.en,
        reasonAr: meta.ar,
      });
    }

    const allocations: ItemDiscountAllocation[] = [];
    let totalSellerDiscount = 0;
    let totalPlatformDiscount = 0;
    let totalShippingDiscount = 0;
    let platformFunding = 0;
    let sellerFunding = 0;

    const sellerBreakdowns: Record<string, SellerCartBreakdown> = {};

    // 4. Calculate Seller-specific Vouchers first
    for (const [sellerId, sellerItems] of sellerMap.entries()) {
      const sellerSubtotal = sellerItems.reduce((sum, it) => sum + it.totalPrice, 0);
      let sDiscount = 0;
      const sellerVoucher = stackResult.stack.sellerDiscountVouchers.get(sellerId);

      if (sellerVoucher) {
        appliedVouchers.push(sellerVoucher);
        // Filter items matching seller voucher scope (products/categories within this seller)
        const eligibleItems = VoucherValidationService.filterEligibleItems(sellerVoucher, sellerItems);
        const eligibleSubtotal = eligibleItems.reduce((sum, it) => sum + it.totalPrice, 0);

        if (sellerVoucher.discountType === 'PERCENTAGE') {
          sDiscount = (eligibleSubtotal * sellerVoucher.discountValue) / 100;
        } else {
          // FIXED
          sDiscount = Math.min(sellerVoucher.discountValue, eligibleSubtotal);
        }

        if (sellerVoucher.maximumDiscount && sDiscount > sellerVoucher.maximumDiscount) {
          sDiscount = sellerVoucher.maximumDiscount;
        }

        sDiscount = Math.min(sDiscount, eligibleSubtotal);

        // Pro-rata allocate seller discount across eligible items
        if (eligibleSubtotal > 0 && sDiscount > 0) {
          let allocatedSum = 0;
          for (let i = 0; i < eligibleItems.length; i++) {
            const it = eligibleItems[i];
            const isLast = i === eligibleItems.length - 1;
            const itemShare = isLast
              ? sDiscount - allocatedSum
              : Math.round(((it.totalPrice / eligibleSubtotal) * sDiscount) * 100) / 100;
            allocatedSum += itemShare;

            allocations.push({
              cartItemId: it.cartItemId,
              productId: it.productId,
              sellerId,
              voucherId: sellerVoucher.id,
              discountAmount: itemShare,
              fundingType: sellerVoucher.fundingType || 'SELLER',
            });
          }
        }

        totalSellerDiscount += sDiscount;
        if (sellerVoucher.fundingType === 'SELLER') {
          sellerFunding += sDiscount;
        } else {
          platformFunding += sDiscount;
        }
      }

      sellerBreakdowns[sellerId] = {
        sellerId,
        storeId: sellerItems[0]?.storeId || '',
        items: sellerItems,
        subtotal: sellerSubtotal,
        sellerDiscount: sDiscount,
        platformDiscount: 0,
        sellerVoucher: sellerVoucher || null,
        netSubtotal: Math.max(0, sellerSubtotal - sDiscount),
      };
    }

    // 5. Calculate Platform Discount Voucher
    const platformVoucher = stackResult.stack.platformDiscountVoucher;
    if (platformVoucher) {
      appliedVouchers.push(platformVoucher);
      const eligibleItems = VoucherValidationService.filterEligibleItems(platformVoucher, items);

      // Flash sale policy: if voucher does not allow flash sale items, exclude them
      const nonFlashEligibleItems = eligibleItems.filter((it) => !it.isFlashSale);
      const targetItems = nonFlashEligibleItems.length > 0 ? nonFlashEligibleItems : eligibleItems;

      // Base subtotal for platform voucher is price remaining after seller discounts
      const remainingEligibleSubtotal = targetItems.reduce((sum, it) => {
        const itemAllocatedSellerDiscount = allocations
          .filter((a) => a.cartItemId === it.cartItemId && a.fundingType === 'SELLER')
          .reduce((acc, a) => acc + a.discountAmount, 0);
        return sum + Math.max(0, it.totalPrice - itemAllocatedSellerDiscount);
      }, 0);

      let pDiscount = 0;
      if (platformVoucher.discountType === 'PERCENTAGE') {
        pDiscount = (remainingEligibleSubtotal * platformVoucher.discountValue) / 100;
      } else {
        // FIXED
        pDiscount = Math.min(platformVoucher.discountValue, remainingEligibleSubtotal);
      }

      if (platformVoucher.maximumDiscount && pDiscount > platformVoucher.maximumDiscount) {
        pDiscount = platformVoucher.maximumDiscount;
      }

      pDiscount = Math.min(pDiscount, remainingEligibleSubtotal);

      // Allocate platform discount across target items
      if (remainingEligibleSubtotal > 0 && pDiscount > 0) {
        let allocatedSum = 0;
        for (let i = 0; i < targetItems.length; i++) {
          const it = targetItems[i];
          const isLast = i === targetItems.length - 1;
          const itemRemaining = Math.max(0, it.totalPrice);
          const itemShare = isLast
            ? pDiscount - allocatedSum
            : Math.round(((itemRemaining / remainingEligibleSubtotal) * pDiscount) * 100) / 100;
          allocatedSum += itemShare;

          allocations.push({
            cartItemId: it.cartItemId,
            productId: it.productId,
            sellerId: it.sellerId,
            voucherId: platformVoucher.id,
            discountAmount: itemShare,
            fundingType: platformVoucher.fundingType || 'PLATFORM',
          });

          // Attribute to seller breakdown
          if (sellerBreakdowns[it.sellerId]) {
            sellerBreakdowns[it.sellerId].platformDiscount += itemShare;
            sellerBreakdowns[it.sellerId].netSubtotal = Math.max(
              0,
              sellerBreakdowns[it.sellerId].netSubtotal - itemShare
            );
          }
        }
      }

      totalPlatformDiscount = pDiscount;
      if (platformVoucher.fundingType === 'PLATFORM') {
        platformFunding += pDiscount;
      } else {
        sellerFunding += pDiscount;
      }
    }

    // 6. Free Shipping Voucher Calculation
    const shippingVoucher = stackResult.stack.freeShippingVoucher;
    if (shippingVoucher && shippingFee > 0) {
      const isSellerScoped =
        (shippingVoucher.scopeType === 'SELLER' || shippingVoucher.scopeType === 'STORE') &&
        (shippingVoucher.sellerId || shippingVoucher.ownerId);
      const targetSellerId = isSellerScoped ? (shippingVoucher.sellerId || shippingVoucher.ownerId) : null;

      let eligibleShippingFee = shippingFee;
      if (targetSellerId) {
        eligibleShippingFee = sellerDeliveryMap.get(targetSellerId) ?? 0;
      }

      if (eligibleShippingFee > 0) {
        appliedVouchers.push(shippingVoucher);
        let shipDiscount = eligibleShippingFee;
        if (shippingVoucher.maximumShippingDiscount && shipDiscount > shippingVoucher.maximumShippingDiscount) {
          shipDiscount = shippingVoucher.maximumShippingDiscount;
        }
        totalShippingDiscount = Math.min(shipDiscount, eligibleShippingFee);

        const fundingType = (shippingVoucher.fundingType || (isSellerScoped ? 'SELLER' : 'PLATFORM')) as 'PLATFORM' | 'SELLER';
        if (fundingType === 'PLATFORM') {
          platformFunding += totalShippingDiscount;
        } else {
          sellerFunding += totalShippingDiscount;
        }

        // Apportion shipping discount across sellerBreakdowns
        if (targetSellerId) {
          if (sellerBreakdowns[targetSellerId]) {
            sellerBreakdowns[targetSellerId].shippingDiscount = totalShippingDiscount;
            sellerBreakdowns[targetSellerId].shippingFundingType = fundingType;
          }
        } else {
          // Platform-wide voucher: distribute pro-rata across sellers based on delivery fees
          let remainingShipDiscount = totalShippingDiscount;
          const sellerEntries = Object.entries(sellerBreakdowns);
          for (let i = 0; i < sellerEntries.length; i++) {
            const [sId, breakdown] = sellerEntries[i];
            const isLast = i === sellerEntries.length - 1;
            const sDelivery = sellerDeliveryMap.get(sId) ?? (shippingFee / sellerEntries.length);
            const ratio = shippingFee > 0 ? sDelivery / shippingFee : 1 / sellerEntries.length;
            const sShipDiscount = isLast
              ? remainingShipDiscount
              : Math.min(sDelivery, Math.round(totalShippingDiscount * ratio * 100) / 100);
            remainingShipDiscount = Math.max(0, remainingShipDiscount - sShipDiscount);

            breakdown.shippingDiscount = sShipDiscount;
            breakdown.shippingFundingType = fundingType;
          }
        }
      }
    }

    const finalShippingFee = Math.max(0, shippingFee - totalShippingDiscount);
    const totalDiscount = totalSellerDiscount + totalPlatformDiscount;
    const finalPayableTotal = Math.max(0, rawSubtotal - totalDiscount + finalShippingFee);

    return {
      currency,
      subtotal: rawSubtotal,
      rawShippingFee: shippingFee,
      shippingDiscount: totalShippingDiscount,
      finalShippingFee,
      platformDiscount: totalPlatformDiscount,
      sellerDiscount: totalSellerDiscount,
      totalDiscount,
      platformFunding,
      sellerFunding,
      finalPayableTotal,
      appliedVouchers,
      rejectedVouchers,
      allocations,
      sellerBreakdowns,
    };
  }
}
