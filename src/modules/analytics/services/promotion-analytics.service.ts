import { prisma } from '../../../database/prisma';
import { DateRange, PromotionAnalyticsItem } from '../types/analytics.types';

export class PromotionAnalyticsService {
  /**
   * Analyzes effectiveness of promotional mechanisms (Vouchers, Coupons, Flash Sales, Campaigns).
   */
  public static async getPromotionAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<PromotionAnalyticsItem[]> {
    const results: PromotionAnalyticsItem[] = [];

    // 1. Coupons & Vouchers
    const vouchers = await prisma.voucher.findMany({
      where: {
        ...(sellerId ? { sellerId } : {}),
      },
    });

    for (const v of vouchers) {
      const redemptions = await prisma.voucherRedemption.findMany({
        where: {
          voucherId: v.id,
          redeemedAt: { gte: range.startDate, lte: range.endDate },
        },
      });

      const usageCount = redemptions.length;
      const discountCost = redemptions.reduce((s, r) => s + (r.discountAmount || 0), 0);
      const revenueGenerated = redemptions.reduce((s, r) => s + (r.eligibleAmount || 0), 0);
      const aov = usageCount > 0 ? revenueGenerated / usageCount : 0;

      results.push({
        id: v.id,
        name: `${v.code} (${v.name || 'قسيمة تخفيض'})`,
        type: 'COUPON',
        status: v.status,
        usageCount,
        ordersGenerated: usageCount,
        revenueGenerated: Number(revenueGenerated.toFixed(2)),
        discountCost: Number(discountCost.toFixed(2)),
        commissionImpact: Number((discountCost * 0.1).toFixed(2)),
        aov: Number(aov.toFixed(2)),
        conversionRate: v.usageCount > 0 ? Number(((usageCount / v.usageCount) * 100).toFixed(1)) : 0,
        refundRate: 0,
        observedChangePercentage: 0,
        comparisonNote: 'مقارنة فترية لطلبات القسائم المنفذة خلال النطاق الزمني المحدد',
      });
    }

    // 2. Flash Sales
    const flashSales = await prisma.flashSale.findMany({
      where: {
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      include: {
        products: {
          select: {
            soldQuantity: true,
            productId: true,
          },
        },
      },
    });

    for (const fs of flashSales) {
      const unitsSold = fs.products.reduce((sum: number, item: any) => sum + (item.soldQuantity || 0), 0);

      results.push({
        id: fs.id,
        name: fs.titleAr || fs.titleEn || 'عرض فلاش سيل',
        type: 'FLASH_SALE',
        status: fs.isActive ? 'ACTIVE' : 'ENDED',
        usageCount: unitsSold,
        ordersGenerated: unitsSold,
        revenueGenerated: 0,
        discountCost: 0,
        commissionImpact: 0,
        aov: 0,
        conversionRate: unitsSold > 0 ? 100 : 0,
        refundRate: 0,
        observedChangePercentage: unitsSold > 0 ? 100 : 0,
        comparisonNote: `إجمالي الوحدات المحجوزة والمباعة: ${unitsSold} وحدة`,
      });
    }

    return results;
  }
}
