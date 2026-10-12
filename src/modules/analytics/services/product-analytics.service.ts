import { prisma } from '../../../database/prisma';
import { DateRange, ProductPerformanceScorecard } from '../types/analytics.types';

export class ProductAnalyticsService {
  /**
   * Returns top products ranked by a configurable metric with full analytical scorecard.
   */
  public static async getTopProducts(
    range: DateRange,
    sellerId?: string,
    sortBy: 'revenue' | 'units' | 'orders' | 'views' | 'conversion' | 'rating' = 'revenue',
    limit: number = 20
  ): Promise<ProductPerformanceScorecard[]> {
    const whereOrder: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      whereOrder.sellerId = sellerId;
    }

    const durationDays = Math.max(1, (range.endDate.getTime() - range.startDate.getTime()) / (1000 * 3600 * 24));

    // Aggregate order items
    const orderItems = await prisma.orderItem.findMany({
      where: {
        sellerOrder: whereOrder,
      },
      select: {
        productId: true,
        quantity: true,
        totalPrice: true,
        sellerOrderId: true,
        product: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            sku: true,
            inventory: { select: { quantity: true } },
            rating: true,
            reviewCount: true,
            soldCount: true,
            category: { select: { nameAr: true } },
          },
        },
      },
    });

    // Refunds by product
    const refundRecords = await prisma.refundRequestItem.findMany({
      where: {
        refundRequest: {
          status: 'REFUNDED' as any,
          resolvedAt: { gte: range.startDate, lte: range.endDate },
          ...(sellerId ? { sellerId } : {}),
        },
      },
      select: { productId: true, quantity: true },
    });

    const refundCountMap = new Map<string, number>();
    for (const r of refundRecords) {
      if (r.productId) {
        refundCountMap.set(r.productId, (refundCountMap.get(r.productId) || 0) + (r.quantity || 1));
      }
    }

    // Cart and Wishlist tracking
    const [wishlistAgg, cartAgg] = await Promise.all([
      prisma.wishlistItem.groupBy({
        by: ['productId'],
        _count: { id: true },
      }),
      prisma.cartItem.groupBy({
        by: ['productId'],
        _count: { id: true },
      }),
    ]);

    const wishlistMap = new Map<string, number>();
    for (const w of wishlistAgg) wishlistMap.set(w.productId, w._count.id);

    const cartMap = new Map<string, number>();
    for (const c of cartAgg) cartMap.set(c.productId, c._count.id);

    // Group items by productId
    const productStats = new Map<string, {
      product: any;
      unitsSold: number;
      grossRevenue: number;
      orderIds: Set<string>;
    }>();

    let totalRevenueSum = 0;
    let totalOrdersSum = 0;

    for (const item of (orderItems as any[])) {
      if (!item.productId || !item.product) continue;
      const pid = item.productId;
      const cur = productStats.get(pid) || {
        product: item.product,
        unitsSold: 0,
        grossRevenue: 0,
        orderIds: new Set<string>(),
      };

      cur.unitsSold += item.quantity || 0;
      cur.grossRevenue += item.totalPrice || 0;
      if (item.sellerOrderId) cur.orderIds.add(item.sellerOrderId);

      totalRevenueSum += item.totalPrice || 0;
      totalOrdersSum += 1;

      productStats.set(pid, cur);
    }

    const scorecards: ProductPerformanceScorecard[] = [];

    for (const [pid, stats] of productStats.entries()) {
      const p = stats.product;
      const units = stats.unitsSold;
      const revenue = stats.grossRevenue;
      const ordersCount = stats.orderIds.size;
      const aov = ordersCount > 0 ? revenue / ordersCount : 0;
      const currentStock = p.inventory?.quantity || 0;
      const views = (p.soldCount || 0) * 3;
      const wishlistAdds = wishlistMap.get(pid) || 0;
      const cartAdds = cartMap.get(pid) || 0;
      const refunds = refundCountMap.get(pid) || 0;

      const salesVelocity = Number((units / durationDays).toFixed(2));
      const revenueContributionRate = totalRevenueSum > 0 ? Number(((revenue / totalRevenueSum) * 100).toFixed(2)) : 0;
      const orderContributionRate = totalOrdersSum > 0 ? Number(((ordersCount / totalOrdersSum) * 100).toFixed(2)) : 0;
      const conversionRate = views > 0 ? Number(((ordersCount / views) * 100).toFixed(2)) : 0;
      const refundRate = ordersCount > 0 ? Number(((refunds / ordersCount) * 100).toFixed(2)) : 0;
      const stockVelocity = salesVelocity > 0 ? Number((currentStock / salesVelocity).toFixed(1)) : 999;

      const notes: string[] = [];
      if (revenueContributionRate >= 20) {
        notes.push(`يساهم بنسبة استثنائية (${revenueContributionRate}%) من إجمالي مبيعات المتجر.`);
      }
      if (stockVelocity <= 7 && currentStock > 0) {
        notes.push(`تنبيه نفاد: المخزون الحالي يكفي فقط لحوالي ${stockVelocity} أيام بالنظر لمعدل البيع اليومي.`);
      }
      if (currentStock === 0) {
        notes.push('المنتج نفد بالكامل من المخزون مع وجود طلب مستمر.');
      }
      if (refundRate > 10) {
        notes.push(`معدل الاسترجاع مرتفع (${refundRate}%)، يرجى مراجعة الجودة ومطابقة الوصف.`);
      }
      if (views > 50 && conversionRate < 1.0) {
        notes.push(`مشاهدات مرتفعة (${views}) مع معدل تحويل منخفض (${conversionRate}%)، قد يحتاج السعر لمراجعة تنافسية.`);
      }

      scorecards.push({
        productId: pid,
        productName: p.nameEn || p.nameAr || 'Product',
        productNameAr: p.nameAr || p.nameEn || 'منتج',
        sku: p.sku || undefined,
        categoryNameAr: p.category?.nameAr,
        currentStock,
        unitsSold: units,
        grossRevenue: Number(revenue.toFixed(2)),
        ordersCount,
        aov: Number(aov.toFixed(2)),
        viewsCount: views,
        wishlistAdds,
        cartAdds,
        salesVelocity,
        revenueContributionRate,
        orderContributionRate,
        conversionRate,
        refundRate,
        stockVelocity,
        customerRating: Number((p.rating || 0).toFixed(1)),
        reviewCount: p.reviewCount || 0,
        scorecardNotes: notes,
      });
    }

    // Sort by requested metric
    scorecards.sort((a, b) => {
      switch (sortBy) {
        case 'units':
          return b.unitsSold - a.unitsSold;
        case 'orders':
          return b.ordersCount - a.ordersCount;
        case 'views':
          return b.viewsCount - a.viewsCount;
        case 'conversion':
          return b.conversionRate - a.conversionRate;
        case 'rating':
          return b.customerRating - a.customerRating;
        case 'revenue':
        default:
          return b.grossRevenue - a.grossRevenue;
      }
    });

    return scorecards.slice(0, limit);
  }

  /**
   * Returns complete scorecards for all products in range.
   */
  public static async getProductScorecards(
    range: DateRange,
    sellerId?: string,
    limit: number = 30
  ): Promise<ProductPerformanceScorecard[]> {
    return this.getTopProducts(range, sellerId, 'revenue', limit);
  }
}
