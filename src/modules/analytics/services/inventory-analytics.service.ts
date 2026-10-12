import { prisma } from '../../../database/prisma';
import { DateRange, InventoryHealthItem } from '../types/analytics.types';

export interface InventoryAnalyticsOverview {
  totalProducts: number;
  activeProducts: number;
  outOfStockCount: number;
  lowStockCount: number;
  fastMovingCount: number;
  slowMovingCount: number;
  deadStockCount: number;
  items: InventoryHealthItem[];
  warningsSummary: {
    warningType: string;
    count: number;
    messageAr: string;
  }[];
}

export class InventoryAnalyticsService {
  /**
   * Generates actionable inventory health diagnostics and velocity analysis.
   */
  public static async getInventoryAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<InventoryAnalyticsOverview> {
    const durationDays = Math.max(1, (range.endDate.getTime() - range.startDate.getTime()) / (1000 * 3600 * 24));

    // Find products for seller or all
    let whereProduct: any = {};
    if (sellerId) {
      whereProduct = {
        store: { sellerId },
      };
    }

    const products = await prisma.product.findMany({
      where: whereProduct,
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        inventory: {
          select: {
            quantity: true,
            lowStockAlert: true,
            updatedAt: true,
          },
        },
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const productIds = products.map((p) => p.id);

    // Get order items in the period to calculate velocity
    const salesInPeriod = await prisma.orderItem.findMany({
      where: {
        productId: { in: productIds },
        sellerOrder: {
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
      },
      select: {
        productId: true,
        quantity: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Compute sales and last sale date per product
    const salesMap = new Map<string, { units: number; lastSaleDate: Date | null }>();
    for (const sale of salesInPeriod) {
      const cur = salesMap.get(sale.productId) || { units: 0, lastSaleDate: sale.createdAt };
      cur.units += sale.quantity || 0;
      if (!cur.lastSaleDate || sale.createdAt > cur.lastSaleDate) {
        cur.lastSaleDate = sale.createdAt;
      }
      salesMap.set(sale.productId, cur);
    }

    const items: InventoryHealthItem[] = [];
    let outOfStockCount = 0;
    let lowStockCount = 0;
    let fastMovingCount = 0;
    let slowMovingCount = 0;
    let deadStockCount = 0;

    for (const p of (products as any[])) {
      const currentStock = p.inventory?.quantity || 0;
      const lowThreshold = p.inventory?.lowStockAlert || 5;
      const sales = salesMap.get(p.id) || { units: 0, lastSaleDate: null };
      const unitsSold = sales.units;
      const avgDailySales = Number((unitsSold / durationDays).toFixed(2));
      const estDaysRemaining = avgDailySales > 0 ? Number((currentStock / avgDailySales).toFixed(1)) : (currentStock > 0 ? 999 : 0);
      const stockTurnover = currentStock > 0 ? Number((unitsSold / currentStock).toFixed(2)) : (unitsSold > 0 ? 10 : 0);

      const warnings: string[] = [];
      let status: InventoryHealthItem['status'] = 'IN_STOCK';

      if (currentStock === 0) {
        outOfStockCount++;
        status = 'OUT_OF_STOCK';
        warnings.push('OUT_OF_STOCK');
      } else if (currentStock <= lowThreshold) {
        lowStockCount++;
        status = 'LOW_STOCK';
        warnings.push('LOW_STOCK');
      }

      if (avgDailySales >= 2.0 || estDaysRemaining <= 7 && currentStock > 0) {
        fastMovingCount++;
        if (status === 'IN_STOCK') status = 'FAST_MOVING';
        warnings.push('FAST_MOVING');
      } else if (unitsSold === 0 && currentStock > 0) {
        deadStockCount++;
        if (status === 'IN_STOCK') status = 'DEAD_STOCK';
        warnings.push('NO_RECENT_SALES');
      } else if (avgDailySales < 0.2 && currentStock > 20) {
        slowMovingCount++;
        if (status === 'IN_STOCK') status = 'SLOW_MOVING';
        warnings.push('SLOW_MOVING');
      }

      items.push({
        productId: p.id,
        productNameAr: p.nameAr || p.nameEn || 'منتج',
        productNameEn: p.nameEn || p.nameAr || 'Product',
        currentStock,
        unitsSold,
        averageDailySales: avgDailySales,
        estimatedDaysRemaining: estDaysRemaining,
        stockTurnover,
        status,
        lastSaleDate: sales.lastSaleDate,
        lastRestockDate: p.updatedAt,
        warnings,
      });
    }

    const warningsSummary = [
      {
        warningType: 'OUT_OF_STOCK',
        count: outOfStockCount,
        messageAr: `${outOfStockCount} منتجات نفدت كميتها تماماً وتحتاج إلى إعادة توريد فورية.`,
      },
      {
        warningType: 'LOW_STOCK',
        count: lowStockCount,
        messageAr: `${lowStockCount} منتجات قاربت على النفاد ووصلت لحد الأمان الأدنى.`,
      },
      {
        warningType: 'FAST_MOVING',
        count: fastMovingCount,
        messageAr: `${fastMovingCount} منتجات ذات حركة بيع نشطة وسريعة قد تنفد قريباً.`,
      },
      {
        warningType: 'NO_RECENT_SALES',
        count: deadStockCount,
        messageAr: `${deadStockCount} منتجات راكدة لم تسجل أي مبيعات خلال الفترة المحددة.`,
      },
    ];

    return {
      totalProducts: products.length,
      activeProducts: products.filter((p) => p.isActive).length,
      outOfStockCount,
      lowStockCount,
      fastMovingCount,
      slowMovingCount,
      deadStockCount,
      items: items.sort((a, b) => a.estimatedDaysRemaining - b.estimatedDaysRemaining),
      warningsSummary: warningsSummary.filter((w) => w.count > 0),
    };
  }
}
