import { prisma } from '../../../database/prisma';
import {
  DateRange,
  TimeSeriesPoint,
  SalesBreakdownItem,
} from '../types/analytics.types';

export class SalesAnalyticsService {
  /**
   * Generates chronological time series aggregation (daily points) for sales charts.
   */
  public static async getTimeSeries(
    range: DateRange,
    sellerId?: string
  ): Promise<TimeSeriesPoint[]> {
    const where: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    const sellerOrders = await prisma.sellerOrder.findMany({
      where,
      select: {
        createdAt: true,
        subtotal: true,
        sellerPayout: true,
        commissionAmount: true,
        taxAmount: true,
        items: { select: { quantity: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const dayMap = new Map<string, {
      grossSales: number;
      netSales: number;
      ordersCount: number;
      unitsSold: number;
      commission: number;
      tax: number;
      refunds: number;
    }>();

    // Initialize all days in the range so the chart has continuous points
    const currentIter = new Date(range.startDate);
    while (currentIter <= range.endDate) {
      const dateKey = currentIter.toISOString().split('T')[0];
      dayMap.set(dateKey, {
        grossSales: 0,
        netSales: 0,
        ordersCount: 0,
        unitsSold: 0,
        commission: 0,
        tax: 0,
        refunds: 0,
      });
      currentIter.setDate(currentIter.getDate() + 1);
    }

    for (const order of sellerOrders) {
      const dateKey = order.createdAt.toISOString().split('T')[0];
      const entry = dayMap.get(dateKey) || {
        grossSales: 0,
        netSales: 0,
        ordersCount: 0,
        unitsSold: 0,
        commission: 0,
        tax: 0,
        refunds: 0,
      };

      entry.grossSales += order.subtotal || 0;
      entry.netSales += order.sellerPayout || 0;
      entry.ordersCount += 1;
      entry.commission += order.commissionAmount || 0;
      entry.tax += order.taxAmount || 0;

      const units = order.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
      entry.unitsSold += units;

      dayMap.set(dateKey, entry);
    }

    return Array.from(dayMap.entries()).map(([date, d]) => ({
      date,
      timestamp: new Date(date).toISOString(),
      grossSales: Number(d.grossSales.toFixed(2)),
      netSales: Number(d.netSales.toFixed(2)),
      ordersCount: d.ordersCount,
      unitsSold: d.unitsSold,
      aov: d.ordersCount > 0 ? Number((d.grossSales / d.ordersCount).toFixed(2)) : 0,
      commission: Number(d.commission.toFixed(2)),
      tax: Number(d.tax.toFixed(2)),
      refunds: Number(d.refunds.toFixed(2)),
    }));
  }

  /**
   * Calculates multidimensional sales breakdown by Category, Product, Store, Status, Payment Method, Delivery Method.
   */
  public static async getSalesBreakdown(
    groupBy: 'category' | 'product' | 'store' | 'orderStatus' | 'paymentMethod' | 'deliveryMethod',
    range: DateRange,
    sellerId?: string
  ): Promise<SalesBreakdownItem[]> {
    const where: any = {
      createdAt: { gte: range.startDate, lte: range.endDate },
    };
    if (sellerId) {
      where.sellerId = sellerId;
    }

    // Breakdown by Category
    if (groupBy === 'category') {
      const items = await prisma.orderItem.findMany({
        where: {
          sellerOrder: where,
        },
        select: {
          totalPrice: true,
          quantity: true,
          taxAmount: true,
          discountAmount: true,
          product: {
            select: {
              categoryId: true,
              category: { select: { id: true, nameAr: true, nameEn: true } },
            },
          },
          sellerOrder: { select: { commissionAmount: true, subtotal: true } },
        },
      });

      const catMap = new Map<string, {
        nameAr: string;
        nameEn: string;
        gross: number;
        discount: number;
        tax: number;
        commission: number;
        units: number;
        orders: number;
      }>();

      let totalGrossAll = 0;
      for (const item of (items as any[])) {
        const cat = item.product?.category;
        const catId = cat?.id || 'uncategorized';
        const nameAr = cat?.nameAr || cat?.nameEn || 'غير مصنف';
        const nameEn = cat?.nameEn || cat?.nameAr || 'Uncategorized';

        const gross = item.totalPrice || 0;
        const discount = item.discountAmount || 0;
        const tax = item.taxAmount || 0;
        const comm = item.sellerOrder?.subtotal > 0
          ? (gross / item.sellerOrder.subtotal) * (item.sellerOrder.commissionAmount || 0)
          : gross * 0.10;

        totalGrossAll += gross;

        const current = catMap.get(catId) || {
          nameAr,
          nameEn,
          gross: 0,
          discount: 0,
          tax: 0,
          commission: 0,
          units: 0,
          orders: 0,
        };

        current.gross += gross;
        current.discount += discount;
        current.tax += tax;
        current.commission += comm;
        current.units += item.quantity || 0;
        current.orders += 1;

        catMap.set(catId, current);
      }

      return Array.from(catMap.entries()).map(([key, v]) => ({
        key,
        nameAr: v.nameAr,
        nameEn: v.nameEn,
        grossSales: Number(v.gross.toFixed(2)),
        discount: Number(v.discount.toFixed(2)),
        refund: 0,
        tax: Number(v.tax.toFixed(2)),
        commission: Number(v.commission.toFixed(2)),
        fees: 0,
        netSellerAmount: Number((v.gross - v.commission - v.discount).toFixed(2)),
        ordersCount: v.orders,
        unitsSold: v.units,
        percentageOfTotal: totalGrossAll > 0 ? Number(((v.gross / totalGrossAll) * 100).toFixed(2)) : 0,
      })).sort((a, b) => b.grossSales - a.grossSales);
    }

    // Breakdown by Order Status
    if (groupBy === 'orderStatus') {
      const orders = await prisma.sellerOrder.findMany({
        where,
        select: {
          status: true,
          subtotal: true,
          commissionAmount: true,
          taxAmount: true,
          sellerPayout: true,
          items: { select: { quantity: true } },
        },
      });

      const statusMap = new Map<string, {
        gross: number;
        commission: number;
        tax: number;
        net: number;
        orders: number;
        units: number;
      }>();

      let totalGross = 0;
      for (const o of (orders as any[])) {
        const st = String(o.status);
        totalGross += o.subtotal || 0;
        const current = statusMap.get(st) || { gross: 0, commission: 0, tax: 0, net: 0, orders: 0, units: 0 };
        current.gross += o.subtotal || 0;
        current.commission += o.commissionAmount || 0;
        current.tax += o.taxAmount || 0;
        current.net += o.sellerPayout || 0;
        current.orders += 1;
        const itemsList = o.items || [];
        current.units += itemsList.reduce((s: number, it: any) => s + (it.quantity || 0), 0);
        statusMap.set(st, current);
      }

      return Array.from(statusMap.entries()).map(([key, v]) => ({
        key,
        nameAr: getStatusLabelAr(key),
        nameEn: key,
        grossSales: Number(v.gross.toFixed(2)),
        discount: 0,
        refund: 0,
        tax: Number(v.tax.toFixed(2)),
        commission: Number(v.commission.toFixed(2)),
        fees: 0,
        netSellerAmount: Number(v.net.toFixed(2)),
        ordersCount: v.orders,
        unitsSold: v.units,
        percentageOfTotal: totalGross > 0 ? Number(((v.gross / totalGross) * 100).toFixed(2)) : 0,
      })).sort((a, b) => b.ordersCount - a.ordersCount);
    }

    // Breakdown by Payment Method
    if (groupBy === 'paymentMethod') {
      const orders = await prisma.sellerOrder.findMany({
        where,
        select: {
          subtotal: true,
          commissionAmount: true,
          taxAmount: true,
          sellerPayout: true,
          order: { select: { payment: { select: { method: true } } } },
          items: { select: { quantity: true } },
        },
      });

      const pmMap = new Map<string, {
        gross: number;
        commission: number;
        tax: number;
        net: number;
        orders: number;
        units: number;
      }>();

      let totalGross = 0;
      for (const o of (orders as any[])) {
        const method = String(o.order?.payment?.method || 'CASH_ON_DELIVERY');
        totalGross += o.subtotal || 0;
        const cur = pmMap.get(method) || { gross: 0, commission: 0, tax: 0, net: 0, orders: 0, units: 0 };
        cur.gross += o.subtotal || 0;
        cur.commission += o.commissionAmount || 0;
        cur.tax += o.taxAmount || 0;
        cur.net += o.sellerPayout || 0;
        cur.orders += 1;
        const itemsList = o.items || [];
        cur.units += itemsList.reduce((s: number, it: any) => s + (it.quantity || 0), 0);
        pmMap.set(method, cur);
      }

      return Array.from(pmMap.entries()).map(([key, v]) => ({
        key,
        nameAr: getPaymentMethodLabelAr(key),
        nameEn: key,
        grossSales: Number(v.gross.toFixed(2)),
        discount: 0,
        refund: 0,
        tax: Number(v.tax.toFixed(2)),
        commission: Number(v.commission.toFixed(2)),
        fees: 0,
        netSellerAmount: Number(v.net.toFixed(2)),
        ordersCount: v.orders,
        unitsSold: v.units,
        percentageOfTotal: totalGross > 0 ? Number(((v.gross / totalGross) * 100).toFixed(2)) : 0,
      })).sort((a, b) => b.grossSales - a.grossSales);
    }

    // Default breakdown by Store
    const orders = await prisma.sellerOrder.findMany({
      where,
      select: {
        sellerId: true,
        subtotal: true,
        commissionAmount: true,
        taxAmount: true,
        sellerPayout: true,
        seller: {
          select: {
            stores: { select: { id: true, name: true } },
          },
        },
        items: { select: { quantity: true } },
      },
    });

    const storeMap = new Map<string, {
      nameAr: string;
      nameEn: string;
      gross: number;
      commission: number;
      tax: number;
      net: number;
      orders: number;
      units: number;
    }>();

    let totalGross = 0;
    for (const o of (orders as any[])) {
      const store = o.seller?.stores?.[0];
      const storeId = store?.id || o.sellerId;
      const nameAr = store?.name || 'متجر غير معروف';
      const nameEn = store?.name || 'Unknown Store';

      totalGross += o.subtotal || 0;
      const cur = storeMap.get(storeId) || {
        nameAr,
        nameEn,
        gross: 0,
        commission: 0,
        tax: 0,
        net: 0,
        orders: 0,
        units: 0,
      };

      cur.gross += o.subtotal || 0;
      cur.commission += o.commissionAmount || 0;
      cur.tax += o.taxAmount || 0;
      cur.net += o.sellerPayout || 0;
      cur.orders += 1;
      const itemsList = o.items || [];
      cur.units += itemsList.reduce((s: number, it: any) => s + (it.quantity || 0), 0);
      storeMap.set(storeId, cur);
    }

    return Array.from(storeMap.entries()).map(([key, v]) => ({
      key,
      nameAr: v.nameAr,
      nameEn: v.nameEn,
      grossSales: Number(v.gross.toFixed(2)),
      discount: 0,
      refund: 0,
      tax: Number(v.tax.toFixed(2)),
      commission: Number(v.commission.toFixed(2)),
      fees: 0,
      netSellerAmount: Number(v.net.toFixed(2)),
      ordersCount: v.orders,
      unitsSold: v.units,
      percentageOfTotal: totalGross > 0 ? Number(((v.gross / totalGross) * 100).toFixed(2)) : 0,
    })).sort((a, b) => b.grossSales - a.grossSales);
  }
}

function getStatusLabelAr(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'قيد الانتظار',
    CONFIRMED: 'مؤكد',
    PROCESSING: 'قيد التجهيز',
    READY_TO_SHIP: 'جاهز للشحن',
    SHIPPED: 'تم الشحن',
    DELIVERED: 'تم التوصيل بنجاح',
    CANCELLED_BY_CUSTOMER: 'ملغي من العميل',
    CANCELLED_BY_SELLER: 'ملغي من البائع',
    REJECTED_BY_SELLER: 'مرفوض من البائع',
    CANCELLED_BY_ADMIN: 'ملغي من الإدارة',
    RETURNED: 'مرتجع',
    REFUNDED: 'مسترد',
  };
  return map[status] || status;
}

function getPaymentMethodLabelAr(method: string): string {
  const map: Record<string, string> = {
    CASH_ON_DELIVERY: 'الدفع عند الاستلام (COD)',
    WALLET: 'محفظة سوقناا',
    YEMENI_WALLET: 'محفظة إلكترونية يمنية',
    KURAIMI: 'الكريمي إم فلوس',
    CASHPAY: 'كاش باي',
    ONECASH: 'ون كاش',
    JAWALI: 'جوالي',
    JAIB: 'جيب',
    CREDIT_CARD: 'بطاقة بنكية',
    MADA: 'مدى',
    APPLE_PAY: 'Apple Pay',
  };
  return map[method] || method;
}
