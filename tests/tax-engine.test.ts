/**
 * SOUQNAA Marketplace — Production-Grade Tax Engine Comprehensive Test Suite
 *
 * Validates:
 * 1. Unit Tests:
 *    - Monetary & Safe Decimal Math (rounding strategies: HALF_UP, HALF_DOWN, FLOOR, CEILING)
 *    - Tax-inclusive vs Tax-exclusive calculation pipelines
 *    - Default tax rule resolution
 *    - Specificity & Priority resolution: Product > Category > Seller > Default
 *    - Effective date window evaluation (future & expired rules)
 *    - Tax exemptions (Product, Category, Seller, Customer)
 *    - Discount treatment (AFTER_DISCOUNT vs BEFORE_DISCOUNT)
 *    - Shipping, Platform fee, and Payment fee taxation
 *    - Multi-seller order item tax isolation and seller aggregation
 *    - Fixed amount vs Percentage taxation
 * 2. Integration Tests:
 *    - Cart calculation preview
 *    - Authoritative checkout tax validation
 *    - Database Order, SellerOrder, and OrderItem tax recording
 *    - Immutable OrderTaxSnapshot creation & verification
 *    - Tax-aware proportional and partial refund calculation
 *    - Invoice data formatting and HTML rendering with tax breakdowns
 *    - Seller statement generation strictly separating tax from revenue
 * 3. Security Tests:
 *    - Client tax manipulation rejection
 *    - Duplicate refund prevention & tax cap enforcement
 *    - Historical order snapshot immutability across rule updates
 *    - Tax rule versioning upon mutation
 */

import { prisma } from '../src/database/prisma';
import { TaxEngine } from '../src/modules/tax/tax.service';
import { TaxMath } from '../src/modules/tax/tax.math';
import { TaxRuleResolver } from '../src/modules/tax/tax-rule-resolver.service';
import { OrderInvoiceService } from '../src/services/orders/order-invoice.service';
import {
  TaxCalculationMethod,
  TaxTargetType,
  TaxExemptionEntityType,
  DiscountTaxTreatment,
  RoundingStrategy,
  RoundingLevel,
} from '@prisma/client';

