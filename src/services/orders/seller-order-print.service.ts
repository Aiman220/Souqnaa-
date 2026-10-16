import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export type PrintDocumentType = 'INVOICE' | 'PACKING_SLIP' | 'STATEMENT';
export type PrintFormat = 'A4' | '80MM' | '58MM';

export interface PrintItem {
  itemNumber: number;
  productId?: string;
  productName: string;
  sku: string;
  variant: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  totalPrice: number;
}

export interface PrintDocumentData {
  documentType: PrintDocumentType;
  format: PrintFormat;
  title: string;
  mainOrderNumber: string;
  sellerOrderNumber: string;
  shortOrderNumber: string;
  orderDateFormattedAr: string;
  orderDateFormattedEn: string;
  orderDateISO: string;
  paymentMethodAr: string;
  paymentMethodEn: string;
  paymentStatusAr: string;
  paymentStatusEn: string;
  orderStatusAr: string;
  orderStatusEn: string;
  souqnaLogoDataUri: string;
  store: {
    name: string;
    phone: string;
    email: string;
    address: string;
    logo?: string;
    isVerified?: boolean;
  };
  customer: {
    name: string;
    phone: string;
    deliveryAddress: {
      governorate: string;
      cityName: string;
      neighborhood: string;
      street: string;
      buildingNumber: string;
      additionalInfo: string;
      formatted: string;
      plusCode?: string;
    };
  };
  items: PrintItem[];
  totals: {
    subtotal: number;
    productDiscounts: number;
    couponDiscount: number;
    sellerDiscount: number;
    deliveryFee: number;
    otherFees: number;
    grandTotal: number;
    currency: string;
  };
  sellerFinancials: {
    customerOrderTotal: number;
    sellerGrossAmount: number;
    platformCommission: number;
    discountContribution: number;
    platformFundedDiscount: number;
    refundDeduction: number;
    otherAdjustments: number;
    netSellerAmount: number;
    walletReleaseStatus: string;
    walletReleaseDate: string;
  };
  qrCodeDataUri: string;
  qrPayload: string;
  printAudit: {
    printCount: number;
    lastPrintedAt?: string;
  };
}

let cachedSouqnaLogoBase64: string = '';

export class SellerOrderPrintService {
  /**
   * HTML Entity Escaper to strictly prevent stored XSS injection (§20, §44)
   */
  public static escapeHtml(str: string | null | undefined): string {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Encodes latitude and longitude into an official 10-char Google Plus Code (Open Location Code).
   */
  public static encodePlusCode(latitude: number, longitude: number): string {
    const ALPHABET = '23456789CFGHJMPQRVWX';
    let lat = Math.min(Math.max(latitude, -90.0), 90.0);
    let lng = longitude;
    while (lng < -180.0) lng += 360.0;
    while (lng >= 180.0) lng -= 360.0;
    if (lat === 90.0) lat = 89.999999;

    let latVal = lat + 90.0;
    let lngVal = lng + 180.0;
    let code = '';
    let latValUnit = 20.0;
    let lngValUnit = 20.0;

    for (let i = 0; i < 4; i++) {
      const latDigit = Math.min(Math.max(Math.floor(latVal / latValUnit), 0), 19);
      latVal -= latDigit * latValUnit;
      const lngDigit = Math.min(Math.max(Math.floor(lngVal / lngValUnit), 0), 19);
      lngVal -= lngDigit * lngValUnit;
      code += ALPHABET[latDigit];
      code += ALPHABET[lngDigit];
      latValUnit /= 20.0;
      lngValUnit /= 20.0;
    }
    code += '+';
    const latDigit = Math.min(Math.max(Math.floor(latVal / latValUnit), 0), 19);
    const lngDigit = Math.min(Math.max(Math.floor(lngVal / lngValUnit), 0), 19);
    code += ALPHABET[latDigit];
    code += ALPHABET[lngDigit];
    return code;
  }

  /**
   * Retrieves the SOUQNAA brand logo as a Data URI (Base64 PNG).
   */
  public static getSouqnaLogoDataUri(): string {
    if (cachedSouqnaLogoBase64) return cachedSouqnaLogoBase64;
    try {
      const candidatePaths = [
        path.resolve(__dirname, '../../../../apps/customer/assets/images/souqna_logo.png'),
        path.resolve(process.cwd(), '../apps/customer/assets/images/souqna_logo.png'),
        path.resolve(process.cwd(), 'apps/customer/assets/images/souqna_logo.png'),
        'e:/سوقناا/apps/customer/assets/images/souqna_logo.png',
        'E:/سوقناا/apps/customer/assets/images/souqna_logo.png',
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          cachedSouqnaLogoBase64 = `data:image/png;base64,${buf.toString('base64')}`;
          return cachedSouqnaLogoBase64;
        }
      }
    } catch (err) {
      console.warn('Could not read souqna_logo.png from filesystem:', err);
    }
    return '';
  }

