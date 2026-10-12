import { prisma } from '../../../database/prisma';

export class VoucherFundingService {
  /**
   * Calculates net seller payout factoring in platform vs seller voucher funding and commission
   */
  public static calculateSellerPayout(params: {
    sellerSubtotal: number;
    commissionAmount: number;
    sellerFundedDiscount: number;
    platformFundedDiscount: number;
  }): {
    sellerPayout: number;
    sellerFundedDiscount: number;
    platformFundedDiscount: number;
  } {
    const {
      sellerSubtotal,
      commissionAmount,
      sellerFundedDiscount,
      platformFundedDiscount,
    } = params;

    // The seller bears their own discount.
    // The platform absorbs the platform discount, so it is reimbursed to the seller.
    const sellerPayout = Math.max(
      0,
      sellerSubtotal - sellerFundedDiscount - commissionAmount
    );

    return {
      sellerPayout,
      sellerFundedDiscount,
      platformFundedDiscount,
    };
  }

  /**
   * Handle refund calculation for item(s) that had voucher discounts applied.
   * Returns exact refundable amount to customer, and how much is reversed for seller vs platform.
   */
  public static async calculateRefundImpact(params: {
    orderItemId: string;
    quantityToRefund: number;
    totalQuantity: number;
    itemUnitPrice: number;
  }): Promise<{
    originalAmount: number;
    voucherDiscountOnItem: number;
    actualCustomerPaid: number;
    sellerFundingReversal: number;
    platformFundingReversal: number;
  }> {
    const { orderItemId, quantityToRefund, totalQuantity, itemUnitPrice } = params;

    const allocations = await prisma.voucherDiscountAllocation.findMany({
      where: { orderItemId },
    });

    const totalItemDiscount = allocations.reduce((sum, a) => sum + a.discountAmount, 0);
    const sellerFundedTotal = allocations
      .filter((a) => a.fundingType === 'SELLER')
      .reduce((sum, a) => sum + a.discountAmount, 0);
    const platformFundedTotal = allocations
      .filter((a) => a.fundingType === 'PLATFORM')
      .reduce((sum, a) => sum + a.discountAmount, 0);

    const ratio = totalQuantity > 0 ? quantityToRefund / totalQuantity : 1;

    const originalAmount = itemUnitPrice * quantityToRefund;
    const allocatedDiscountForRefund = Math.round(totalItemDiscount * ratio * 100) / 100;
    const actualCustomerPaid = Math.max(0, originalAmount - allocatedDiscountForRefund);

    const sellerFundingReversal = Math.round(sellerFundedTotal * ratio * 100) / 100;
    const platformFundingReversal = Math.round(platformFundedTotal * ratio * 100) / 100;

    return {
      originalAmount,
      voucherDiscountOnItem: allocatedDiscountForRefund,
      actualCustomerPaid,
      sellerFundingReversal,
      platformFundingReversal,
    };
  }
}
