import { VoucherErrorCode } from '../voucher.types';
import { VoucherValidationError } from './voucher-validation.service';

export interface StackingGroup {
  platformDiscountVoucher: any | null;
  sellerDiscountVouchers: Map<string, any>; // sellerId -> voucher
  freeShippingVoucher: any | null;
}

export class VoucherStackingService {
  /**
   * Evaluates a set of candidate vouchers to ensure they can legally stack together.
   * Standard rule:
   * - Max 1 Platform Discount voucher
   * - Max 1 Seller Discount voucher per unique seller
   * - Max 1 Free Shipping voucher
   * - If a voucher has isStackable = false, it cannot be combined with other discount vouchers
   */
  public static validateVoucherStack(vouchers: any[]): {
    isValid: boolean;
    stack: StackingGroup;
    rejectedVouchers: Array<{ voucher: any; reason: VoucherErrorCode }>;
  } {
    const stack: StackingGroup = {
      platformDiscountVoucher: null,
      sellerDiscountVouchers: new Map(),
      freeShippingVoucher: null,
    };

    const rejectedVouchers: Array<{ voucher: any; reason: VoucherErrorCode }> = [];

    // Sort vouchers by priority descending (higher priority evaluated first)
    const sorted = [...vouchers].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const v of sorted) {
      const isShipping = v.voucherType === 'FREE_SHIPPING';
      const isDiscount = v.voucherType === 'DISCOUNT' || v.voucherType === 'DISCOUNT_AND_FREE_SHIPPING';

      // 1. Free Shipping handling
      if (isShipping) {
        if (!stack.freeShippingVoucher) {
          stack.freeShippingVoucher = v;
        } else {
          rejectedVouchers.push({
            voucher: v,
            reason: VoucherErrorCode.VOUCHER_STACKING_NOT_ALLOWED,
          });
        }
        continue;
      }

      // 2. Discount Voucher handling
      if (isDiscount) {
        const isPlatform = v.ownerType === 'PLATFORM';
        const sellerId = v.sellerId || v.ownerId;

        if (isPlatform) {
          if (!stack.platformDiscountVoucher) {
            // If this platform voucher is not stackable, reject if another discount is already present
            if (!v.isStackable && (stack.platformDiscountVoucher || stack.sellerDiscountVouchers.size > 0)) {
              rejectedVouchers.push({
                voucher: v,
                reason: VoucherErrorCode.VOUCHER_STACKING_NOT_ALLOWED,
              });
            } else {
              stack.platformDiscountVoucher = v;
            }
          } else {
            rejectedVouchers.push({
              voucher: v,
              reason: VoucherErrorCode.VOUCHER_STACKING_NOT_ALLOWED,
            });
          }
        } else {
          // Seller voucher
          if (!stack.sellerDiscountVouchers.has(sellerId)) {
            stack.sellerDiscountVouchers.set(sellerId, v);
          } else {
            rejectedVouchers.push({
              voucher: v,
              reason: VoucherErrorCode.VOUCHER_STACKING_NOT_ALLOWED,
            });
          }
        }
      }
    }

    return {
      isValid: rejectedVouchers.length === 0,
      stack,
      rejectedVouchers,
    };
  }
}