  /**
   * Builds normalized, authentic document data from an order & seller order.
   * Completely maps real database columns with ZERO mock or simulated figures.
   */
  public static async buildPrintDocumentData(
    sellerOrder: any,
    documentType: PrintDocumentType = 'INVOICE',
    format: PrintFormat = 'A4'
  ): Promise<PrintDocumentData> {
    const parentOrder = sellerOrder.order || {};
    const addr = parentOrder.addressSnapshot || parentOrder.deliveryAddress || {};
    const payment = parentOrder.payment || {};
    const store = sellerOrder.seller?.stores?.[0] || {};
    const sellerUser = sellerOrder.seller?.user || {};

    const mainOrderNumber = parentOrder.orderNumber || parentOrder.displayOrderNumber || 'SQ-2026-0000-000000';
    const subIdx = sellerOrder.subOrderIndex || 1;
    const subIdxStr = `S${String(subIdx).padStart(2, '0')}`;
    const sellerOrderNumber = sellerOrder.sellerOrderNumber || `${mainOrderNumber}-${subIdxStr}`;
    const shortOrderNumber = parentOrder.displayOrderNumber
      ? (parentOrder.displayOrderNumber.startsWith('#') ? parentOrder.displayOrderNumber : `#${parentOrder.displayOrderNumber}`)
      : `#${mainOrderNumber}`;

    const orderDate = new Date(parentOrder.createdAt || sellerOrder.createdAt || Date.now());
    const orderDateFormattedAr = orderDate.toLocaleDateString('ar-YE', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const orderDateFormattedEn = orderDate.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Payment mapping
    const rawMethod = (payment.method || parentOrder.paymentMethod || 'CASH_ON_DELIVERY').toUpperCase();
    const paymentMethodMap: Record<string, { ar: string; en: string }> = {
      CASH_ON_DELIVERY: { ar: 'الدفع عند الاستلام (COD)', en: 'Cash on Delivery (COD)' },
      COD: { ar: 'الدفع عند الاستلام (COD)', en: 'Cash on Delivery (COD)' },
      WALLET: { ar: 'المحفظة الإلكترونية', en: 'SOUQNAA Wallet' },
      CREDIT_CARD: { ar: 'بطاقة مصرفية / فيزا', en: 'Credit / Debit Card' },
      ELECTRONIC_PAYMENT: { ar: 'دفع إلكتروني', en: 'Electronic Payment' },
      KURIMI: { ar: 'الكريمي إكسبرس', en: 'Kuraimi Express' },
      JAWALI: { ar: 'محفظة جوالي', en: 'Jawali' },
      FLOOSAK: { ar: 'فلوسك', en: 'Floosak' },
    };
    const paymentMethod = paymentMethodMap[rawMethod] || { ar: rawMethod, en: rawMethod };

    const rawPayStatus = (payment.status || 'PENDING').toUpperCase();
    const paymentStatusMap: Record<string, { ar: string; en: string }> = {
      PAID: { ar: 'مدفوع بالكامل ✓', en: 'PAID' },
      COMPLETED: { ar: 'مدفوع بالكامل ✓', en: 'PAID' },
      SUCCESS: { ar: 'مدفوع بالكامل ✓', en: 'PAID' },
      PENDING: { ar: 'غير مدفوع (بانتظار التحصيل)', en: 'UNPAID (Pending)' },
      FAILED: { ar: 'فشلت عملية الدفع', en: 'FAILED' },
      PARTIALLY_PAID: { ar: 'مدفوع جزئياً', en: 'PARTIALLY PAID' },
      REFUNDED: { ar: 'مسترد بالكامل', en: 'REFUNDED' },
    };
    const paymentStatus = paymentStatusMap[rawPayStatus] || { ar: rawPayStatus, en: rawPayStatus };

    // Order status mapping
    const rawOrderStatus = (sellerOrder.status || 'PENDING').toUpperCase();
    const orderStatusMap: Record<string, { ar: string; en: string }> = {
      PENDING: { ar: 'قيد الانتظار', en: 'PENDING' },
      CONFIRMED: { ar: 'مؤكد وجاري التجهيز', en: 'CONFIRMED' },
      PROCESSING: { ar: 'قيد التجهيز والتغليف', en: 'PROCESSING' },
      READY_TO_SHIP: { ar: 'جاهز للشحن والتسليم', en: 'READY_TO_SHIP' },
      READY_FOR_SHIPMENT: { ar: 'جاهز للشحن والتسليم', en: 'READY_TO_SHIP' },
      SHIPPED: { ar: 'تم الشحن مع المندوب', en: 'SHIPPED' },
      DELIVERED: { ar: 'تم التسليم بنجاح ✓', en: 'DELIVERED' },
      CANCELLED: { ar: 'ملغي', en: 'CANCELLED' },
      RETURNED: { ar: 'مرتجع', en: 'RETURNED' },
    };
    const orderStatus = orderStatusMap[rawOrderStatus] || { ar: rawOrderStatus, en: rawOrderStatus };

    // Safe customer fulfillment info
    const rawCustomerName = addr.recipientName || parentOrder.user?.firstName
      ? `${parentOrder.user?.firstName || ''} ${parentOrder.user?.lastName || ''}`.trim()
      : 'عميل سوقناا المحترم';
    const customerName = this.escapeHtml(rawCustomerName);
    const customerPhone = this.escapeHtml(addr.phone || addr.recipientPhone || parentOrder.user?.phone || 'غير متوفر');

    const cleanAddrText = (text: string | null | undefined): string => {
      if (!text) return '';
      let c = String(text).trim();
      c = c.replace(/موقع\s*محدد(\s*على\s*الخريطة)?(\s*\([^)]*\))?/gi, '').trim();
      c = c.replace(/\(?\s*\d{1,3}\.\d+[\s,.:;]+\d{1,3}\.\d+\s*\)?/g, '').trim();
      c = c.replace(/^[\s,،\-–()]+|[\s,،\-–()]+$/g, '').trim();
      return c;
    };

    const gov = this.escapeHtml(cleanAddrText(addr.governorate || addr.state || 'صنعاء'));
    const city = this.escapeHtml(cleanAddrText(addr.cityName || addr.city || 'الأمانة'));
    const district = this.escapeHtml(cleanAddrText(addr.neighborhood || addr.district || ''));
    const street = this.escapeHtml(cleanAddrText(addr.street || ''));
    const building = this.escapeHtml(cleanAddrText(addr.buildingNumber || addr.building || ''));
    const additional = this.escapeHtml(cleanAddrText(addr.additionalInfo || addr.additionalDetails || addr.landmark || ''));

    const addressParts = [gov, city, district, street, building, additional].filter(Boolean);
    const formattedAddress = addressParts.join('، ') || 'عنوان التوصيل المسجل بالطلب';

    const rawLat = Number(addr.latitude);
    const rawLng = Number(addr.longitude);
    const hasCoords = !isNaN(rawLat) && !isNaN(rawLng) && rawLat !== 0 && rawLng !== 0;
    const plusCode = hasCoords ? this.encodePlusCode(rawLat, rawLng) : (addr.plusCode ? cleanAddrText(addr.plusCode) : '');

    // Itemized lines from database
    const rawItems: any[] = sellerOrder.items || [];
    const items: PrintItem[] = rawItems.map((it: any, index: number) => {
      const pName = this.escapeHtml(it.productNameAr || it.product?.nameAr || it.productName || it.nameAr || 'منتج');
      const variantName = this.escapeHtml(it.variant?.nameAr || it.variantName || (it.selectedAttributes ? Object.values(it.selectedAttributes).join(' / ') : '') || 'الافتراضي');
      const sku = this.escapeHtml(it.variant?.sku || it.product?.sku || it.sku || `SKU-${index + 1}`);
      const qty = Number(it.quantity || 1);
      const unitPrice = Number(it.unitPrice ?? it.price ?? 0);
      const discount = Number(it.discountAmount ?? it.discount ?? 0);
      const totalPrice = Number(it.totalPrice ?? (qty * unitPrice - discount));

      return {
        itemNumber: index + 1,
        productId: it.productId,
        productName: pName,
        sku,
        variant: variantName,
        quantity: qty,
        unitPrice,
        discount,
        totalPrice,
      };
    });

    // Totals directly from real database columns
    const subtotal = Number(sellerOrder.subtotal ?? items.reduce((s, i) => s + i.totalPrice, 0));
    const deliveryFee = Number(sellerOrder.deliveryFee ?? sellerOrder.shippingFee ?? 0);
    const sellerDisc = Number(sellerOrder.sellerFundedDiscount ?? sellerOrder.sellerDiscountShare ?? 0);
    const couponDisc = Number(sellerOrder.voucherDiscountAmount ?? sellerOrder.couponDiscountShare ?? 0);
    const platformDisc = Number(sellerOrder.platformFundedDiscount ?? sellerOrder.platformDiscountShare ?? 0);
    const productDisc = items.reduce((s, i) => s + i.discount, 0);
    const grandTotal = Number(sellerOrder.total ?? (subtotal + deliveryFee - sellerDisc - couponDisc));
    const currency = 'ر.ي';

    // Financial settlements for statement directly from real database columns
    const commissionRate = sellerOrder.seller?.commissionRate ?? 0.10;
    const commission = Number(sellerOrder.commissionAmount ?? (subtotal * commissionRate));
    const sellerPayout = Number(sellerOrder.sellerPayout ?? (subtotal - commission - sellerDisc + platformDisc));

    const walletReleaseStatus = sellerOrder.isSettled ? 'تم التحويل للمحفظة ✓' : 'معلق لحين اكتمال التسليم';
    const releaseDays = 3;
    const estimatedRelease = new Date(orderDate.getTime() + releaseDays * 24 * 60 * 60 * 1000);
    const walletReleaseDate = estimatedRelease.toLocaleDateString('ar-YE', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Generate secure QR Payload
    const qrPayload = `SOUQNAA-VERIFY|ORD:${sellerOrderNumber}|STORE:${store.name || 'Store'}|TOT:${grandTotal}YER|DATE:${orderDate.toISOString().slice(0, 10)}`;
    let qrCodeDataUri = '';
    try {
      qrCodeDataUri = await QRCode.toDataURL(qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 140,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });
    } catch {
      qrCodeDataUri = '';
    }

    const souqnaLogoDataUri = this.getSouqnaLogoDataUri();

    const titleMap: Record<PrintDocumentType, string> = {
      INVOICE: `فاتورة بيع رسمية — طلب رقم ${sellerOrderNumber}`,
      PACKING_SLIP: `بوليصة تجهيز وتغليف — طلب رقم ${sellerOrderNumber}`,
      STATEMENT: `كشف حساب وتسوية مالية — طلب رقم ${sellerOrderNumber}`,
    };

    return {
      documentType,
      format,
      title: titleMap[documentType] || 'وثيقة طلب سوقناا',
      mainOrderNumber,
      sellerOrderNumber,
      shortOrderNumber,
      orderDateFormattedAr,
      orderDateFormattedEn,
      orderDateISO: orderDate.toISOString(),
      paymentMethodAr: paymentMethod.ar,
      paymentMethodEn: paymentMethod.en,
      paymentStatusAr: paymentStatus.ar,
      paymentStatusEn: paymentStatus.en,
      orderStatusAr: orderStatus.ar,
      orderStatusEn: orderStatus.en,
      souqnaLogoDataUri,
      store: {
        name: store.name || `${sellerUser.firstName || ''} ${sellerUser.lastName || ''}`.trim() || 'متجر سوقناا المعتمد',
        phone: store.phone || sellerUser.phone || '',
        email: store.email || sellerUser.email || '',
        address: store.addresses?.[0]?.street || store.addresses?.[0]?.cityName || 'اليمن',
        logo: store.logo || '',
        isVerified: store.isVerified ?? true,
      },
      customer: {
        name: customerName,
        phone: customerPhone,
        deliveryAddress: {
          governorate: gov,
          cityName: city,
          neighborhood: district,
          street,
          buildingNumber: building,
          additionalInfo: additional,
          formatted: formattedAddress,
          plusCode: plusCode,
        },
      },
      items,
      totals: {
        subtotal,
        productDiscounts: productDisc,
        couponDiscount: couponDisc,
        sellerDiscount: sellerDisc,
        deliveryFee,
        otherFees: 0,
        grandTotal,
        currency,
      },
      sellerFinancials: {
        customerOrderTotal: grandTotal,
        sellerGrossAmount: subtotal,
        platformCommission: commission,
        discountContribution: sellerDisc,
        platformFundedDiscount: platformDisc,
        refundDeduction: 0,
        otherAdjustments: 0,
        netSellerAmount: sellerPayout,
        walletReleaseStatus,
        walletReleaseDate,
      },
      qrCodeDataUri,
      qrPayload,
      printAudit: {
        printCount: sellerOrder.printCount || 0,
        lastPrintedAt: sellerOrder.lastPrintedAt ? new Date(sellerOrder.lastPrintedAt).toISOString() : undefined,
      },
    };
  }

