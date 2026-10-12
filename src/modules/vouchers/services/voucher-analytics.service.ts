import { prisma } from '../../../database/prisma';

export class VoucherAnalyticsService {
  /**
   * Get marketplace-wide voucher analytics for Admin
   */
  public static async getAdminAnalytics(params?: { startDate?: Date; endDate?: Date }) {
    const where: any = {};
    if (params?.startDate || params?.endDate) {
      where.redeemedAt = {};
      if (params.startDate) where.redeemedAt.gte = params.startDate;
      if (params.endDate) where.redeemedAt.lte = params.endDate;
    }

    const [
      totalVouchers,
      activeVouchers,
      depletedVouchers,
      totalClaims,
      redemptions,
    ] = await Promise.all([
      prisma.voucher.count(),
      prisma.voucher.count({ where: { status: 'ACTIVE' } }),
      prisma.voucher.count({ where: { status: 'DEPLETED' } }),
      prisma.customerVoucher.count(),
      prisma.voucherRedemption.findMany({
        where,
        select: {
          discountAmount: true,
          fundingType: true,
          eligibleAmount: true,
          orderId: true,
          customerId: true,
        },
      }),
    ]);

    const totalRedemptionsCount = redemptions.length;
    const totalDiscountAmount = redemptions.reduce((sum, r) => sum + r.discountAmount, 0);
    const platformCost = redemptions
      .filter((r) => r.fundingType === 'PLATFORM')
      .reduce((sum, r) => sum + r.discountAmount, 0);
    const sellerCost = redemptions
      .filter((r) => r.fundingType === 'SELLER')
      .reduce((sum, r) => sum + r.discountAmount, 0);

    const uniqueOrders = new Set(redemptions.map((r) => r.orderId)).size;
    const uniqueCustomers = new Set(redemptions.map((r) => r.customerId)).size;
    const redemptionRate = totalClaims > 0 ? (totalRedemptionsCount / totalClaims) * 100 : 0;

    return {
      totalVouchers,
      activeVouchers,
      depletedVouchers,
      totalClaims,
      totalRedemptions: totalRedemptionsCount,
      redemptionRate: Math.round(redemptionRate * 10) / 10,
      totalDiscountAmount,
      platformCost,
      sellerCost,
      ordersInfluenced: uniqueOrders,
      customersReached: uniqueCustomers,
    };
  }

  /**
   * Get seller-specific voucher analytics
   */
  public static async getSellerAnalytics(sellerId: string, voucherId?: string) {
    const where: any = { sellerId };
    if (voucherId) where.voucherId = voucherId;

    const voucherWhere: any = {
      OR: [{ sellerId }, { ownerId: sellerId }],
    };
    if (voucherId) voucherWhere.id = voucherId;

    const [vouchers, redemptions] = await Promise.all([
      prisma.voucher.findMany({
        where: voucherWhere,
        include: {
          _count: {
            select: {
              customerVouchers: true,
              redemptions: true,
            },
          },
        },
      }),
      prisma.voucherRedemption.findMany({
        where,
        select: {
          discountAmount: true,
          orderId: true,
          customerId: true,
          redeemedAt: true,
        },
      }),
    ]);

    const totalClaims = vouchers.reduce((sum, v) => sum + v.claimCount, 0);
    const totalRedemptions = redemptions.length;
    const totalDiscountCost = redemptions.reduce((sum, r) => sum + r.discountAmount, 0);
    const ordersGenerated = new Set(redemptions.map((r) => r.orderId)).size;
    const uniqueCustomers = new Set(redemptions.map((r) => r.customerId)).size;
    const conversionRate = totalClaims > 0 ? (totalRedemptions / totalClaims) * 100 : 0;

    return {
      vouchersCount: vouchers.length,
      totalClaims,
      totalRedemptions,
      totalDiscountCost,
      ordersGenerated,
      uniqueCustomers,
      conversionRate: Math.round(conversionRate * 10) / 10,
      vouchersBreakdown: vouchers.map((v) => ({
        id: v.id,
        code: v.code,
        name: v.name,
        status: v.status,
        claims: v.claimCount,
        usages: v.usageCount,
        discountType: v.discountType,
        discountValue: v.discountValue,
      })),
    };
  }
}
