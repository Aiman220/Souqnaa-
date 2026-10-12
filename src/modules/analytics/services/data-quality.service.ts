import { prisma } from '../../../database/prisma';

export interface DataQualityReport {
  status: 'HEALTHY' | 'DEGRADED' | 'ATTENTION_REQUIRED';
  checkedAt: string;
  checks: {
    checkName: string;
    passed: boolean;
    issuesFound: number;
    detailsAr: string;
  }[];
}

export class DataQualityService {
  /**
   * Validates integrity and consistency of underlying data sources to prevent corrupted analytical outputs.
   */
  public static async runQualityAudit(): Promise<DataQualityReport> {
    const checks: DataQualityReport['checks'] = [];

    // 1. Negative amounts in seller orders
    const negativeSubtotals = await prisma.sellerOrder.count({
      where: { subtotal: { lt: 0 } },
    });
    checks.push({
      checkName: 'NEGATIVE_SELLER_ORDER_SUBTOTALS',
      passed: negativeSubtotals === 0,
      issuesFound: negativeSubtotals,
      detailsAr: negativeSubtotals === 0
        ? 'لا توجد قيم مبيعات سالبة غير منطقية في طلبات المتاجر'
        : `تم رصد ${negativeSubtotals} طلبات بقيم سالبة غير مسموح بها`,
    });

    // 2. Orders without seller orders
    const orphanedOrders = await prisma.order.count({
      where: { sellerOrders: { none: {} } },
    });
    checks.push({
      checkName: 'ORPHANED_CUSTOMER_ORDERS',
      passed: orphanedOrders === 0,
      issuesFound: orphanedOrders,
      detailsAr: orphanedOrders === 0
        ? 'كافة طلبات العملاء مرتبطة بطلبات بائعين نظامية'
        : `تم رصد ${orphanedOrders} طلبات عميل بدون طلبات بائع مخصصة`,
    });

    // 3. Products with negative stock
    const negativeStock = await prisma.inventory.count({
      where: { quantity: { lt: 0 } },
    });
    checks.push({
      checkName: 'NEGATIVE_PRODUCT_STOCK',
      passed: negativeStock === 0,
      issuesFound: negativeStock,
      detailsAr: negativeStock === 0
        ? 'مخزون جميع المنتجات منطقي وغير سالب'
        : `تم رصد ${negativeStock} منتجات بكميات مخزون سالبة`,
    });

    // 4. Currency Consistency Check (SOUQNAA remains ONE configured currency: YER)
    const nonYemeniOrders = await prisma.order.count({
      where: { currency: { not: 'YER' } },
    });
    checks.push({
      checkName: 'CURRENCY_CONSISTENCY',
      passed: nonYemeniOrders === 0,
      issuesFound: nonYemeniOrders,
      detailsAr: nonYemeniOrders === 0
        ? 'تطابق كامل لعملة السوق المعتمدة (ريال يمني - YER)'
        : `تم رصد ${nonYemeniOrders} طلبات بعملة مخالفة لعملة السوق المعتمدة`,
    });

    const anyFailed = checks.some((c) => !c.passed);
    const criticalFailed = checks.some((c) => !c.passed && c.issuesFound > 10);

    return {
      status: criticalFailed ? 'ATTENTION_REQUIRED' : anyFailed ? 'DEGRADED' : 'HEALTHY',
      checkedAt: new Date().toISOString(),
      checks,
    };
  }
}
