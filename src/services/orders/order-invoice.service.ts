import { smtpEmailProvider } from '../../modules/notifications/providers/email.provider';

export interface InvoiceData {
  title: string;
  orderNumberShort: string;
  orderReferenceFull: string;
  createdAt: string;
  paymentMethod: string;
  paymentStatus: string;
  customer: {
    name: string;
    phone: string;
  };
  deliveryAddress: {
    recipientName: string;
    recipientPhone: string;
    cityName: string;
    street: string;
    buildingNumber?: string | null;
  };
  sellerOrders: Array<{
    sellerOrderNumber: string;
    storeName: string;
    subtotal: number;
    items: Array<{
      productName: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
    }>;
  }>;
  summary: {
    subtotal: number;
    deliveryFee: number;
    discountAmount: number;
    taxableAmount: number;
    taxAmount: number;
    taxName?: string;
    taxRate?: number;
    total: number;
    currency: string;
  };
}

export class OrderInvoiceService {
  /**
   * Formats structured invoice data from an order model.
   * Completely excludes internal database IDs for security and cleanliness.
   */
  public static buildInvoiceData(order: any, sellerFilterId?: string): InvoiceData {
    const address = order.addressSnapshot || order.deliveryAddress || {};
    const payment = order.payment || {};
    const shortNumber = order.displayOrderNumber
      ? (order.displayOrderNumber.startsWith('#') ? order.displayOrderNumber : `#${order.displayOrderNumber}`)
      : (order.orderNumber ? `#${order.orderNumber}` : '');

    // Filter seller orders if a specific seller is requesting their sub-invoice
    const filteredSellerOrders = sellerFilterId
      ? (order.sellerOrders || []).filter((so: any) => so.sellerId === sellerFilterId)
      : (order.sellerOrders || []);

    const sellerOrders = filteredSellerOrders.map((so: any) => ({
      sellerOrderNumber: so.sellerOrderNumber || `${order.orderNumber}-S${String(so.subOrderIndex || 1).padStart(2, '0')}`,
      storeName: so.seller?.stores?.[0]?.name || 'متجر سوقناا',
      subtotal: so.subtotal || 0,
      items: (so.items || []).map((it: any) => ({
        productName: it.productNameAr || it.productNameEn || it.product?.nameAr || 'منتج',
        quantity: it.quantity || 1,
        unitPrice: it.unitPrice || 0,
        totalPrice: it.totalPrice || (it.unitPrice * it.quantity) || 0,
      })),
    }));

    return {
      title: 'فاتورة مبيعات سوقناا الإلكترونية - SOUQNAA Invoice',
      orderNumberShort: shortNumber,
      orderReferenceFull: order.orderNumber,
      createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString(),
      paymentMethod: payment.method || order.paymentMethod || 'CASH_ON_DELIVERY',
      paymentStatus: payment.status || 'PENDING',
      customer: {
        name: address.recipientName || order.user?.firstName || 'عميل سوقناا',
        phone: address.recipientPhone || order.user?.phone || '',
      },
      deliveryAddress: {
        recipientName: address.recipientName || 'عميل سوقناا',
        recipientPhone: address.recipientPhone || '',
        cityName: address.cityName || address.city?.nameAr || 'المملكة',
        street: address.street || '',
        buildingNumber: address.buildingNumber || null,
      },
      sellerOrders,
      summary: {
        subtotal: order.subtotal || 0,
        deliveryFee: order.deliveryFee || 0,
        discountAmount: order.discountAmount || 0,
        taxableAmount: Math.max(0, (order.subtotal || 0) - (order.discountAmount || 0)),
        taxAmount: order.taxAmount || 0,
        taxName: order.taxSnapshots?.[0]?.taxName || 'ضريبة القيمة المضافة (VAT)',
        taxRate: order.taxSnapshots?.[0]?.taxRate ? order.taxSnapshots[0].taxRate * 100 : undefined,
        total: order.total || 0,
        currency: order.currency || 'ر.س',
      },
    };
  }

