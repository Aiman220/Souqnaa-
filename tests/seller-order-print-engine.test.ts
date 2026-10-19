import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SellerOrderPrintService,
  PrintDocumentData,
  PrintDocumentType,
  PrintFormat,
} from '../src/services/orders/seller-order-print.service';
import { StatementExportService } from '../src/modules/statements/statement-export.service';

describe('SOUQNA Universal Seller Order Print & Export Engine', () => {
  const createMockPrintData = (
    docType: PrintDocumentType,
    format: PrintFormat
  ): PrintDocumentData => {
    return {
      documentType: docType,
      format: format,
      title: docType === 'INVOICE' ? 'فاتورة البيع' : (docType === 'PACKING_SLIP' ? 'بوصلة التجهيز' : 'كشف حساب مالي'),
      mainOrderNumber: 'ORD-2026-987654',
      sellerOrderNumber: 'SO-987654-1',
      shortOrderNumber: '987654-1',
      orderDateFormattedAr: '18 أكتوبر 2026، 10:00 ص',
      orderDateFormattedEn: '18 Oct 2026, 10:00 AM',
      orderDateISO: '2026-10-18T10:00:00.000Z',
      paymentMethodAr: 'الدفع عند الاستلام (COD)',
      paymentMethodEn: 'Cash on Delivery (COD)',
      paymentStatusAr: 'معلق',
      paymentStatusEn: 'Pending',
      orderStatusAr: 'تم التجهيز',
      orderStatusEn: 'PROCESSING',
      souqnaLogoDataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      store: {
        name: 'اليمن الحديث للأجهزة',
        phone: '+967-777000111',
        email: 'store@yemenmodern.com',
        address: 'صنعاء - شارع حدة',
        logo: '',
        isVerified: true,
      },
      customer: {
        name: 'محمد أحمد السعيد',
        phone: '+967-777123456',
        deliveryAddress: {
          governorate: 'صنعاء',
          cityName: 'الأمانة',
          neighborhood: 'حدة',
          street: 'شارع حدة الرئيسي',
          buildingNumber: 'عمارة الأمل',
          additionalInfo: 'شقة 4، الدور الثاني',
          formatted: 'صنعاء، الأمانة، حدة، شارع حدة الرئيسي، عمارة الأمل، شقة 4، الدور الثاني',
          plusCode: '7Q3C7777+XX',
        },
      },
      items: [
        {
          itemNumber: 1,
          productId: 'prod-001',
          productName: 'سماعات رأس لاسلكية برو عازلة للضوضاء',
          sku: 'SKU-AUDIO-001',
          variant: 'لون أسود ملكي',
          quantity: 2,
          unitPrice: 25000,
          discount: 0,
          totalPrice: 50000,
        },
        {
          itemNumber: 2,
          productId: 'prod-002',
          productName: 'شاحن سريع 65 واط ثلاثي المنافذ',
          sku: 'SKU-PWR-065',
          variant: 'أبيض',
          quantity: 1,
          unitPrice: 15000,
          discount: 0,
          totalPrice: 15000,
        },
      ],
      totals: {
        subtotal: 65000,
        productDiscounts: 0,
        couponDiscount: 0,
        sellerDiscount: 0,
        deliveryFee: 2500,
        otherFees: 0,
        grandTotal: 67500,
        currency: 'YER',
      },
      sellerFinancials: {
        customerOrderTotal: 67500,
        sellerGrossAmount: 65000,
        platformCommission: 3250,
        discountContribution: 0,
        platformFundedDiscount: 0,
        refundDeduction: 0,
        otherAdjustments: 0,
        netSellerAmount: 61750,
        walletReleaseStatus: 'مستحق للصرف',
        walletReleaseDate: '2026-10-25',
      },
      qrCodeDataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      qrPayload: 'https://souqnaa.com/verify/SO-987654-1',
      deliveryNotes: 'يرجى الاتصال قبل الوصول والتسليم عند البوابة',
      printAudit: {
        printCount: 1,
        lastPrintedAt: '2026-10-18T10:30:00.000Z',
      },
    };
  };

  const docTypes: PrintDocumentType[] = ['INVOICE', 'PACKING_SLIP', 'STATEMENT'];
  const paperFormats: PrintFormat[] = ['A4', '80MM', '58MM'];

  describe('1. 9-Matrix Document Type × Paper Format Combinations', () => {
    for (const docType of docTypes) {
      for (const format of paperFormats) {
        it(`should successfully render ${docType} in ${format} format`, () => {
          const mockData = createMockPrintData(docType, format);
          const html = SellerOrderPrintService.renderHtmlDocument(mockData);

          assert.ok(typeof html === 'string', 'Rendered HTML should be a string');
          assert.ok(html.length > 200, `Rendered HTML for ${docType}_${format} should not be empty`);
          assert.ok(html.includes('سوقناا') || html.includes('SOUQNAA'), 'Must include SOUQNA brand header');
          assert.ok(html.includes(mockData.sellerOrderNumber), 'Must include order reference number');

          // Check format-specific constraints
          if (format === '80MM') {
            assert.ok(html.includes('80mm') || html.includes('max-width: 300px') || html.includes('width: 80mm'), 'Must include 80mm dimensions');
          } else if (format === '58MM') {
            assert.ok(html.includes('58mm') || html.includes('max-width: 220px') || html.includes('width: 58mm'), 'Must include 58mm dimensions');
          }
        });
      }
    }
  });

  describe('2. Packing Slip Safety Rules (No Financials Exposed)', () => {
    for (const format of paperFormats) {
      it(`should never expose financial prices or balances in PACKING_SLIP (${format})`, () => {
        const mockData = createMockPrintData('PACKING_SLIP', format);
        const html = SellerOrderPrintService.renderHtmlDocument(mockData);

        // Packing slip must contain warehouse checklist indicators
        assert.ok(html.includes('بوصلة التجهيز') || html.includes('PACKING SLIP'), 'Must be titled as Packing Slip');
        assert.ok(html.includes('فحص') || html.includes('تجهيز') || html.includes('checkbox') || html.includes('☐'), 'Must contain pick/pack warehouse markers');

        // Packing slip must display delivery notes from checkout screen
        assert.ok(html.includes('ملاحظات') && html.includes('البوابة'), 'Must display delivery notes in packing slip');

        // Packing slip must NOT display order prices, platform fees, or grand total
        assert.ok(!html.includes('67,500') && !html.includes('67500'), 'Must not display total price');
        assert.ok(!html.includes('عمولة المنصة') && !html.includes('platformCommission'), 'Must not display platform commission');
        assert.ok(!html.includes('صافي المستحق') && !html.includes('netSellerAmount'), 'Must not display net payout');
      });
    }
  });

  describe('3. Seller Order Statement Financial Reconciliation', () => {
    for (const format of paperFormats) {
      it(`should display authoritative seller financial reconciliation in STATEMENT (${format})`, () => {
        const mockData = createMockPrintData('STATEMENT', format);
        const html = SellerOrderPrintService.renderHtmlDocument(mockData);

        assert.ok(html.includes('كشف حساب') || html.includes('STATEMENT'), 'Must identify as financial statement');
        assert.ok(html.includes('61,750') || html.includes('61750'), 'Must display net seller payout');
        assert.ok(html.includes('3,250') || html.includes('3250'), 'Must display platform commission deduction');
        assert.ok(html.includes('مستحق للصرف') || html.includes('walletReleaseStatus'), 'Must display payout status');
      });
    }
  });

  describe('4. CSV Export Formula Injection & RFC 4180 Escaping', () => {
    it('should sanitize formula injection payloads while preserving pure numbers', () => {
      // Test malicious strings
      const payload1 = '=SUM(A1:A10)';
      const payload2 = '+cmd|"/C calc"!A0';
      const payload3 = '-@malicious';
      const payload4 = '@HYPERLINK("http://evil.com")';
      const payload5 = '\t=1+1';

      assert.equal((StatementExportService as any).escapeCell(payload1), `"'=SUM(A1:A10)"`);
      assert.equal((StatementExportService as any).escapeCell(payload2), `"'+cmd|""/C calc""!A0"`);
      assert.equal((StatementExportService as any).escapeCell(payload3), `"'-@malicious"`);
      assert.equal((StatementExportService as any).escapeCell(payload4), `"\'@HYPERLINK(""http://evil.com"")"`);

      // Test legitimate numbers and negative balances (all safely quoted in RFC 4180)
      assert.equal((StatementExportService as any).escapeCell(-150.50), `"-150.5"`);
      assert.equal((StatementExportService as any).escapeCell('-2500.00'), `"-2500.00"`);
      assert.equal((StatementExportService as any).escapeCell('+500'), `"+500"`);
      assert.equal((StatementExportService as any).escapeCell(0), `"0"`);

      // Test Arabic text and internal quotes
      assert.equal((StatementExportService as any).escapeCell('سوقناا "للأجهزة"'), `"سوقناا ""للأجهزة"""`);
    });
  });
});
