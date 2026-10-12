import { prisma } from '../../../database/prisma';
import { DateRange } from '../types/analytics.types';

export interface TaxAnalyticsReport {
  taxableSales: number;
  exemptSales: number;
  taxCollected: number;
  taxRefunded: number;
  netTax: number;
  effectiveTaxRate: number;
  byCategory: {
    categoryId: string;
    categoryNameAr: string;
    taxableAmount: number;
    taxAmount: number;
  }[];
  authoritativeSource: 'TAX_ENGINE_SNAPSHOTS';
  ruleVersionsApplied: string[];
}

export class TaxAnalyticsService {
  /**
   * Consumes authoritative Tax Engine snapshots without recalculating historical taxes.
   */
  public static async getTaxAnalytics(
    range: DateRange,
    sellerId?: string
  ): Promise<TaxAnalyticsReport> {
    const whereSnapshot: any = {
      calculatedAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      whereSnapshot.sellerId = sellerId;
    }

    // 1. Authoritative Order Tax Snapshots
    const snapshots = await prisma.orderTaxSnapshot.findMany({
      where: whereSnapshot,
      include: {
        orderItem: {
          select: {
            totalPrice: true,
            product: {
              select: {
                categoryId: true,
                category: { select: { id: true, nameAr: true } },
              },
            },
          },
        },
      },
    });

    // 2. Authoritative Refund Tax Records
    const refundTaxRecords = await prisma.refundTaxRecord.findMany({
      where: {
        createdAt: { gte: range.startDate, lte: range.endDate },
        ...(sellerId ? { sellerOrderId: { in: (await prisma.sellerOrder.findMany({ where: { sellerId }, select: { id: true } })).map((s) => s.id) } } : {}),
      },
      select: { refundedTax: true },
    });

    let taxableSales = 0;
    let exemptSales = 0;
    let taxCollected = 0;
    const ruleVersions = new Set<string>();

    const catTaxMap = new Map<string, { nameAr: string; taxable: number; tax: number }>();

    for (const snap of snapshots) {
      taxableSales += snap.taxableAmount || 0;
      taxCollected += snap.taxAmount || 0;
      if (snap.taxRuleVersion) ruleVersions.add(String(snap.taxRuleVersion));

      // Category breakdown from linked order item if available
      const item = snap.orderItem;
      const catId = item?.product?.categoryId || 'general';
      const catName = item?.product?.category?.nameAr || 'السلع العامة والخاضعة للضريبة';
      const cur = catTaxMap.get(catId) || { nameAr: catName, taxable: 0, tax: 0 };
      cur.taxable += snap.taxableAmount || 0;
      cur.tax += snap.taxAmount || 0;
      catTaxMap.set(catId, cur);
    }

    const taxRefunded = refundTaxRecords.reduce((sum, r) => sum + (r.refundedTax || 0), 0);
    const netTax = Math.max(0, taxCollected - taxRefunded);
    const effectiveTaxRate = taxableSales > 0 ? Number(((taxCollected / taxableSales) * 100).toFixed(2)) : 0;

    const byCategory = Array.from(catTaxMap.entries()).map(([cId, d]) => ({
      categoryId: cId,
      categoryNameAr: d.nameAr,
      taxableAmount: Number(d.taxable.toFixed(2)),
      taxAmount: Number(d.tax.toFixed(2)),
    })).sort((a, b) => b.taxAmount - a.taxAmount);

    return {
      taxableSales: Number(taxableSales.toFixed(2)),
      exemptSales: Number(exemptSales.toFixed(2)),
      taxCollected: Number(taxCollected.toFixed(2)),
      taxRefunded: Number(taxRefunded.toFixed(2)),
      netTax: Number(netTax.toFixed(2)),
      effectiveTaxRate,
      byCategory,
      authoritativeSource: 'TAX_ENGINE_SNAPSHOTS',
      ruleVersionsApplied: Array.from(ruleVersions),
    };
  }
}