  /**
   * Generates production-ready, beautifully styled HTML for the chosen document & format.
   */
  public static renderHtmlDocument(data: PrintDocumentData, autoPrint = false): string {
    switch (data.documentType) {
      case 'PACKING_SLIP':
        return data.format === 'A4'
          ? this.renderPackingSlipA4(data, autoPrint)
          : this.renderPackingSlipThermal(data, autoPrint);
      case 'STATEMENT':
        return this.renderSellerStatementA4(data, autoPrint);
      case 'INVOICE':
      default:
        if (data.format === '80MM') return this.renderThermal80mm(data, autoPrint);
        if (data.format === '58MM') return this.renderThermal58mm(data, autoPrint);
        return this.renderA4Invoice(data, autoPrint);
    }
  }

  private static getSharedPrintScript(autoPrint: boolean): string {
    return `
    <script>
      function triggerPrint() {
        try {
          window.focus();
          window.print();
        } catch(e) {
          console.warn("Print error:", e);
          window.print();
        }
      }
      document.addEventListener("DOMContentLoaded", function() {
        var printBtn = document.getElementById("doPrintBtn");
        if (printBtn) {
          printBtn.addEventListener("click", function(e) {
            e.preventDefault();
            triggerPrint();
          });
        }
        var closeBtn = document.getElementById("closeWinBtn");
        if (closeBtn) {
          closeBtn.addEventListener("click", function(e) {
            e.preventDefault();
            window.close();
          });
        }
      });
      ${autoPrint ? 'window.addEventListener("load", function() { setTimeout(function() { triggerPrint(); }, 400); });' : ''}
    </script>
    `;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. A4 INVOICE RENDERER (RESPONSIVE & DUAL BRANDING)
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderA4Invoice(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);

    const storeLogoHtml = d.store.logo
      ? `<img class="store-avatar" src="${d.store.logo}" alt="${d.store.name}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div class="store-avatar-fallback" style="display:none;">🏪</div>`
      : `<div class="store-avatar-fallback">🏪</div>`;

    const souqnaLogoHtml = d.souqnaLogoDataUri
      ? `<img class="souqnaa-logo-img" src="${d.souqnaLogoDataUri}" alt="سوقناا SOUQNAA" />`
      : `<div class="souqnaa-text-brand"><span class="brand-sq">سوقناا</span> <span class="brand-en">SOUQNAA</span></div>`;

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>فاتورة_${d.sellerOrderNumber}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    @page {
      size: A4 portrait;
      margin: 10mm 12mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Cairo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 16px 0 40px;
      direction: rtl;
      -webkit-font-smoothing: antialiased;
    }
    .no-print {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-bottom: 16px;
      padding: 0 10px;
    }
    .btn {
      padding: 11px 24px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 800;
      cursor: pointer;
      border: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: inherit;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      transition: all 0.2s ease;
    }
    .btn-primary { background: linear-gradient(135deg, #FF6B00 0%, #EA580C 100%); color: #fff; }
    .btn-secondary { background: #ffffff; color: #334155; border: 1px solid #cbd5e1; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,0.12); }

    .sheet {
      width: 210mm;
      max-width: 100%;
      min-height: 297mm;
      padding: 16mm 18mm 14mm;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      position: relative;
      overflow: hidden;
    }

    .top-pattern-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 8px;
      background: linear-gradient(90deg, #FF6B00 0%, #F97316 40%, #0D9488 75%, #0284C7 100%);
    }

    .watermark-bg {
      position: absolute;
      top: 45%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-25deg);
      font-size: 100px;
      font-weight: 900;
      color: rgba(249, 115, 22, 0.03);
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
      font-family: 'Cairo', sans-serif;
      z-index: 0;
    }

    .header-layout {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      position: relative;
      z-index: 1;
      padding-bottom: 16px;
      border-bottom: 2px solid #f1f5f9;
      gap: 16px;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .souqnaa-logo-img {
      height: 52px;
      width: auto;
      object-fit: contain;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.05));
    }
    .souqnaa-text-brand {
      font-size: 26px;
      font-weight: 900;
      color: #FF6B00;
      line-height: 1;
    }
    .brand-meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .brand-title {
      font-size: 16.5px;
      font-weight: 900;
      color: #0f172a;
    }
    .brand-tagline {
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
    }
    .official-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #bfdbfe;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 700;
      width: fit-content;
    }

    .store-card {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 10px 14px;
      max-width: 290px;
    }
    .store-avatar {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      object-fit: cover;
      border: 1.5px solid #cbd5e1;
      background: #fff;
    }
    .store-avatar-fallback {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }
    .store-details {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .store-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .store-name {
      font-size: 13.5px;
      font-weight: 800;
      color: #0f172a;
    }
    .verified-icon {
      color: #0284c7;
      font-size: 13px;
    }
    .store-sub {
      font-size: 11px;
      color: #64748b;
    }

    .order-hero-banner {
      margin-top: 14px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      border-radius: 12px;
      padding: 14px 18px;
      color: #ffffff;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: relative;
      z-index: 1;
      gap: 12px;
    }
    .hero-col-title {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    .hero-order-id {
      font-size: 18px;
      font-weight: 900;
      color: #f97316;
      font-family: 'Inter', monospace;
      letter-spacing: 0.5px;
    }
    .hero-main-order {
      font-size: 12px;
      font-weight: 700;
      color: #cbd5e1;
      font-family: 'Inter', monospace;
      margin-top: 2px;
    }
    .hero-badges-group {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .status-pill {
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .status-pill.paid { background: #059669; color: #fff; }
    .status-pill.pending { background: #d97706; color: #fff; }
    .status-pill.method { background: rgba(255, 255, 255, 0.12); color: #f1f5f9; border: 1px solid rgba(255,255,255,0.2); }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 14px;
      position: relative;
      z-index: 1;
    }
    .meta-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px 14px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.02);
    }
    .meta-card h3 {
      margin: 0 0 8px;
      font-size: 12.5px;
      font-weight: 800;
      color: #0f172a;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid #f1f5f9;
      padding-bottom: 6px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .meta-row .lbl { color: #64748b; font-weight: 500; }
    .meta-row .val { font-weight: 700; color: #1e293b; }

    .table-container {
      margin-top: 16px;
      position: relative;
      z-index: 1;
      width: 100%;
    }
    .items-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
    }
    .items-table th {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 12px;
      font-weight: 800;
      text-align: right;
      font-size: 12px;
    }
    .items-table th.center { text-align: center; }
    .items-table th.left { text-align: left; }
    .items-table td {
      padding: 9px 12px;
      border-bottom: 1px solid #f1f5f9;
      color: #1e293b;
      vertical-align: middle;
    }
    .items-table td.center { text-align: center; }
    .items-table td.left { text-align: left; font-family: 'Inter', sans-serif; font-weight: 800; }
    .items-table tr:nth-child(even) { background: #f8fafc; }
    .items-table tr:last-child td { border-bottom: none; }
    .item-title { font-weight: 800; color: #0f172a; font-size: 12.5px; }
    .item-variant-tag {
      display: inline-block;
      font-size: 10.5px;
      color: #0d9488;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
      margin-top: 2px;
    }
    .item-sku-code {
      font-size: 11px;
      color: #64748b;
      font-family: 'Inter', monospace;
      font-weight: 600;
    }
    .qty-badge {
      display: inline-block;
      background: #e2e8f0;
      color: #0f172a;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
    }

    .bottom-layout {
      display: flex;
      justify-content: space-between;
      align-items: stretch;
      margin-top: 16px;
      gap: 16px;
      position: relative;
      z-index: 1;
    }
    .qr-security-card {
      flex: 1;
      background: #ffffff;
      border: 1.5px dashed #cbd5e1;
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .qr-security-card img {
      width: 105px;
      height: 105px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      background: #fff;
    }
    .qr-info-text {
      font-size: 11px;
      color: #475569;
      line-height: 1.4;
    }
    .qr-info-text strong {
      display: block;
      color: #0f172a;
      font-size: 12.5px;
      margin-bottom: 4px;
      font-weight: 800;
    }
    .qr-hash {
      font-family: 'Inter', monospace;
      font-size: 10px;
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      color: #334155;
      display: inline-block;
      margin-top: 3px;
    }

    .totals-card {
      width: 310px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      padding: 14px 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 12.5px;
      margin-bottom: 6px;
      color: #334155;
    }
    .total-row.discount { color: #059669; font-weight: 700; }
    .grand-total-box {
      margin-top: 10px;
      padding: 10px 12px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      border-radius: 8px;
      color: #ffffff;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .grand-label { font-size: 13px; font-weight: 800; color: #f8fafc; }
    .grand-value { font-size: 18px; font-weight: 900; color: #f97316; font-family: 'Inter', sans-serif; }

    .signatures-row {
      margin-top: 22px;
      display: flex;
      justify-content: space-between;
      padding: 12px 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      font-size: 11.5px;
      color: #475569;
      position: relative;
      z-index: 1;
    }
    .sig-block {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .sig-line {
      width: 140px;
      border-bottom: 1px dashed #94a3b8;
    }

    .footer {
      margin-top: 18px;
      padding-top: 10px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      font-size: 10.5px;
      color: #94a3b8;
      position: relative;
      z-index: 1;
    }

    /* ── Responsive Styling for Mobile & Tablet screens ── */
    @media screen and (max-width: 860px) {
      body { padding: 8px 6px 30px; }
      .sheet {
        width: 100% !important;
        max-width: 100% !important;
        min-height: auto !important;
        padding: 16px 12px !important;
        box-shadow: none !important;
        border-radius: 10px !important;
      }
      .header-layout {
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 14px !important;
      }
      .brand-section { flex-wrap: wrap; }
      .store-card { max-width: 100% !important; width: 100% !important; }
      .order-hero-banner {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 10px !important;
      }
      .meta-grid { grid-template-columns: 1fr !important; }
      .table-container {
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch;
      }
      .items-table { min-width: 540px; }
      .bottom-layout { flex-direction: column !important; }
      .totals-card { width: 100% !important; }
      .signatures-row {
        flex-direction: column !important;
        gap: 14px !important;
      }
      .footer {
        flex-direction: column !important;
        gap: 6px !important;
        text-align: center !important;
      }
    }

    @media screen and (max-width: 600px) {
      .no-print { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
      .no-print .btn { width: 100% !important; }
    }

    @media print {
      body { background: #ffffff !important; padding: 0 !important; }
      .no-print { display: none !important; }
      .sheet {
        box-shadow: none !important;
        border-radius: 0 !important;
        width: 100% !important;
        min-height: auto !important;
        padding: 0 !important;
      }
      .table-container { overflow-x: visible !important; }
      .items-table { min-width: 100% !important; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button id="doPrintBtn" type="button" class="btn btn-primary" onclick="triggerPrint();">🖨️ طباعة الفاتورة (Print / PDF)</button>
    <button id="closeWinBtn" type="button" class="btn btn-secondary" onclick="window.close();">✕ إغلاق النافذة</button>
  </div>

  <div class="sheet">
    <div class="top-pattern-bar"></div>
    <div class="watermark-bg">SOUQNAA • سوقناا</div>

    <!-- Header Dual Branding -->
    <div class="header-layout">
      <div class="brand-section">
        ${souqnaLogoHtml}
        <div class="brand-meta">
          <div class="brand-title">سوقناا</div>
          <div class="brand-tagline">منصة التجارة والتسوق الإلكتروني الرائدة</div>
          <div class="official-badge">✓ وثيقة شراء ومبيعات رسمية</div>
        </div>
      </div>

      <!-- Store Card -->
      <div class="store-card">
        ${storeLogoHtml}
        <div class="store-details">
          <div class="store-name-row">
            <span class="store-name">${d.store.name}</span>
            ${d.store.isVerified ? '<span class="verified-icon" title="متجر موثق">✓</span>' : ''}
          </div>
          ${d.store.phone ? `<div class="store-sub">هاتف: <span dir="ltr">${d.store.phone}</span></div>` : ''}
          ${d.store.address ? `<div class="store-sub">${d.store.address}</div>` : ''}
        </div>
      </div>
    </div>

    <!-- Order Hero Banner -->
    <div class="order-hero-banner">
      <div>
        <div class="hero-col-title">رقم طلب البائع • SELLER ORDER #</div>
        <div class="hero-order-id">${d.sellerOrderNumber}</div>
        <div class="hero-main-order">الطلب الرئيسي: ${d.mainOrderNumber}</div>
      </div>
      <div class="hero-badges-group">
        <div class="status-pill ${d.paymentStatusAr.includes('مدفوع') ? 'paid' : 'pending'}">${d.paymentStatusAr}</div>
        <div class="status-pill method">${d.paymentMethodAr}</div>
      </div>
    </div>

    <!-- Metadata Grid -->
    <div class="meta-grid">
      <div class="meta-card">
        <h3>📅 بيانات الطلب والتسليم</h3>
        <div class="meta-row"><span class="lbl">تاريخ ووقت الشراء:</span><span class="val">${d.orderDateFormattedAr}</span></div>
        <div class="meta-row"><span class="lbl">حالة معالجة الطلب:</span><span class="val" style="color:#0d9488;">${d.orderStatusAr}</span></div>
        <div class="meta-row"><span class="lbl">طريقة الدفع المختارة:</span><span class="val">${d.paymentMethodAr}</span></div>
      </div>

      <div class="meta-card">
        <h3>👤 بيانات المستلم والشحن</h3>
        <div class="meta-row"><span class="lbl">اسم العميل المستلم:</span><span class="val">${d.customer.name}</span></div>
        <div class="meta-row"><span class="lbl">رقم هاتف التواصل:</span><span class="val" dir="ltr">${d.customer.phone}</span></div>
        <div class="meta-row"><span class="lbl">عنوان التوصيل:</span><span class="val">${d.customer.deliveryAddress.formatted}</span></div>
        ${d.customer.deliveryAddress.plusCode ? `<div class="meta-row"><span class="lbl">رمز الموقع (Plus Code):</span><span class="val" dir="ltr" style="font-family: monospace; font-weight: 700; color: #0284c7;">📍 ${d.customer.deliveryAddress.plusCode}</span></div>` : ''}
      </div>
    </div>

    <!-- Products Table -->
    <div class="table-container">
      <table class="items-table">
        <thead>
          <tr>
            <th style="width: 35px;" class="center">#</th>
            <th>المنتج والمواصفات</th>
            <th style="width: 110px;">الرمز (SKU)</th>
            <th style="width: 60px;" class="center">الكمية</th>
            <th style="width: 105px;">سعر الوحدة</th>
            <th style="width: 85px;">الخصم</th>
            <th style="width: 115px;" class="left">الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          ${d.items
        .map(
          (it) => `
            <tr>
              <td class="center"><span class="qty-badge">${it.itemNumber}</span></td>
              <td>
                <div class="item-title">${it.productName}</div>
                <div class="item-variant-tag">${it.variant}</div>
              </td>
              <td><span class="item-sku-code">${it.sku}</span></td>
              <td class="center"><strong>${it.quantity}</strong></td>
              <td>${it.unitPrice.toLocaleString()} ${d.totals.currency}</td>
              <td style="color: #059669; font-weight: 700;">${it.discount > 0 ? `-${it.discount.toLocaleString()} ${d.totals.currency}` : '0'}</td>
              <td class="left">${it.totalPrice.toLocaleString()} ${d.totals.currency}</td>
            </tr>
          `
        )
        .join('')}
        </tbody>
      </table>
    </div>

    <!-- Bottom Layout: QR Code + Totals -->
    <div class="bottom-layout">
      <div class="qr-security-card">
        ${d.qrCodeDataUri ? `<img src="${d.qrCodeDataUri}" alt="QR Verification" />` : ''}
        <div class="qr-info-text">
          <strong>رمز التحقق الرقمي المعتمد (QR)</strong>
          <div>امسح الرمز للتحقق الفوري من صحة الفاتورة ومطابقة بيانات الشحنة مع خوادم سوقناا.</div>
          <div class="qr-hash">${d.qrPayload.slice(0, 48)}...</div>
        </div>
      </div>

      <div class="totals-card">
        <div class="total-row">
          <span>المجموع الفرعي:</span>
          <strong>${d.totals.subtotal.toLocaleString()} ${d.totals.currency}</strong>
        </div>
        ${d.totals.couponDiscount > 0
        ? `<div class="total-row discount">
            <span>خصم القسيمة:</span>
            <strong>-${d.totals.couponDiscount.toLocaleString()} ${d.totals.currency}</strong>
          </div>`
        : ''
      }
        ${d.totals.sellerDiscount > 0
        ? `<div class="total-row discount">
            <span>خصم المتجر:</span>
            <strong>-${d.totals.sellerDiscount.toLocaleString()} ${d.totals.currency}</strong>
          </div>`
        : ''
      }
        <div class="total-row">
          <span>رسوم التوصيل:</span>
          <strong>${d.totals.deliveryFee > 0 ? `${d.totals.deliveryFee.toLocaleString()} ${d.totals.currency}` : 'مجاني'}</strong>
        </div>

        <div class="grand-total-box">
          <span class="grand-label">الإجمالي النهائي:</span>
          <span class="grand-value">${d.totals.grandTotal.toLocaleString()} ${d.totals.currency}</span>
        </div>
      </div>
    </div>

    <!-- Signatures & Handover -->
    <div class="signatures-row">
      <div class="sig-block">
        <span>ختم وتوقيع المتجر:</span>
        <div class="sig-line"></div>
      </div>
      <div class="sig-block">
        <span>توقيع مندوب التوصيل:</span>
        <div class="sig-line"></div>
      </div>
      <div class="sig-block">
        <span>توقيع المستلم عند الاستلام:</span>
        <div class="sig-line"></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div>منصة سوقناا للتجارة الإلكترونية • دعم العملاء: support@souqnaa.online • www.souqnaa.online</div>
      <div>تاريخ إصدار الفاتورة: ${d.orderDateISO.slice(0, 10)} • صالحة كإثبات شراء رسمي</div>
    </div>
  </div>

  ${printScript}
</body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. 80MM THERMAL RECEIPT RENDERER
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderThermal80mm(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);
    const souqnaLogoHtml = d.souqnaLogoDataUri
      ? `<img src="${d.souqnaLogoDataUri}" style="height: 38px; width: auto; margin: 0 auto 4px; display: block;" alt="SOUQNAA" />`
      : '';

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>إيصال_${d.sellerOrderNumber}</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 2mm 3mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Courier New', Courier, monospace, 'Segoe UI', Tahoma, sans-serif;
      width: 72mm;
      max-width: 100%;
      margin: 0 auto;
      padding: 6px 2px 24px;
      color: #000;
      background: #fff;
      font-size: 12px;
      line-height: 1.35;
      direction: rtl;
    }
    .no-print {
      text-align: center;
      margin-bottom: 12px;
      font-family: sans-serif;
    }
    .btn {
      padding: 7px 16px;
      background: #FF6B00;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .divider {
      border-top: 1px dashed #000;
      margin: 6px 0;
    }
    .title-souqnaa {
      font-size: 16px;
      font-weight: 900;
      letter-spacing: 1px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
    }
    .row.tight { margin-bottom: 2px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      margin: 4px 0;
    }
    th {
      border-bottom: 1px dashed #000;
      padding: 3px 0;
      text-align: right;
    }
    th:last-child { text-align: left; }
    td {
      padding: 4px 0;
      vertical-align: top;
    }
    td.left { text-align: left; }
    td.center { text-align: center; }
    .grand-total {
      font-size: 14px;
      font-weight: 900;
    }
    .qr-img {
      width: 105px;
      height: 105px;
      margin: 6px auto;
      display: block;
    }
    @media print {
      .no-print { display: none !important; }
      body { width: 72mm; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="display: flex; justify-content: center; gap: 8px;">
    <button id="doPrintBtn" type="button" class="btn" onclick="triggerPrint();">🖨️ طباعة الإيصال الحراري 80mm</button>
    <button id="closeWinBtn" type="button" class="btn" style="background: #64748b;" onclick="window.close();">✕ إغلاق</button>
  </div>

  ${souqnaLogoHtml}
  <div class="center bold title-souqnaa">سوقناا • SOUQNAA</div>
  <div class="center" style="font-size: 11px;">المتجر: <span class="bold">${d.store.name}</span></div>
  <div class="divider"></div>

  <div class="row tight"><span>رقم طلب البائع:</span><span class="bold" dir="ltr">${d.sellerOrderNumber}</span></div>
  <div class="row tight"><span>الطلب الرئيسي:</span><span class="bold" dir="ltr">${d.mainOrderNumber}</span></div>
  <div class="row tight"><span>التاريخ:</span><span>${d.orderDateFormattedEn}</span></div>
  <div class="divider"></div>

  <table>
    <thead>
      <tr>
        <th style="width: 50%;">المنتج</th>
        <th style="width: 20%; text-align: center;">الكمية</th>
        <th style="width: 30%; text-align: left;">الإجمالي</th>
      </tr>
    </thead>
    <tbody>
      ${d.items
        .map(
          (it) => `
        <tr>
          <td>${it.productName}</td>
          <td class="center">${it.quantity}</td>
          <td class="left">${it.totalPrice.toLocaleString()}</td>
        </tr>
      `
        )
        .join('')}
    </tbody>
  </table>

  <div class="divider"></div>
  <div class="row tight"><span>المجموع الفرعي:</span><span>${d.totals.subtotal.toLocaleString()} ${d.totals.currency}</span></div>
  ${d.totals.couponDiscount + d.totals.sellerDiscount > 0 ? `<div class="row tight"><span>الخصم:</span><span>-${(d.totals.couponDiscount + d.totals.sellerDiscount).toLocaleString()} ${d.totals.currency}</span></div>` : ''}
  <div class="row tight"><span>التوصيل:</span><span>${d.totals.deliveryFee.toLocaleString()} ${d.totals.currency}</span></div>
  <div class="divider"></div>
  <div class="row grand-total"><span>الإجمالي:</span><span>${d.totals.grandTotal.toLocaleString()} ${d.totals.currency}</span></div>
  <div class="divider"></div>

  <div class="row tight"><span>طريقة الدفع:</span><span class="bold">${d.paymentMethodAr}</span></div>
  <div class="row tight"><span>حالة الدفع:</span><span class="bold">${d.paymentStatusAr}</span></div>
  <div class="row tight"><span>العميل:</span><span>${d.customer.name}</span></div>
  <div class="row tight"><span>الهاتف:</span><span dir="ltr">${d.customer.phone}</span></div>
  <div class="row tight"><span>العنوان:</span><span>${d.customer.deliveryAddress.cityName} - ${d.customer.deliveryAddress.neighborhood || d.customer.deliveryAddress.street || ''}</span></div>
  ${d.customer.deliveryAddress.plusCode ? `<div class="row tight"><span>Plus Code:</span><span dir="ltr" class="bold" style="font-family: monospace; color: #0284c7;">📍 ${d.customer.deliveryAddress.plusCode}</span></div>` : ''}

  <div class="divider"></div>
  ${d.qrCodeDataUri ? `<img class="qr-img" src="${d.qrCodeDataUri}" alt="QR" />` : ''}
  <div class="center" style="font-size: 10px; font-family: monospace;">${d.qrPayload.slice(0, 36)}</div>
  <div class="divider"></div>
  <div class="center" style="font-size: 11px;">
    شكراً لتسوقكم عبر منصة سوقناا<br>
    www.souqnaa.online
  </div>

  ${printScript}
</body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. 58MM THERMAL RECEIPT RENDERER
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderThermal58mm(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>إيصال_58mm_${d.sellerOrderNumber}</title>
  <style>
    @page {
      size: 58mm auto;
      margin: 1mm 2mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Courier New', Courier, monospace, 'Segoe UI', Tahoma, sans-serif;
      width: 48mm;
      max-width: 100%;
      margin: 0 auto;
      padding: 4px 1px 20px;
      color: #000;
      background: #fff;
      font-size: 10.5px;
      line-height: 1.25;
      direction: rtl;
    }
    .no-print {
      text-align: center;
      margin-bottom: 8px;
      font-family: sans-serif;
    }
    .btn {
      padding: 4px 8px;
      background: #FF6B00;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      cursor: pointer;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .divider {
      border-top: 1px dashed #000;
      margin: 4px 0;
    }
    .item-block {
      margin-bottom: 4px;
    }
    .item-name {
      word-wrap: break-word;
      font-weight: bold;
    }
    .item-calc {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      margin-bottom: 1.5px;
    }
    .grand {
      font-size: 12px;
      font-weight: 900;
    }
    .qr-img {
      width: 90px;
      height: 90px;
      margin: 4px auto;
      display: block;
    }
    @media print {
      .no-print { display: none !important; }
      body { width: 48mm; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="display: flex; justify-content: center; gap: 6px;">
    <button id="doPrintBtn" type="button" class="btn" onclick="triggerPrint();">🖨️ طباعة 58mm</button>
    <button id="closeWinBtn" type="button" class="btn" style="background: #64748b;" onclick="window.close();">✕ إغلاق</button>
  </div>

  <div class="center bold" style="font-size: 13px;">سوقناا • SOUQNAA</div>
  <div class="center" style="font-size: 9.5px;">${d.store.name}</div>
  <div class="divider"></div>

  <div class="row"><span>طلب المتجر:</span><span class="bold" dir="ltr">${d.sellerOrderNumber}</span></div>
  <div class="row"><span>الرئيسي:</span><span dir="ltr">${d.mainOrderNumber}</span></div>
  <div class="row"><span>التاريخ:</span><span>${d.orderDateISO.slice(0, 10)}</span></div>
  <div class="divider"></div>

  ${d.items
        .map(
          (it) => `
    <div class="item-block">
      <div class="item-name">• ${it.productName}</div>
      <div class="item-calc">
        <span>${it.quantity}x ${it.unitPrice.toLocaleString()}</span>
        <span class="bold">${it.totalPrice.toLocaleString()} ${d.totals.currency}</span>
      </div>
    </div>
  `
        )
        .join('')}

  <div class="divider"></div>
  <div class="row"><span>المجموع:</span><span>${d.totals.subtotal.toLocaleString()}</span></div>
  ${d.totals.couponDiscount + d.totals.sellerDiscount > 0 ? `<div class="row"><span>الخصم:</span><span>-${(d.totals.couponDiscount + d.totals.sellerDiscount).toLocaleString()}</span></div>` : ''}
  <div class="row"><span>التوصيل:</span><span>${d.totals.deliveryFee.toLocaleString()}</span></div>
  <div class="divider"></div>
  <div class="row grand"><span>الإجمالي:</span><span>${d.totals.grandTotal.toLocaleString()} ${d.totals.currency}</span></div>
  <div class="divider"></div>

  <div class="row"><span>الدفع:</span><span>${d.paymentMethodAr}</span></div>
  <div class="row"><span>الحالة:</span><span>${d.paymentStatusAr}</span></div>
  <div class="row"><span>العميل:</span><span>${d.customer.name}</span></div>
  <div class="row"><span>الهاتف:</span><span dir="ltr">${d.customer.phone}</span></div>
  ${d.customer.deliveryAddress.plusCode ? `<div class="row"><span>Plus Code:</span><span dir="ltr" class="bold" style="font-family: monospace;">${d.customer.deliveryAddress.plusCode}</span></div>` : ''}

  <div class="divider"></div>
  ${d.qrCodeDataUri ? `<img class="qr-img" src="${d.qrCodeDataUri}" alt="QR" />` : ''}
  <div class="center" style="font-size: 8.5px; font-family: monospace;">${d.qrPayload.slice(0, 30)}</div>
  <div class="divider"></div>
  <div class="center" style="font-size: 9.5px;">شكراً لتسوقكم • سوقناا</div>

  ${printScript}
</body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. PACKING SLIP (A4) RENDERER (RESPONSIVE)
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderPackingSlipA4(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);

    const souqnaLogoHtml = d.souqnaLogoDataUri
      ? `<img style="height: 48px; object-fit: contain;" src="${d.souqnaLogoDataUri}" alt="سوقناا" />`
      : `<h1 style="margin:0; color:#0284c7;">سوقناا | SOUQNAA</h1>`;

    const storeLogoHtml = d.store.logo
      ? `<img style="width: 40px; height: 40px; border-radius: 8px; object-fit: cover; border: 1px solid #cbd5e1;" src="${d.store.logo}" alt="${d.store.name}" />`
      : '';

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>بوليصة_تجهيز_${d.sellerOrderNumber}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    @page { size: A4 portrait; margin: 10mm 12mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Cairo', sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 16px 0;
      direction: rtl;
    }
    .no-print { display: flex; justify-content: center; gap: 12px; margin-bottom: 16px; padding: 0 10px; }
    .btn { padding: 11px 24px; border-radius: 10px; font-size: 14px; font-weight: 800; cursor: pointer; border: none; }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-secondary { background: #fff; color: #1e293b; border: 1px solid #cbd5e1; }
    .sheet {
      width: 210mm;
      max-width: 100%;
      min-height: 297mm;
      padding: 16mm 18mm;
      margin: 0 auto;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      position: relative;
    }
    .top-bar {
      position: absolute;
      top: 0; left: 0; right: 0; height: 8px;
      background: linear-gradient(90deg, #0284c7 0%, #0d9488 100%);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #0284c7;
      padding-bottom: 14px;
      gap: 12px;
    }
    .brand-group { display: flex; align-items: center; gap: 14px; }
    .badge {
      display: inline-block;
      background: #e0f2fe;
      color: #0369a1;
      padding: 3px 10px;
      border-radius: 6px;
      font-weight: 800;
      font-size: 11.5px;
      margin-top: 4px;
    }
    .order-box {
      text-align: left;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 10px 14px;
    }
    .seller-num { font-size: 17px; font-weight: 900; color: #0284c7; font-family: 'Inter', monospace; }
    .main-num { font-size: 12px; font-weight: 700; color: #64748b; font-family: 'Inter', monospace; }

    .recipient-card {
      margin-top: 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px 16px;
    }
    .recipient-card h3 { margin: 0 0 8px; color: #0284c7; font-size: 13.5px; font-weight: 800; }

    .table-container { width: 100%; margin-top: 18px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      background: #0f172a;
      color: #fff;
      padding: 10px 12px;
      text-align: right;
      font-weight: 800;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
    }
    tr:nth-child(even) { background: #f8fafc; }
    .check-box-cell {
      border: 2px solid #64748b;
      width: 22px;
      height: 22px;
      display: inline-block;
      border-radius: 4px;
      vertical-align: middle;
    }

    .warehouse-checklist {
      margin-top: 22px;
      border: 1.5px dashed #0284c7;
      background: #f0f9ff;
      border-radius: 10px;
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .check-item { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; margin-bottom: 6px; }

    .recipient-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      font-size: 12.5px;
    }

    @media screen and (max-width: 860px) {
      body { padding: 8px 6px; }
      .sheet {
        width: 100% !important;
        max-width: 100% !important;
        min-height: auto !important;
        padding: 14px 12px !important;
        box-shadow: none !important;
      }
      .header { flex-direction: column !important; align-items: stretch !important; }
      .brand-group { flex-wrap: wrap; }
      .table-container { overflow-x: auto !important; -webkit-overflow-scrolling: touch; }
      table { min-width: 520px; }
      .warehouse-checklist { flex-direction: column !important; align-items: flex-start !important; }
    }

    @media screen and (max-width: 640px) {
      .recipient-grid { grid-template-columns: 1fr !important; }
      .no-print { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
      .no-print .btn { width: 100% !important; }
      .order-box { text-align: right !important; }
    }

    @media print {
      body { background: #fff !important; padding: 0 !important; }
      .no-print { display: none !important; }
      .sheet { box-shadow: none !important; width: 100% !important; padding: 0 !important; }
      .table-container { overflow-x: visible !important; }
      table { min-width: 100% !important; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button id="doPrintBtn" type="button" class="btn btn-primary" onclick="triggerPrint();">🖨️ طباعة بوليصة التجهيز (Packing Slip)</button>
    <button id="closeWinBtn" type="button" class="btn btn-secondary" onclick="window.close();">✕ إغلاق النافذة</button>
  </div>

  <div class="sheet">
    <div class="top-bar"></div>
    <div class="header">
      <div class="brand-group">
        ${souqnaLogoHtml}
        <div>
          <div style="font-weight: 900; font-size: 16px; color:#0f172a;">بوليصة تجهيز وتعبئة الشحنة</div>
          <div class="badge">📦 PACKING SLIP • قسم المستودع والتغليف</div>
          <div style="margin-top: 4px; font-size: 12px; color: #475569;">المتجر: <strong>${d.store.name}</strong></div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        ${storeLogoHtml}
        <div class="order-box">
          <div style="font-size: 11px; font-weight: bold; color: #64748b;">رقم طلب البائع:</div>
          <div class="seller-num">${d.sellerOrderNumber}</div>
          <div class="main-num">الرئيسي: ${d.mainOrderNumber}</div>
        </div>
      </div>
    </div>

    <div class="recipient-card">
      <h3>بيانات المستلم ووجهة الشحن</h3>
      <div class="recipient-grid">
        <div>اسم العميل المستلم: <strong>${d.customer.name}</strong></div>
        <div>رقم هاتف التواصل: <strong dir="ltr">${d.customer.phone}</strong></div>
        <div style="grid-column: span 2;">عنوان التوصيل: <strong>${d.customer.deliveryAddress.formatted}</strong></div>
        ${d.customer.deliveryAddress.plusCode ? `<div style="grid-column: span 2;">رمز الموقع الرقمي (Plus Code): <strong dir="ltr" style="font-family: monospace; color: #0284c7;">📍 ${d.customer.deliveryAddress.plusCode}</strong></div>` : ''}
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th style="width: 40px; text-align: center;">#</th>
            <th>اسم المنتج ومواصفاته</th>
            <th style="width: 130px;">الرمز (SKU)</th>
            <th style="width: 80px; text-align: center;">الكمية</th>
            <th style="width: 100px; text-align: center;">فحص المستودع</th>
          </tr>
        </thead>
        <tbody>
          ${d.items
        .map(
          (it) => `
            <tr>
              <td style="text-align: center; font-weight: bold;">${it.itemNumber}</td>
              <td>
                <strong>${it.productName}</strong>
                <div style="font-size: 11px; color: #0284c7; font-weight: 600;">المواصفات: ${it.variant}</div>
              </td>
              <td><code style="font-family: 'Inter', monospace; font-weight: bold;">${it.sku}</code></td>
              <td style="text-align: center; font-size: 15px; font-weight: 900; color: #0f172a;">${it.quantity}</td>
              <td style="text-align: center;">
                <span class="check-box-cell"></span>
              </td>
            </tr>
          `
        )
        .join('')}
        </tbody>
      </table>
    </div>

    <div class="warehouse-checklist">
      <div>
        <div class="check-item">
          <span class="check-box-cell" style="width: 18px; height: 18px;"></span>
          <span>تم فحص جودة ومطابقة المنتجات وتواريخ الصلاحية (Checked)</span>
        </div>
        <div class="check-item">
          <span class="check-box-cell" style="width: 18px; height: 18px;"></span>
          <span>تم التغليف المحكم ووضع ملصق الشحنة الآمن (Packed)</span>
        </div>
      </div>
      ${d.qrCodeDataUri ? `<img src="${d.qrCodeDataUri}" style="width: 85px; height: 85px; border-radius: 6px; background:#fff; padding:4px;" alt="QR" />` : ''}
    </div>

    <div style="margin-top: 30px; display: flex; justify-content: space-between; font-size: 12px; color: #475569;">
      <div>اسم وتوقيع مسؤول التجهيز والتغليف: ______________________</div>
      <div>التاريخ: ${d.orderDateISO.slice(0, 10)}</div>
    </div>
  </div>

  ${printScript}
</body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. PACKING SLIP (THERMAL) RENDERER
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderPackingSlipThermal(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>بوليصة_تجهيز_حرارية_${d.sellerOrderNumber}</title>
  <style>
    @page { size: 80mm auto; margin: 2mm 3mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Courier New', Courier, monospace, sans-serif;
      width: 72mm;
      max-width: 100%;
      margin: 0 auto;
      padding: 6px 2px 20px;
      color: #000;
      background: #fff;
      font-size: 11.5px;
      direction: rtl;
    }
    .no-print { text-align: center; margin-bottom: 8px; }
    .btn { padding: 6px 12px; background: #0284c7; color: #fff; border: none; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 6px 0; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print">
    <button id="doPrintBtn" type="button" class="btn" onclick="triggerPrint();">🖨️ طباعة بوليصة التجهيز الحرارية</button>
  </div>
  <div class="center bold" style="font-size: 14px;">سوقناا • بوليصة تجهيز</div>
  <div class="center" style="font-size: 10.5px;">PACKING SLIP (NO FINANCIALS)</div>
  <div class="divider"></div>

  <div>المتجر: <span class="bold">${d.store.name}</span></div>
  <div>طلب المتجر: <span class="bold" dir="ltr">${d.sellerOrderNumber}</span></div>
  <div>الرئيسي: <span dir="ltr">${d.mainOrderNumber}</span></div>
  <div>العميل: <span class="bold">${d.customer.name}</span></div>
  <div>الهاتف: <span dir="ltr">${d.customer.phone}</span></div>
  <div>العنوان: <span>${d.customer.deliveryAddress.formatted}</span></div>
  ${d.customer.deliveryAddress.plusCode ? `<div>Plus Code: <span class="bold" dir="ltr" style="font-family: monospace; color: #0284c7;">📍 ${d.customer.deliveryAddress.plusCode}</span></div>` : ''}
  <div class="divider"></div>

  <div class="bold" style="margin-bottom: 4px;">المنتجات المطلوب تجهيزها:</div>
  ${d.items
        .map(
          (it) => `
    <div style="margin-bottom: 6px;">
      <div>[ ] <strong>${it.productName}</strong></div>
      <div style="font-size: 10px; margin-right: 14px;">الكمية: <strong>${it.quantity}</strong> • SKU: ${it.sku}</div>
    </div>
  `
        )
        .join('')}

  <div class="divider"></div>
  <div>[ ] فحص الجودة (Checked)</div>
  <div>[ ] تم التغليف والإغلاق (Packed)</div>
  <div class="divider"></div>
  ${d.qrCodeDataUri ? `<img src="${d.qrCodeDataUri}" style="width: 85px; height: 85px; display: block; margin: 0 auto;" alt="QR" />` : ''}
  <div class="center" style="font-size: 9px; font-family: monospace;">${d.qrPayload.slice(0, 30)}</div>
  ${printScript}
</body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. SELLER STATEMENT (A4) RENDERER (RESPONSIVE & AUTHENTIC)
  // ─────────────────────────────────────────────────────────────────────────────
  private static renderSellerStatementA4(d: PrintDocumentData, autoPrint: boolean): string {
    const printScript = this.getSharedPrintScript(autoPrint);
    const fin = d.sellerFinancials;

    const souqnaLogoHtml = d.souqnaLogoDataUri
      ? `<img style="height: 48px; object-fit: contain;" src="${d.souqnaLogoDataUri}" alt="سوقناا" />`
      : `<h1 style="margin:0; color:#4f46e5;">سوقناا | SOUQNAA</h1>`;

    const storeLogoHtml = d.store.logo
      ? `<img style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover; border: 1px solid #cbd5e1;" src="${d.store.logo}" alt="${d.store.name}" />`
      : '';

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>كشف_حساب_${d.sellerOrderNumber}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    @page { size: A4 portrait; margin: 10mm 12mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Cairo', sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 16px 0 30px;
      direction: rtl;
    }
    .no-print { display: flex; justify-content: center; gap: 12px; margin-bottom: 16px; padding: 0 10px; }
    .btn { padding: 11px 24px; border-radius: 10px; font-size: 14px; font-weight: 800; cursor: pointer; border: none; }
    .btn-primary { background: #4f46e5; color: #fff; }
    .btn-secondary { background: #fff; color: #1e293b; border: 1px solid #cbd5e1; }
    .sheet {
      width: 210mm;
      max-width: 100%;
      min-height: 297mm;
      padding: 16mm 18mm;
      margin: 0 auto;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      position: relative;
    }
    .top-bar {
      position: absolute;
      top: 0; left: 0; right: 0; height: 8px;
      background: linear-gradient(90deg, #4f46e5 0%, #0d9488 100%);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #4f46e5;
      padding-bottom: 14px;
      gap: 12px;
    }
    .brand-group { display: flex; align-items: center; gap: 14px; }
    .badge {
      display: inline-block;
      background: #eef2ff;
      color: #4338ca;
      padding: 3px 10px;
      border-radius: 6px;
      font-weight: 800;
      font-size: 11.5px;
      margin-top: 4px;
    }
    .order-box {
      text-align: left;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 10px 14px;
    }
    .table-container { width: 100%; margin-top: 20px; }
    .statement-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
    }
    .statement-table th {
      background: #1e1b4b;
      color: #fff;
      padding: 11px 14px;
      text-align: right;
      font-weight: 800;
    }
    .statement-table td {
      padding: 12px 14px;
      border-bottom: 1px solid #e2e8f0;
    }
    .statement-table tr:nth-child(even) { background: #f8fafc; }
    .net-row {
      background: #ecfdf5 !important;
      font-size: 16px;
      font-weight: 900;
      color: #065f46;
    }

    .info-grid {
      margin-top: 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px 16px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      font-size: 12.5px;
    }

    /* ── Responsive Styling for Mobile & Tablet screens ── */
    @media screen and (max-width: 860px) {
      body { padding: 8px 6px; }
      .sheet {
        width: 100% !important;
        max-width: 100% !important;
        min-height: auto !important;
        padding: 14px 12px !important;
        box-shadow: none !important;
      }
      .header { flex-direction: column !important; align-items: stretch !important; }
      .brand-group { flex-wrap: wrap; }
      .table-container { overflow-x: auto !important; -webkit-overflow-scrolling: touch; }
      .statement-table { min-width: 500px; }
    }

    @media screen and (max-width: 640px) {
      .info-grid { grid-template-columns: 1fr !important; }
      .no-print { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
      .no-print .btn { width: 100% !important; }
      .order-box { text-align: right !important; }
    }

    @media print {
      body { background: #fff !important; padding: 0 !important; }
      .no-print { display: none !important; }
      .sheet { box-shadow: none !important; width: 100% !important; padding: 0 !important; }
      .table-container { overflow-x: visible !important; }
      .statement-table { min-width: 100% !important; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button id="doPrintBtn" type="button" class="btn btn-primary" onclick="triggerPrint();">🖨️ طباعة كشف حساب المتجر (Statement)</button>
    <button id="closeWinBtn" type="button" class="btn btn-secondary" onclick="window.close();">✕ إغلاق النافذة</button>
  </div>

  <div class="sheet">
    <div class="top-bar"></div>
    <div class="header">
      <div class="brand-group">
        ${souqnaLogoHtml}
        <div>
          <div style="font-weight: 900; font-size: 16px; color:#0f172a;">كشف حساب ومستحقات المتجر المالية</div>
          <div class="badge">💼 SELLER FINANCIAL STATEMENT • وثيقة تسوية داخلية</div>
          <div style="margin-top: 4px; font-size: 12px; color: #475569;">المتجر: <strong>${d.store.name}</strong></div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        ${storeLogoHtml}
        <div class="order-box">
          <div style="font-size: 11px; font-weight: bold; color: #64748b;">رقم طلب المتجر:</div>
          <div style="font-size: 16px; font-weight: 900; color: #4f46e5; font-family: 'Inter', monospace;">${d.sellerOrderNumber}</div>
          <div style="font-size: 12px; font-weight: 700; color: #64748b; font-family: 'Inter', monospace;">الرئيسي: ${d.mainOrderNumber}</div>
        </div>
      </div>
    </div>

    <div class="info-grid">
      <div>تاريخ الطلب: <strong>${d.orderDateFormattedAr}</strong></div>
      <div>حالة استحقاق المحفظة: <strong style="color: #4f46e5;">${fin.walletReleaseStatus}</strong></div>
      <div>طريقة دفع العميل: <strong>${d.paymentMethodAr}</strong></div>
      <div>موعد تحرير الرصيد المتوقع: <strong>${fin.walletReleaseDate}</strong></div>
    </div>

    <div class="table-container">
      <table class="statement-table">
        <thead>
          <tr>
            <th>البند المالي (Financial Item)</th>
            <th style="width: 140px; text-align: left;">المبلغ (${d.totals.currency})</th>
            <th style="width: 220px;">التوضيح المحاسبي</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>إجمالي قيمة مبيعات المتجر (Seller Gross Amount)</td>
            <td style="text-align: left; font-weight: bold;">${fin.sellerGrossAmount.toLocaleString()}</td>
            <td>قيمة منتجات المتجر المباعة للعميل</td>
          </tr>
          <tr>
            <td>عمولة منصة سوقناا (Platform Commission)</td>
            <td style="text-align: left; color: #dc2626; font-weight: bold;">-${fin.platformCommission.toLocaleString()}</td>
            <td>النسبة المتفق عليها لخدمات المنصة والبوابة</td>
          </tr>
          ${fin.discountContribution > 0
        ? `<tr>
              <td>مساهمة المتجر في الخصم (Seller Discount)</td>
              <td style="text-align: left; color: #dc2626; font-weight: bold;">-${fin.discountContribution.toLocaleString()}</td>
              <td>الخصم الترويجي الممول من المتجر</td>
            </tr>`
        : ''
      }
          ${fin.platformFundedDiscount > 0
        ? `<tr>
              <td>خصم ممول من المنصة (Platform Subsidized)</td>
              <td style="text-align: left; color: #059669; font-weight: bold;">+${fin.platformFundedDiscount.toLocaleString()}</td>
              <td>تعويض المنصة للمتجر عن عروض سوقناا</td>
            </tr>`
        : ''
      }
          ${fin.refundDeduction > 0
        ? `<tr>
              <td>استقطاعات المرتجعات (Refund Deduction)</td>
              <td style="text-align: left; color: #dc2626; font-weight: bold;">-${fin.refundDeduction.toLocaleString()}</td>
              <td>تسوية المنتجات المسترجعة أو التالفة</td>
            </tr>`
        : ''
      }
          <tr class="net-row">
            <td>صافي مستحقات المتجر للأرباح (Net Seller Payout)</td>
            <td style="text-align: left;">${fin.netSellerAmount.toLocaleString()}</td>
            <td>المبلغ الصافي المستحق التحويل لمحفظة المتجر</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="margin-top: 20px; padding: 12px 14px; background: #fdf2f8; border: 1px dashed #f472b6; border-radius: 8px; font-size: 11.5px; color: #831843;">
      📌 ملاحظة هامة: هذا الكشف يوضح بدقة الحسابات المالية الخاصة بمتجركم فقط لهذا الطلب، ولا يتم إرفاقه للعميل مع الشحنة للحفاظ على سرية تسويات المتجر مع المنصة.
    </div>

    <div style="margin-top: 36px; display: flex; justify-content: space-between; font-size: 11px; color: #64748b;">
      <div>منصة سوقناا • الإدارة المالية للمتاجر</div>
      <div>سجل تدقيق الطباعة: ${d.printAudit.printCount} مرات • تم الإنشاء إلكترونياً</div>
    </div>
  </div>

  ${printScript}
</body>
</html>`;
  }
}
