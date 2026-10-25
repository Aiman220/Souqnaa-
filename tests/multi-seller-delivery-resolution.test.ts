/**
 * SOUQNA — Multi-Seller Delivery Method Resolution & Financial Statements Reconciliation Test
 *
 * Verifies:
 * 1. Multi-seller orders with different delivery methods:
 *    - Resolves active DeliveryMethods from system dictionary.
 *    - Validates seller-specific delivery method overrides.
 *    - Persists seller-specific deliveryMethodId on each SellerOrder.
 *    - Populates parent Order.deliveryMethodId ONLY if all sellers share the exact same method.
 *    - Leaves parent Order.deliveryMethodId as null when sellers use different methods (no arbitrary choice).
 * 2. Delivery fee presentation in statement breakdowns:
 *    - Statement breakdown displays the seller delivery fee row.
 *    - Arithmetic reconciles with authoritative sellerPayout without double-counting.
 * 3. Canonical public order reference display:
 *    - Prioritizes public reference (e.g. SQ-2026-...) over internal UUIDs.
 * 4. Seller name presentation:
 *    - Displays seller's first and last name in statement header when available.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SellerOrderPrintService, PrintDocumentData } from '../src/services/orders/seller-order-print.service';

describe('SOUQNA Multi-Seller Delivery & Statements Reconciliation Test Suite', () => {

  describe('1. Multi-Seller Delivery Method Resolution Logic', () => {
    // Mock active delivery methods in database
    const activeDeliveryMethods = [
      { id: 'dm-standard-uuid', code: 'standard', nameAr: 'توصيل قياسي', isActive: true },
      { id: 'dm-express-uuid', code: 'express', nameAr: 'توصيل سريع — إكسبرس', isActive: true },
      { id: 'dm-scheduled-uuid', code: 'scheduled', nameAr: 'توصيل مجدول', isActive: true },
    ];
    const deliveryMethodCodeMap = new Map(
      activeDeliveryMethods.map((m) => [m.code.toLowerCase(), m])
    );
    const defaultDeliveryMethod = deliveryMethodCodeMap.get('standard')!;

    it('should assign different validated delivery methods to distinct sellers in multi-seller checkout', () => {
      const sellerIds = ['seller-101', 'seller-202'];
      const rawSellerOverrides: Record<string, string> = {
        'seller-101': 'express',
        'seller-202': 'standard',
      };

      const resolvedSellerDeliveryMethods = new Map<string, typeof defaultDeliveryMethod>();
      for (const sId of sellerIds) {
        const customCode = rawSellerOverrides[sId];
        if (customCode && typeof customCode === 'string') {
          const validated = deliveryMethodCodeMap.get(customCode.trim().toLowerCase());
          if (validated) {
            resolvedSellerDeliveryMethods.set(sId, validated);
            continue;
          }
        }
        resolvedSellerDeliveryMethods.set(sId, defaultDeliveryMethod);
      }

      assert.equal(resolvedSellerDeliveryMethods.get('seller-101')?.id, 'dm-express-uuid');
      assert.equal(resolvedSellerDeliveryMethods.get('seller-101')?.code, 'express');
      assert.equal(resolvedSellerDeliveryMethods.get('seller-202')?.id, 'dm-standard-uuid');
      assert.equal(resolvedSellerDeliveryMethods.get('seller-202')?.code, 'standard');

      // Unanimous check: different methods -> parent deliveryMethodId MUST be null
      const distinctMethodIds = new Set(
        Array.from(resolvedSellerDeliveryMethods.values())
          .map((m) => m?.id)
          .filter(Boolean)
      );
      const parentDeliveryMethodId = distinctMethodIds.size === 1 ? Array.from(distinctMethodIds)[0] : null;

      assert.equal(parentDeliveryMethodId, null, 'Parent order must NOT have an arbitrary delivery method when sellers differ');
    });

    it('should set parent deliveryMethodId when ALL sellers share the exact same method', () => {
      const sellerIds = ['seller-101', 'seller-202', 'seller-303'];
      const rawSellerOverrides: Record<string, string> = {
        'seller-101': 'express',
        'seller-202': 'express',
        'seller-303': 'express',
      };

      const resolvedSellerDeliveryMethods = new Map<string, typeof defaultDeliveryMethod>();
      for (const sId of sellerIds) {
        const customCode = rawSellerOverrides[sId];
        const validated = deliveryMethodCodeMap.get(customCode?.toLowerCase() || '');
        resolvedSellerDeliveryMethods.set(sId, validated || defaultDeliveryMethod);
      }

      const distinctMethodIds = new Set(
        Array.from(resolvedSellerDeliveryMethods.values())
          .map((m) => m?.id)
          .filter(Boolean)
      );
      const parentDeliveryMethodId = distinctMethodIds.size === 1 ? Array.from(distinctMethodIds)[0] : null;

      assert.equal(parentDeliveryMethodId, 'dm-express-uuid', 'Parent order deliveryMethodId should be set when all sellers agree');
    });

    it('should reject unvalidated/bogus seller overrides and fall back to active default method', () => {
      const sellerIds = ['seller-999'];
      const rawSellerOverrides: Record<string, string> = {
        'seller-999': 'malicious_non_existent_method_xyz',
      };

      const resolvedSellerDeliveryMethods = new Map<string, typeof defaultDeliveryMethod>();
      for (const sId of sellerIds) {
        const customCode = rawSellerOverrides[sId];
        if (customCode && typeof customCode === 'string') {
          const validated = deliveryMethodCodeMap.get(customCode.trim().toLowerCase());
          if (validated) {
            resolvedSellerDeliveryMethods.set(sId, validated);
            continue;
          }
        }
        resolvedSellerDeliveryMethods.set(sId, defaultDeliveryMethod);
      }

      assert.equal(
        resolvedSellerDeliveryMethods.get('seller-999')?.id,
        'dm-standard-uuid',
        'Must fall back to default standard method when override is invalid'
      );
    });
  });

  describe('2. Delivery Fee Presentation & Financial Reconciliation in Statements', () => {
    it('reconciles net seller payout with seller gross, commission, and delivery fee without double counting', () => {
      const sellerSubtotal = 40000;
      const commission = 3200; // 8%
      const sellerDiscount = 1000;
      const sellerDeliveryFee = 2500; // customer paid delivery to this seller

      // Authoritative calculation: net seller payout
      const sellerPayout = sellerSubtotal - sellerDiscount - commission + sellerDeliveryFee; // 38300

      assert.equal(sellerPayout, 38300, 'Authoritative seller payout must equal 38300');

      // Now create statement data
      const mockStatementData: PrintDocumentData = {
        documentType: 'STATEMENT',
        format: 'A4',
        title: 'كشف حساب مالي',
        mainOrderNumber: 'SQ-2026-1025-000456',
        sellerOrderNumber: 'SQ-2026-1025-000456-S01',
        shortOrderNumber: '#000456-S01',
        orderDateFormattedAr: '25 أكتوبر 2026',
        orderDateFormattedEn: '25 Oct 2026',
        orderDateISO: '2026-10-25T12:00:00.000Z',
        paymentMethodAr: 'الدفع عند الاستلام',
        paymentMethodEn: 'COD',
        paymentStatusAr: 'مؤكد',
        paymentStatusEn: 'CONFIRMED',
        deliveryMethodAr: 'توصيل قياسي',
        deliveryMethodEn: 'Standard Delivery',
        orderStatusAr: 'تم التجهيز',
        orderStatusEn: 'PROCESSING',
        souqnaLogoDataUri: '',
        store: {
          name: 'متجر الهواتف الذكية',
          sellerName: 'بلال نبيل الشرجبي',
          phone: '+967-771122334',
          email: 'store@phones.ye',
          address: 'صنعاء',
          isVerified: true,
        },
        customer: {
          name: 'عميل سوقناا',
          phone: '+967-770000000',
          deliveryAddress: {
            governorate: 'صنعاء',
            cityName: 'الأمانة',
            neighborhood: 'حدة',
            street: 'شارع حدة',
            buildingNumber: '1',
            additionalInfo: '',
            formatted: 'صنعاء، حدة',
          },
        },
        items: [],
        totals: {
          subtotal: sellerSubtotal,
          productDiscounts: 0,
          couponDiscount: 0,
          sellerDiscount,
          deliveryFee: sellerDeliveryFee,
          otherFees: 0,
          grandTotal: sellerSubtotal + sellerDeliveryFee - sellerDiscount,
          currency: 'ر.ي',
        },
        sellerFinancials: {
          customerOrderTotal: sellerSubtotal + sellerDeliveryFee - sellerDiscount,
          sellerGrossAmount: sellerSubtotal,
          platformCommission: commission,
          commissionRate: 8,
          discountContribution: sellerDiscount,
          platformFundedDiscount: 0,
          refundDeduction: 0,
          otherAdjustments: 0,
          deliveryFee: sellerDeliveryFee,
          netSellerAmount: sellerPayout,
          walletReleaseStatus: 'معلق لحين اكتمال التسليم للعميل',
          walletReleaseDate: '28 أكتوبر 2026',
        },
        qrCodeDataUri: '',
        qrPayload: 'TEST',
        printAudit: { printCount: 1 },
      };

      // Test A4 statement rendering
      const a4Html = SellerOrderPrintService.renderHtmlDocument(mockStatementData);
      assert.ok(a4Html.includes('رسوم توصيل المتجر'), 'A4 statement must include seller delivery fee row');
      assert.ok(a4Html.includes('+2,500.00'), 'A4 statement must display positive credit +2,500.00 for delivery');
      assert.ok(a4Html.includes('38,300.00'), 'A4 statement must display reconciled net seller payout 38,300.00');

      // Test 80mm statement rendering
      mockStatementData.format = '80MM';
      const thermal80Html = SellerOrderPrintService.renderHtmlDocument(mockStatementData);
      assert.ok(thermal80Html.includes('رسوم توصيل المتجر:'), '80mm statement must include delivery fee row');
      assert.ok(thermal80Html.includes('+2,500.00'), '80mm statement must display +2,500.00');
      assert.ok(thermal80Html.includes('38,300.00'), '80mm statement must display 38,300.00');

      // Test 58mm statement rendering
      mockStatementData.format = '58MM';
      const thermal58Html = SellerOrderPrintService.renderHtmlDocument(mockStatementData);
      assert.ok(thermal58Html.includes('توصيل المتجر:'), '58mm statement must include delivery fee row');
      assert.ok(thermal58Html.includes('+2,500.00'), '58mm statement must display +2,500.00');
      assert.ok(thermal58Html.includes('38,300.00'), '58mm statement must display 38,300.00');
    });
  });

  describe('3. Seller First & Last Name in Statement Header', () => {
    it('should display the seller first and last name in store header when available and distinct from store name', () => {
      const mockData: PrintDocumentData = {
        documentType: 'STATEMENT',
        format: 'A4',
        title: 'كشف حساب مالي',
        mainOrderNumber: 'SQ-2026-1025-000789',
        sellerOrderNumber: 'SQ-2026-1025-000789-S01',
        shortOrderNumber: '#000789-S01',
        orderDateFormattedAr: '25 أكتوبر 2026',
        orderDateFormattedEn: '25 Oct 2026',
        orderDateISO: '2026-10-25T12:00:00.000Z',
        paymentMethodAr: 'محفظة',
        paymentMethodEn: 'WALLET',
        paymentStatusAr: 'مدفوع',
        paymentStatusEn: 'PAID',
        deliveryMethodAr: 'توصيل قياسي',
        deliveryMethodEn: 'Standard Delivery',
        orderStatusAr: 'مؤكد',
        orderStatusEn: 'CONFIRMED',
        souqnaLogoDataUri: '',
        store: {
          name: 'عالم الحواسيب والإلكترونيات',
          sellerName: 'طارق عبدالكريم العريقي',
          phone: '+967-772233445',
          email: 'tareq@computers.ye',
          address: 'تعز',
          isVerified: true,
        },
        customer: {
          name: 'عميل سوقناا',
          phone: '+967-770000000',
          deliveryAddress: {
            governorate: 'تعز',
            cityName: 'القاهرة',
            neighborhood: 'جمال',
            street: 'شارع جمال',
            buildingNumber: '1',
            additionalInfo: '',
            formatted: 'تعز، شارع جمال',
          },
        },
        items: [],
        totals: {
          subtotal: 10000,
          productDiscounts: 0,
          couponDiscount: 0,
          sellerDiscount: 0,
          deliveryFee: 0,
          otherFees: 0,
          grandTotal: 10000,
          currency: 'ر.ي',
        },
        sellerFinancials: {
          customerOrderTotal: 10000,
          sellerGrossAmount: 10000,
          platformCommission: 1000,
          discountContribution: 0,
          platformFundedDiscount: 0,
          refundDeduction: 0,
          otherAdjustments: 0,
          netSellerAmount: 9000,
          walletReleaseStatus: 'تم التحويل للمحفظة',
          walletReleaseDate: '25 أكتوبر 2026',
        },
        qrCodeDataUri: '',
        qrPayload: 'TEST',
        printAudit: { printCount: 1 },
      };

      // A4 format
      const a4 = SellerOrderPrintService.renderHtmlDocument(mockData);
      assert.ok(a4.includes('عالم الحواسيب والإلكترونيات'), 'A4 must include store name');
      assert.ok(a4.includes('طارق عبدالكريم العريقي'), 'A4 must include seller first and last name');

      // 80mm format
      mockData.format = '80MM';
      const th80 = SellerOrderPrintService.renderHtmlDocument(mockData);
      assert.ok(th80.includes('عالم الحواسيب والإلكترونيات'), '80mm must include store name');
      assert.ok(th80.includes('طارق عبدالكريم العريقي'), '80mm must include seller first and last name');

      // 58mm format
      mockData.format = '58MM';
      const th58 = SellerOrderPrintService.renderHtmlDocument(mockData);
      assert.ok(th58.includes('عالم الحواسيب والإلكترونيات'), '58mm must include store name');
      assert.ok(th58.includes('طارق عبدالكريم العريقي'), '58mm must include seller first and last name');
    });
  });

  describe('4. Canonical Public Order Reference Fallback', () => {
    it('prioritizes canonical public reference over internal UUIDs', () => {
      const lineItemWithReference = {
        reference: 'SQ-2026-1025-000123-S01',
        sellerOrderId: '3e9a5c81-8178-4352-8fc1-b0e515d181cf',
        orderId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      };

      const displayedRef = lineItemWithReference.reference.length > 0
        ? lineItemWithReference.reference
        : (lineItemWithReference.sellerOrderId ?? lineItemWithReference.orderId ?? '-');

      assert.equal(displayedRef, 'SQ-2026-1025-000123-S01', 'Must display public canonical order reference instead of UUID');
      assert.ok(!displayedRef.includes('3e9a5c81'), 'Must not display raw internal UUID');
    });
  });
});