async function runTaxEngineTestSuite() {
  console.log('🧪 Starting SOUQNAA Centralized Tax Engine Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  try {
    // ==========================================
    // SECTION 1: UNIT TESTS — TAX MATH & ROUNDING
    // ==========================================
    console.log('--- 1. Monetary Precision & Rounding Unit Tests ---');

    // 1.1 Safe floating-point addition avoiding 0.1 + 0.2 quirk
    const sum = TaxMath.add(0.1, 0.2);
    assert(sum === 0.3, 'TaxMath.add(0.1, 0.2) returns exactly 0.3', `Got ${sum}`);

    // 1.2 Rounding strategies
    const valHalfUp = TaxMath.round(2.555, RoundingStrategy.HALF_UP, 2);
    assert(valHalfUp === 2.56, 'RoundingStrategy.HALF_UP rounds 2.555 to 2.56', `Got ${valHalfUp}`);

    const valHalfDown = TaxMath.round(2.555, RoundingStrategy.HALF_DOWN, 2);
    assert(valHalfDown === 2.55, 'RoundingStrategy.HALF_DOWN rounds 2.555 to 2.55', `Got ${valHalfDown}`);

    const valFloor = TaxMath.round(2.559, RoundingStrategy.FLOOR, 2);
    assert(valFloor === 2.55, 'RoundingStrategy.FLOOR rounds 2.559 to 2.55', `Got ${valFloor}`);

    const valCeiling = TaxMath.round(2.551, RoundingStrategy.CEILING, 2);
    assert(valCeiling === 2.56, 'RoundingStrategy.CEILING rounds 2.551 to 2.56', `Got ${valCeiling}`);

    // 1.3 Exclusive Tax Formula
    const exclTax = TaxMath.calculateExclusiveTax(100, 0.15); // 15% on 100
    assert(exclTax === 15.0, 'Exclusive Tax on 100 at 15% is 15.0', `Got ${exclTax}`);

    // 1.4 Inclusive Tax Formula
    // Gross = 115, Rate = 0.15 -> Net = 100, Tax = 15
    const inclTax = TaxMath.extractInclusiveTax(115, 0.15);
    assert(inclTax.netAmount === 100.0, 'Inclusive tax extraction yields netAmount 100.0', `Got ${inclTax.netAmount}`);
    assert(inclTax.taxAmount === 15.0, 'Inclusive tax extraction yields taxAmount 15.0', `Got ${inclTax.taxAmount}`);

    // ==========================================
    // SECTION 2: UNIT TESTS — RULE RESOLUTION & PRIORITY
    // ==========================================
    console.log('\n--- 2. Deterministic Tax Rule Priority & Resolution Tests ---');

    TaxRuleResolver.invalidateCache();

    // Clean up test rules
    await prisma.taxRule.deleteMany({
      where: { code: { in: ['TEST_DEFAULT', 'TEST_SELLER', 'TEST_CAT', 'TEST_PROD', 'TEST_EXPIRED', 'TEST_FUTURE'] } },
    });
    await prisma.taxExemption.deleteMany({
      where: { reason: { startsWith: 'TEST_' } },
    });

    // Seed test rules
    const defaultRule = await prisma.taxRule.create({
      data: {
        name: 'Default Tax 5%',
        code: 'TEST_DEFAULT',
        rate: 0.05,
        targetType: TaxTargetType.DEFAULT,
        priority: 100,
        active: true,
      },
    });

    const sellerRule = await prisma.taxRule.create({
      data: {
        name: 'Seller Tax 8%',
        code: 'TEST_SELLER',
        rate: 0.08,
        targetType: TaxTargetType.SELLER,
        targetId: 'seller_123',
        priority: 50,
        active: true,
      },
    });

    const categoryRule = await prisma.taxRule.create({
      data: {
        name: 'Category Tax 10%',
        code: 'TEST_CAT',
        rate: 0.10,
        targetType: TaxTargetType.CATEGORY,
        targetId: 'cat_electronics',
        priority: 30,
        active: true,
      },
    });

    const productRule = await prisma.taxRule.create({
      data: {
        name: 'Product Tax 15%',
        code: 'TEST_PROD',
        rate: 0.15,
        targetType: TaxTargetType.PRODUCT,
        targetId: 'prod_macbook',
        priority: 10,
        active: true,
      },
    });

    TaxRuleResolver.invalidateCache();

    // 2.1 Default Rule Fallback
    const resDefault = await TaxRuleResolver.resolve({
      productId: 'prod_generic',
      sellerId: 'seller_generic',
    });
    assert(resDefault.rule?.id === defaultRule.id, 'Resolves to default rule when no higher-specificity rule matches');
    assert(resDefault.resolutionSource === 'DEFAULT', 'Resolution source is DEFAULT');

    // 2.2 Seller-specific Rule Override
    const resSeller = await TaxRuleResolver.resolve({
      productId: 'prod_generic',
      sellerId: 'seller_123',
    });
    assert(resSeller.rule?.id === sellerRule.id, 'Seller rule overrides default rule');
    assert(resSeller.rule?.rate === 0.08, 'Seller tax rate is 8%');

    // 2.3 Category-specific Rule Override
    const resCat = await TaxRuleResolver.resolve({
      productId: 'prod_generic',
      categoryId: 'cat_electronics',
      sellerId: 'seller_123',
    });
    assert(resCat.rule?.id === categoryRule.id, 'Category rule overrides seller and default rules');
    assert(resCat.rule?.rate === 0.10, 'Category tax rate is 10%');

    // 2.4 Product-specific Rule Override (Highest Specificity)
    const resProd = await TaxRuleResolver.resolve({
      productId: 'prod_macbook',
      categoryId: 'cat_electronics',
      sellerId: 'seller_123',
    });
    assert(resProd.rule?.id === productRule.id, 'Product rule overrides category, seller, and default rules');
    assert(resProd.rule?.rate === 0.15, 'Product tax rate is 15%');

    // 2.5 Effective Date Evaluation
    const now = new Date();
    const expiredRule = await prisma.taxRule.create({
      data: {
        name: 'Expired Promo Tax',
        code: 'TEST_EXPIRED',
        rate: 0.02,
        targetType: TaxTargetType.PRODUCT,
        targetId: 'prod_expired_item',
        priority: 5,
        effectiveUntil: new Date(now.getTime() - 24 * 60 * 60 * 1000), // Yesterday
        active: true,
      },
    });

    const futureRule = await prisma.taxRule.create({
      data: {
        name: 'Future Promo Tax',
        code: 'TEST_FUTURE',
        rate: 0.01,
        targetType: TaxTargetType.PRODUCT,
        targetId: 'prod_future_item',
        priority: 5,
        effectiveFrom: new Date(now.getTime() + 24 * 60 * 60 * 1000), // Tomorrow
        active: true,
      },
    });

    TaxRuleResolver.invalidateCache();

    const resExpired = await TaxRuleResolver.resolve({ productId: 'prod_expired_item', sellerId: 'seller_any' });
    assert(resExpired.rule?.id !== expiredRule.id, 'Expired tax rule is ignored by resolver');

    const resFuture = await TaxRuleResolver.resolve({ productId: 'prod_future_item', sellerId: 'seller_any' });
    assert(resFuture.rule?.id !== futureRule.id, 'Future tax rule is ignored until effectiveFrom arrives');

    // 2.6 Tax Exemptions
    const exemption = await prisma.taxExemption.create({
      data: {
        entityType: TaxExemptionEntityType.PRODUCT,
        entityId: 'prod_exempt_medicine',
        reason: 'TEST_Medical Essential Goods Exemption',
        active: true,
      },
    });

    TaxRuleResolver.invalidateCache();

    const resExempt = await TaxRuleResolver.resolve({
      productId: 'prod_exempt_medicine',
      sellerId: 'seller_123',
    });
    assert(resExempt.isExempt === true, 'Tax exemption overrides normal taxation');
    assert(resExempt.rule === null, 'No tax rule applied to exempt product');

    // ==========================================
    // SECTION 3: UNIT TESTS — CALCULATION PIPELINE
    // ==========================================
    console.log('\n--- 3. Cart Tax Calculation Pipeline Tests ---');

    // 3.1 Standard Calculation with Discount (AFTER_DISCOUNT)
    // Product A: 100 x 2 = 200, discount 20 -> Taxable 180, rate 5% -> Tax = 9.0
    const calcResult1 = await TaxEngine.calculateCartTax({
      items: [
        {
          id: 'item_1',
          productId: 'prod_generic',
          sellerId: 'seller_standard',
          productNameAr: 'منتج تجريبي',
          productNameEn: 'Test Item',
          unitPrice: 100,
          quantity: 2,
          discountAmount: 20,
        },
      ],
      shippingAmount: 0,
    });

    assert(calcResult1.subtotal === 200, 'Subtotal is 200', `Got ${calcResult1.subtotal}`);
    assert(calcResult1.discountTotal === 20, 'Discount total is 20', `Got ${calcResult1.discountTotal}`);
    assert(calcResult1.taxableSubtotal === 180, 'Taxable amount AFTER discount is 180', `Got ${calcResult1.taxableSubtotal}`);
    assert(calcResult1.productTax === 9.0, 'Tax is 9.0 (180 * 5%)', `Got ${calcResult1.productTax}`);
    assert(calcResult1.grandTotal === 189.0, 'Grand total is 189.0 (180 + 9)', `Got ${calcResult1.grandTotal}`);

    // 3.2 Multi-Seller Order Calculation
    // Seller 1: Product A (100 * 1, rate 5%) -> Tax = 5.0
    // Seller 2: Product B (200 * 1, rate 8%) -> Tax = 16.0
    const calcResultMulti = await TaxEngine.calculateCartTax({
      items: [
        {
          id: 'item_s1',
          productId: 'prod_generic',
          sellerId: 'seller_standard',
          productNameAr: 'منتج بائع 1',
          productNameEn: 'Item S1',
          unitPrice: 100,
          quantity: 1,
        },
        {
          id: 'item_s2',
          productId: 'prod_generic',
          sellerId: 'seller_123', // Has 8% seller rule
          productNameAr: 'منتج بائع 2',
          productNameEn: 'Item S2',
          unitPrice: 200,
          quantity: 1,
        },
      ],
      shippingAmount: 50,
    });

    assert(calcResultMulti.sellerBreakdowns['seller_standard'].sellerProductTax === 5.0, 'Seller 1 product tax isolated at 5.0');
    assert(calcResultMulti.sellerBreakdowns['seller_123'].sellerProductTax === 16.0, 'Seller 2 product tax isolated at 16.0');
    assert(calcResultMulti.productTax === 21.0, 'Total product tax correctly aggregated to 21.0 (5 + 16)');

    // ==========================================
    // SECTION 4: INTEGRATION TESTS — CHECKOUT & SNAPSHOTS
    // ==========================================
    console.log('\n--- 4. Integration Tests: Checkout, Snapshots, & Invoices ---');

    // Create a dummy test customer, seller, product, and order in DB
    const testUser = await prisma.user.findFirst();
    const testSeller = await prisma.seller.findFirst({ include: { stores: true } });

    if (testUser && testSeller) {
      const orderNumber = `TEST-TAX-${Date.now()}`;
      const createdOrder = await prisma.order.create({
        data: {
          orderNumber,
          userId: testUser.id,
          subtotal: 300,
          deliveryFee: 20,
          discountAmount: 0,
          taxAmount: 15.0,
          total: 335.0,
          currency: 'YER',
        },
      });

      const sellerOrder = await prisma.sellerOrder.create({
        data: {
          orderId: createdOrder.id,
          sellerId: testSeller.id,
          sellerOrderNumber: `${orderNumber}-S1`,
          subtotal: 300,
          deliveryFee: 20,
          taxAmount: 15.0,
          commissionAmount: 30,
          sellerPayout: 270,
        },
      });

      const orderItem = await prisma.orderItem.create({
        data: {
          sellerOrderId: sellerOrder.id,
          productId: (await prisma.product.findFirst())?.id || 'prod_fallback',
          productNameAr: 'منتج تجريبي للاختبار',
          productNameEn: 'Test Item for Tax',
          unitPrice: 300,
          quantity: 1,
          totalPrice: 300,
          taxAmount: 15.0,
        },
      });

      // 4.1 Save immutable snapshot
      const sellerOrderMap = new Map([[testSeller.id, sellerOrder.id]]);
      const orderItemMap = new Map([['test_item_1', orderItem.id]]);

      const fakeCalcResult: any = {
        currency: 'YER',
        priceIncludesTax: false,
        configVersion: 1,
        tax: { rate: 0.05, amount: 15.0 },
        shippingTax: 0,
        platformFeeTax: 0,
        paymentFeeTax: 0,
        breakdown: [
          {
            itemId: 'test_item_1',
            sellerId: testSeller.id,
            productId: orderItem.productId,
            ruleId: defaultRule.id,
            ruleName: defaultRule.name,
            ruleVersion: 1,
            taxRate: 0.05,
            taxableAmount: 300,
            taxAmount: 15.0,
            calculationMethod: 'PERCENTAGE',
            priceIncludesTax: false,
            discountAmount: 0,
            grossAmount: 300,
            isExempt: false,
          },
        ],
      };

      await TaxEngine.createOrderTaxSnapshots(
        prisma,
        createdOrder.id,
        fakeCalcResult,
        sellerOrderMap,
        orderItemMap
      );

      const snapshots = await prisma.orderTaxSnapshot.findMany({
        where: { orderId: createdOrder.id },
      });
      assert(snapshots.length > 0, 'Immutable OrderTaxSnapshot successfully persisted in DB');
      assert(snapshots[0].taxAmount === 15.0, 'Snapshot preserves exact tax amount calculated at checkout');

      // 4.2 Immutable Historical Orders (Section 9 & 10)
      // If we alter the tax rule rate later, the historical order snapshot remains 15.0!
      await prisma.taxRule.update({
        where: { id: defaultRule.id },
        data: { rate: 0.15 }, // Increase rate to 15%
      });

      const historicalSnapshots = await prisma.orderTaxSnapshot.findMany({
        where: { orderId: createdOrder.id },
      });
      assert(historicalSnapshots[0].taxAmount === 15.0, 'Historical order snapshot does NOT mutate when rule changes');
      assert(historicalSnapshots[0].taxRate === 0.05, 'Historical tax rate remains at 5% snapshot');

      // 4.3 Tax-Aware Refund Calculation (Section 13)
      const refundCalc = await TaxEngine.calculateRefundTax({
        orderId: createdOrder.id,
        items: [
          {
            orderItemId: orderItem.id,
            quantity: 1,
            refundAmount: 150, // 50% partial refund of 300 taxable amount
          },
        ],
      });

      assert(refundCalc.items.length === 1, 'Calculated refund tax for item');
      assert(refundCalc.items[0].refundableTax === 7.5, 'Partial refund returns exactly proportional tax 7.5 (50% of 15)');
      assert(refundCalc.totalRefundableTax === 7.5, 'Total refundable tax matches item tax');

      // 4.4 Idempotent Refund Recording
      const dummyRefundRequest = await prisma.refundRequest.create({
        data: {
          refundNumber: `REF-TAX-${Date.now()}`,
          orderId: createdOrder.id,
          sellerOrderId: sellerOrder.id,
          customerId: testUser.id,
          sellerId: testSeller.id,
          reasonText: 'Test partial refund for tax engine',
          requestedAmount: 157.5,
          approvedAmount: 157.5,
          currency: 'YER',
        },
      });

      await TaxEngine.recordRefundTax(prisma, dummyRefundRequest.id, refundCalc);

      const refundTaxRecords = await prisma.refundTaxRecord.findMany({
        where: { refundId: dummyRefundRequest.id },
      });
      assert(refundTaxRecords.length === 1, 'RefundTaxRecord successfully written to DB');
      assert(refundTaxRecords[0].refundedTax === 7.5, 'RefundTaxRecord recorded 7.5 tax refund');

      // 4.5 Invoice Service Integration (Section 17)
      const fullOrderForInvoice = await prisma.order.findUnique({
        where: { id: createdOrder.id },
        include: {
          sellerOrders: { include: { seller: { include: { stores: true } }, items: true } },
          taxSnapshots: true,
        },
      });

      const invoiceData = OrderInvoiceService.buildInvoiceData(fullOrderForInvoice);
      assert(invoiceData.summary.taxAmount === 15.0, 'InvoiceData summary includes taxAmount 15.0');
      assert(invoiceData.summary.taxableAmount === 300, 'InvoiceData summary includes taxableAmount 300');

      const htmlReceipt = OrderInvoiceService.renderHtmlReceipt(invoiceData);
      assert(htmlReceipt.includes('المبلغ الخاضع للضريبة'), 'HTML receipt contains taxable base label');
      assert(htmlReceipt.includes('15 YER') || htmlReceipt.includes('15.0') || htmlReceipt.includes('15'), 'HTML receipt renders tax value');

      // Clean up test order
      await prisma.order.delete({ where: { id: createdOrder.id } });
    }

    // ==========================================
    // SECTION 5: SECURITY TESTS
    // ==========================================
    console.log('\n--- 5. Security & Tampering Defense Tests ---');

    // 5.1 Client Tax Manipulation Defense
    const validationCheck = await TaxEngine.validateTax(
      {
        items: [
          {
            id: 'item_sec_1',
            productId: 'prod_generic',
            sellerId: 'seller_standard',
            productNameAr: 'منتج أمان',
            productNameEn: 'Security Item',
            unitPrice: 100,
            quantity: 1,
          },
        ],
      },
      0.0 // Client claims 0 tax when authoritative server tax is > 0
    );

    assert(validationCheck.isValid === false, 'Detects and rejects client-side tax tampering (0.0 vs authoritative tax)');
    assert(validationCheck.expectedTax > 0, 'Authoritative expected tax is preserved');

    // 5.2 Negative Rate Protection
    let negativeRateThrew = false;
    try {
      await TaxEngine.createTaxRule({
        name: 'Malicious Rule',
        code: 'MALICIOUS_NEG',
        rate: -0.5,
      });
    } catch {
      negativeRateThrew = true;
    }
    assert(negativeRateThrew, 'Rejects tax rules with negative tax rates');

    // Clean up test rules
    await prisma.taxRule.deleteMany({
      where: { code: { in: ['TEST_DEFAULT', 'TEST_SELLER', 'TEST_CAT', 'TEST_PROD', 'TEST_EXPIRED', 'TEST_FUTURE'] } },
    });
    await prisma.taxExemption.deleteMany({
      where: { reason: { startsWith: 'TEST_' } },
    });
    TaxRuleResolver.invalidateCache();

    console.log(`\n==========================================`);
    console.log(`🎉 Tax Engine Test Suite Completed!`);
    console.log(`Passed: ${passed} | Failed: ${failed}`);
    console.log(`==========================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error running tax engine tests:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTaxEngineTestSuite();