  /**
   * Generates high-quality, print-ready, responsive HTML digital receipt.
   */
  public static renderHtmlReceipt(data: InvoiceData): string {
    const formattedDate = new Date(data.createdAt).toLocaleDateString('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>فاتورة الطلب ${data.orderNumberShort} - SOUQNAA</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #1e293b; direction: rtl; }
    .receipt-container { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 32px; border: 1px solid #e2e8f0; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
    .brand h1 { margin: 0; color: #0d9488; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .brand p { margin: 4px 0 0; color: #64748b; font-size: 13px; }
    .order-badge { text-align: left; }
    .short-num { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0; }
    .ref-num { font-size: 13px; color: #0d9488; font-weight: 600; margin: 4px 0 0; font-family: monospace; }
    .section-title { font-size: 14px; font-weight: 700; color: #475569; margin: 20px 0 8px; text-transform: uppercase; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: #f8fafc; padding: 16px; border-radius: 8px; margin-top: 12px; }
    .info-item label { display: block; font-size: 12px; color: #64748b; margin-bottom: 4px; }
    .info-item span { font-size: 14px; font-weight: 600; color: #1e293b; }
    .suborder-card { margin-top: 24px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .suborder-header { background: #f1f5f9; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 14px; }
    .suborder-ref { font-family: monospace; color: #0d9488; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; text-align: right; }
    th { padding: 10px 16px; background: #fff; font-size: 12px; color: #64748b; border-bottom: 1px solid #f1f5f9; }
    td { padding: 12px 16px; font-size: 13px; border-bottom: 1px solid #f8fafc; }
    .totals-area { margin-top: 24px; padding: 16px; background: #f8fafc; border-radius: 8px; }
    .total-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: #475569; }
    .total-row.grand-total { border-top: 2px dashed #cbd5e1; padding-top: 12px; margin-top: 8px; font-size: 18px; font-weight: 800; color: #0f172a; }
    .footer { text-align: center; margin-top: 32px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; }
    @media print { body { background: #fff; padding: 0; } .receipt-container { box-shadow: none; border: none; } }
  </style>
</head>
<body>
  <div class="receipt-container">
    <div class="header">
      <div class="brand">
        <h1>سوقناا | SOUQNAA</h1>
        <p>منصة التسوق والتجارة الإلكترونية المتعددة المتاجر</p>
      </div>
      <div class="order-badge">
        <p class="short-num">${data.orderNumberShort}</p>
        <p class="ref-num">${data.orderReferenceFull}</p>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-item">
        <label>تاريخ ووقت الطلب</label>
        <span>${formattedDate}</span>
      </div>
      <div class="info-item">
        <label>طريقة الدفع</label>
        <span>${data.paymentMethod}</span>
      </div>
      <div class="info-item">
        <label>المستلم</label>
        <span>${data.deliveryAddress.recipientName} (${data.deliveryAddress.recipientPhone})</span>
      </div>
      <div class="info-item">
        <label>عنوان التوصيل</label>
        <span>${data.deliveryAddress.cityName} - ${data.deliveryAddress.street}</span>
      </div>
    </div>

    <div class="section-title">تفاصيل المتاجر والطلبات الفرعية (Sub-Orders)</div>
    ${data.sellerOrders
      .map(
        (so) => `
      <div class="suborder-card">
        <div class="suborder-header">
          <span>المتجر: ${so.storeName}</span>
          <span class="suborder-ref">طلب المتجر: ${so.sellerOrderNumber}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>المنتج</th>
              <th>الكمية</th>
              <th>السعر الفردي</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            ${so.items
              .map(
                (item) => `
              <tr>
                <td>${item.productName}</td>
                <td>${item.quantity}</td>
                <td>${item.unitPrice} ${data.summary.currency}</td>
                <td><strong>${item.totalPrice} ${data.summary.currency}</strong></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
      )
      .join('')}

    <div class="totals-area">
      <div class="total-row">
        <span>المجموع الفرعي (قبل الخصم):</span>
        <span>${data.summary.subtotal} ${data.summary.currency}</span>
      </div>
      ${
        data.summary.discountAmount > 0
          ? `
      <div class="total-row" style="color: #059669;">
        <span>إجمالي الخصومات والكوبونات:</span>
        <span>-${data.summary.discountAmount} ${data.summary.currency}</span>
      </div>`
          : ''
      }
      <div class="total-row">
        <span>المبلغ الخاضع للضريبة:</span>
        <span>${data.summary.taxableAmount} ${data.summary.currency}</span>
      </div>
      <div class="total-row">
        <span>${data.summary.taxName || 'ضريبة القيمة المضافة'}${data.summary.taxRate ? ` (${data.summary.taxRate}%)` : ''}:</span>
        <span>${data.summary.taxAmount} ${data.summary.currency}</span>
      </div>
      <div class="total-row">
        <span>رسوم التوصيل والشحن:</span>
        <span>${data.summary.deliveryFee} ${data.summary.currency}</span>
      </div>
      <div class="total-row grand-total">
        <span>الإجمالي النهائي المستحق:</span>
        <span>${data.summary.total} ${data.summary.currency}</span>
      </div>
    </div>

    <div class="footer">
      <p>شكراً لتسوقكم عبر منصة سوقناا • للاستفسارات والدعم الفني: support@souqnaa.online</p>
      <p>الرقم المرجعي الثابت: ${data.orderReferenceFull}</p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Dispatches the invoice via the centralized Notification Platform Email Provider
   * using the localized INVOICE template. (Zero HTML in caller)
   */
  public static async sendInvoiceEmail(
    order: any,
    targetEmail?: string,
    locale: 'ar' | 'en' = 'ar'
  ) {
    const invoiceData = this.buildInvoiceData(order);
    const recipientEmail = targetEmail || order.user?.email;
    if (!recipientEmail) {
      throw new Error('No recipient email available for sending invoice');
    }

    const items = invoiceData.sellerOrders.flatMap((so) =>
      so.items.map((it) => ({
        name: it.productName,
        quantity: it.quantity,
        price: it.unitPrice,
        total: it.totalPrice,
      }))
    );

    return smtpEmailProvider.sendTemplate(recipientEmail, 'INVOICE', locale, {
      name: `${order.user?.firstName || ''} ${order.user?.lastName || ''}`.trim() || 'عميلنا العزيز',
      email: recipientEmail,
      orderNumber: invoiceData.orderNumberShort,
      invoiceNumber: `INV-${invoiceData.orderNumberShort.replace('#', '')}`,
      totalAmount: invoiceData.summary.total,
      subtotal: invoiceData.summary.subtotal,
      deliveryFee: invoiceData.summary.deliveryFee,
      discount: invoiceData.summary.discountAmount,
      currency: invoiceData.summary.currency,
      paymentMethod: invoiceData.paymentMethod,
      paidAt: invoiceData.createdAt,
      items,
      actionUrl: `${process.env.APP_BASE_URL || 'https://souqnaa.com'}/orders/${order.id}`,
    });
  }
}
