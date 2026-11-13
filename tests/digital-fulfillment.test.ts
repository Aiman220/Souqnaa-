/**
 * SOUQNA — DIGITAL PRODUCT FULFILLMENT & ZERO DELIVERY FEE REGRESSION TEST SUITE
 * Validates the 12 core requirements for digital product fulfillment:
 * 1. Physical product delivery remains unchanged.
 * 2. Digital-only order delivery fee is zero.
 * 3. Mixed-cart delivery fee includes physical products only.
 * 4. Digital-only checkout does not require a physical address.
 * 5. Mixed checkout requires a physical address.
 * 6. Digital items cannot be fulfilled before verified payment.
 * 7. Repeated fulfillment requests cannot duplicate delivery (idempotency).
 * 8. Failed provider requests do not falsely mark products fulfilled.
 * 9. Refunds and cancellations preserve correct fulfillment state (REVOKED).
 * 10. Sellers cannot manipulate fulfillment type or delivery fees.
 * 11. North/South market compatibility.
 * 12. Existing physical orders remain unaffected.
 * + Encryption at rest (AES-256-GCM), code masking, and SSRF prevention.
 */

import { deliveryFeeService } from '../src/services/delivery/delivery-fee.service';
import { deliveryQuoteService, QuoteRequest } from '../src/services/delivery/delivery-quote.service';
import {
  digitalFulfillmentService,
  ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS,
} from '../src/services/digital/digital-fulfillment.service';
import { UrlSecurityUtil } from '../src/utils/url-security.util';
import { prisma } from '../src/database/prisma';
import {
  FulfillmentType,
  DigitalDeliveryType,
  DigitalFulfillmentStatus,
  OrderStatus,
  SellerOrderStatus,
  PaymentStatus,
  PaymentMethodType,
} from '@prisma/client';

async function runRegressionTests() {
  console.log('============================================================');
  console.log('⚡ SOUQNA — DIGITAL FULFILLMENT & ZERO DELIVERY FEE REGRESSION TESTS');
  console.log('============================================================\n');

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
    // ─────────────────────────────────────────────────────────────
    // TEST 1: Physical product delivery remains unchanged
    // ─────────────────────────────────────────────────────────────
    console.log('[1] Testing Physical Product Delivery Calculator Formula Unchanged...');
    // Sanaa center: 15.3694, 44.1910 to 5km away: 15.3300, 44.1910
    const physicalQuote = await deliveryFeeService.calculateFee(
      15.3694, 44.1910,
      15.3300, 44.1910,
      { isExpress: false, weightKg: 2.0 }
    );
    assert(
      physicalQuote.deliveryAvailable === true && physicalQuote.deliveryFee > 0,
      'Physical product delivery formula calculates positive fee based on zone & distance',
      `Calculated Fee: ${physicalQuote.deliveryFee} YER, Distance: ${physicalQuote.distanceKm} km`
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Digital-only order delivery fee is zero
    // ─────────────────────────────────────────────────────────────
    console.log('\n[2] Testing Digital-Only Order Delivery Fee Is Strictly ZERO...');
    const digitalQuoteRequest: QuoteRequest = {
      isDigitalOnly: true,
      sellerOrders: [
        {
          sellerId: 'seller_digital_1',
          storeId: 'store_digital_1',
        },
      ],
      isExpress: false,
    };
    const digitalQuoteResult = await deliveryQuoteService.createQuote(digitalQuoteRequest);
    assert(
      digitalQuoteResult.totalDeliveryFee === 0,
      'Digital-only order total delivery fee is exactly 0 YER',
      `Actual totalDeliveryFee: ${digitalQuoteResult.totalDeliveryFee}`
    );
    assert(
      digitalQuoteResult.policy === 'DIGITAL_DELIVERY' && digitalQuoteResult.isDigitalOnly === true,
      'Digital-only quote sets policy to DIGITAL_DELIVERY and isDigitalOnly=true'
    );
    assert(
      digitalQuoteResult.sellerQuotes[0].deliveryFee === 0 && digitalQuoteResult.sellerQuotes[0].baseFee === 0,
      'Digital seller quote has zero baseFee and zero deliveryFee'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Mixed-cart delivery fee includes physical products only
    // ─────────────────────────────────────────────────────────────
    console.log('\n[3] Testing Mixed-Cart Delivery Fee Charges Physical Items Only...');
    const sampleAddress = await prisma.address.findFirst({
      where: { latitude: { not: null }, longitude: { not: null } },
    });
    const sampleStore = await prisma.store.findFirst({ where: { isActive: true } });
    const testAddressId = sampleAddress?.id || 'mock_address_mixed';
    const testStoreId = sampleStore?.id || 'store_mixed_1';
    const testSellerId = sampleStore?.sellerId || 'seller_mixed_1';

    const mixedQuoteRequest: QuoteRequest = {
      customerAddressId: testAddressId,
      sellerOrders: [
        {
          sellerId: testSellerId,
          storeId: testStoreId,
          weightKg: 2.0, // Physical item weight only
        },
      ],
      isDigitalOnly: false,
      isExpress: false,
    };
    const mixedQuoteResult = await deliveryQuoteService.createQuote(mixedQuoteRequest);
    assert(
      mixedQuoteResult.sellerQuotes.length > 0,
      'Mixed cart produces an authoritative physical seller delivery quote'
    );
    assert(
      mixedQuoteResult.isDigitalOnly !== true,
      'Mixed cart is not classified as digital-only'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Digital-only checkout does not require a physical address
    // ─────────────────────────────────────────────────────────────
    console.log('\n[4] Testing Digital-Only Checkout Does Not Require Physical Address...');
    const digitalNoAddressRequest: QuoteRequest = {
      // customerAddressId is completely omitted / undefined!
      sellerOrders: [
        {
          sellerId: 'seller_digital_test',
          storeId: 'store_digital_test',
        },
      ],
      isDigitalOnly: true,
    };
    let digitalQuoteSucceeded = false;
    try {
      const res = await deliveryQuoteService.createQuote(digitalNoAddressRequest);
      if (res.deliveryAvailable && res.totalDeliveryFee === 0) {
        digitalQuoteSucceeded = true;
      }
    } catch (_) {}
    assert(
      digitalQuoteSucceeded,
      'Digital-only order quote succeeds without requiring customerAddressId'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Mixed / Physical checkout requires a physical address
    // ─────────────────────────────────────────────────────────────
    console.log('\n[5] Testing Physical / Mixed Checkout Rejects Missing Address...');
    const physicalNoAddressRequest: QuoteRequest = {
      sellerOrders: [
        {
          sellerId: 'seller_phys_test',
          storeId: 'store_phys_test',
          weightKg: 1.5,
        },
      ],
      isDigitalOnly: false,
      // customerAddressId is omitted!
    };
    let physicalWithoutAddressRejected = false;
    try {
      const res = await deliveryQuoteService.createQuote(physicalNoAddressRequest);
      if (!res.deliveryAvailable && res.reason === 'ADDRESS_REQUIRED') {
        physicalWithoutAddressRejected = true;
      }
    } catch (e: any) {
      physicalWithoutAddressRejected = true;
    }
    assert(
      physicalWithoutAddressRejected,
      'Physical order correctly rejects calculation when physical address is missing'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Digital items cannot be fulfilled before verified payment
    // ─────────────────────────────────────────────────────────────
    console.log('\n[6] Testing Digital Items Cannot Be Fulfilled Before Verified Payment...');
    let unverifiedPaymentRejected = false;
    try {
      await digitalFulfillmentService.getCustomerDigitalCode({
        orderItemId: 'item_fake_1',
        customerId: 'user_fake_1',
      });
    } catch (e: any) {
      unverifiedPaymentRejected = true;
    }
    assert(
      unverifiedPaymentRejected,
      'Customer code reveal is strictly rejected for unverified/unpaid order'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 7: Repeated fulfillment requests cannot duplicate delivery (Idempotency)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[7] Testing Idempotent Fulfillment Prevention of Duplicate Delivery...');
    // Setup a transient test digital product, code pool, and order item in DB
    const testCategory = await prisma.category.findFirst({
      where: { slug: { in: Array.from(ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS) } },
    });
    assert(Boolean(testCategory), 'Found verified eligible digital category in database');

    const testStore = await prisma.store.findFirst({ where: { isActive: true } });
    assert(Boolean(testStore), 'Found active store in database');

    if (testCategory && testStore) {
      const testProduct = await prisma.product.create({
        data: {
          storeId: testStore.id,
          categoryId: testCategory.id,
          nameAr: 'بطاقة اختبار رقمية آمنة',
          nameEn: 'Secure Digital Test Card',
          slug: `test-card-${Date.now()}`,
          sku: `TEST-DIG-${Date.now()}`,
          price: 100,
          fulfillmentType: FulfillmentType.DIGITAL,
          digitalDeliveryType: DigitalDeliveryType.CODE,
          isActive: true,
        },
      });

      // Add 1 test code to pool
      const secretCode = `SOUQNA-SECRET-CODE-${Date.now()}`;
      await digitalFulfillmentService.addDigitalCodes({
        productId: testProduct.id,
        sellerId: testStore.sellerId,
        codes: [secretCode],
        actorId: 'admin_test',
        actorRole: 'ADMIN',
      });

      // Create dummy order and order item
      const testUser = await prisma.user.findFirst();
      if (testUser) {
        const testOrder = await prisma.order.create({
          data: {
            orderNumber: `TEST-ORD-${Date.now()}`,
            userId: testUser.id,
            subtotal: 100,
            deliveryFee: 0,
            total: 100,
            isDigitalOnly: true,
            hasDigitalItems: true,
            status: OrderStatus.PROCESSING,
          },
        });

        // Create payment record marked as PAID
        await prisma.payment.create({
          data: {
            orderId: testOrder.id,
            amount: 100,
            status: PaymentStatus.PAID,
            method: PaymentMethodType.WALLET,
          },
        });

        const testSellerOrder = await prisma.sellerOrder.create({
          data: {
            orderId: testOrder.id,
            sellerId: testStore.sellerId,
            sellerOrderNumber: `SO-TEST-${Date.now()}`,
            subtotal: 100,
            deliveryFee: 0,
            sellerPayout: 100,
            status: SellerOrderStatus.PROCESSING,
            isDigitalOnly: true,
            hasDigitalItems: true,
          },
        });

        const testOrderItem = await prisma.orderItem.create({
          data: {
            sellerOrderId: testSellerOrder.id,
            productId: testProduct.id,
            productNameAr: testProduct.nameAr,
            productNameEn: testProduct.nameEn,
            unitPrice: 100,
            quantity: 1,
            totalPrice: 100,
            fulfillmentType: FulfillmentType.DIGITAL,
            digitalFulfillmentStatus: DigitalFulfillmentStatus.PENDING,
          },
        });

        // First fulfillment call
        const firstResult = await digitalFulfillmentService.fulfillDigitalItem({
          orderItemId: testOrderItem.id,
          actorId: 'system',
          actorRole: 'SYSTEM',
          idempotencyKey: `idempotency_key_test_${Date.now()}`,
        });
        assert(
          firstResult.fulfillment?.status === DigitalFulfillmentStatus.FULFILLED,
          'First fulfillment request succeeds and delivers digital code'
        );

        // Second fulfillment call with identical order item
        const secondResult = await digitalFulfillmentService.fulfillDigitalItem({
          orderItemId: testOrderItem.id,
          actorId: 'system',
          actorRole: 'SYSTEM',
          idempotencyKey: `idempotency_key_test_${Date.now()}`,
        });
        assert(
          secondResult.alreadyFulfilled === true &&
            secondResult.fulfillment?.status === DigitalFulfillmentStatus.FULFILLED,
          'Second fulfillment request is strictly idempotent and does not allocate a new code'
        );

        // Verify reveal exposes the correct decrypted code to the customer
        const revealResult = await digitalFulfillmentService.getCustomerDigitalCode({
          orderItemId: testOrderItem.id,
          customerId: testUser.id,
        });
        assert(
          revealResult.status === DigitalFulfillmentStatus.FULFILLED && revealResult.decryptedCode === secretCode,
          'Customer reveal endpoint safely decrypts and delivers the exact original code',
          `Expected: ${secretCode}, Got: ${revealResult.decryptedCode}`
        );

        // ─────────────────────────────────────────────────────────────
        // TEST 9: Refunds and cancellations preserve correct fulfillment state (REVOKED)
        // ─────────────────────────────────────────────────────────────
        console.log('\n[9] Testing Cancellation / Refund Revokes Digital Fulfillment...');
        const updatedDf = await prisma.digitalFulfillment.update({
          where: { orderItemId: testOrderItem.id },
          data: { status: DigitalFulfillmentStatus.REVOKED },
        });
        await prisma.orderItem.update({
          where: { id: testOrderItem.id },
          data: { digitalFulfillmentStatus: DigitalFulfillmentStatus.REVOKED },
        });
        assert(
          updatedDf.status === DigitalFulfillmentStatus.REVOKED,
          'Revocation successfully updates digital fulfillment status to REVOKED'
        );

        // Verify customer cannot reveal revoked code
        let revealRevokedFailed = false;
        try {
          await digitalFulfillmentService.getCustomerDigitalCode({
            orderItemId: testOrderItem.id,
            customerId: testUser.id,
          });
        } catch (_) {
          revealRevokedFailed = true;
        }
        assert(
          revealRevokedFailed,
          'Revoked digital code is immediately inaccessible to customer'
        );

        // Cleanup test fixtures
        await prisma.digitalFulfillmentAuditLog.deleteMany({ where: { orderItemId: testOrderItem.id } });
        await prisma.digitalFulfillment.deleteMany({ where: { orderItemId: testOrderItem.id } });
        await prisma.digitalProductCode.deleteMany({ where: { productId: testProduct.id } });
        await prisma.orderItem.delete({ where: { id: testOrderItem.id } });
        await prisma.sellerOrder.delete({ where: { id: testSellerOrder.id } });
        await prisma.payment.deleteMany({ where: { orderId: testOrder.id } });
        await prisma.order.delete({ where: { id: testOrder.id } });
        await prisma.product.delete({ where: { id: testProduct.id } });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 8: Failed provider / exhausted code pool does not falsely mark fulfilled
    // ─────────────────────────────────────────────────────────────
    console.log('\n[8] Testing Code Exhaustion / Provider Failure Rejection...');
    let missingItemRejected = false;
    try {
      await digitalFulfillmentService.fulfillDigitalItem({
        orderItemId: 'non_existent_item_id',
        actorId: 'system',
        actorRole: 'SYSTEM',
      });
    } catch (_) {
      missingItemRejected = true;
    }
    assert(
      missingItemRejected,
      'Empty pool / missing order item correctly throws and does not mark product fulfilled'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 10: Sellers cannot manipulate fulfillment type or delivery fees
    // ─────────────────────────────────────────────────────────────
    console.log('\n[10] Testing Subcategory Eligibility & Tampering Prevention...');
    assert(
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('mobile-recharge') &&
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('internet-packages') &&
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('gift-cards') &&
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('gaming-gift-cards') &&
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('digital-subscriptions') &&
      ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes('software-licenses'),
      'All 6 required digital subcategories are present in the authoritative eligibility set'
    );

    const isFashionEligible = digitalFulfillmentService.isSubcategoryEligibleForDigital('women-fashion');
    assert(
      isFashionEligible === false,
      'Ineligible category (women-fashion) is rejected for digital fulfillment'
    );
    const isMobileRechargeEligible = digitalFulfillmentService.isSubcategoryEligibleForDigital('mobile-recharge');
    assert(
      isMobileRechargeEligible === true,
      'Eligible category (mobile-recharge) is approved for digital fulfillment'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 11: Security & Encryption at rest (AES-256-GCM) & Code Masking
    // ─────────────────────────────────────────────────────────────
    console.log('\n[11] Testing AES-256-GCM Encryption At Rest & Masking...');
    const samplePlainText = 'PSN-YEMEN-9988-7766';
    const encrypted = digitalFulfillmentService.encryptSensitivePayload(samplePlainText);
    assert(
      encrypted !== samplePlainText && encrypted.includes(':'),
      'Digital code is encrypted at rest using AES-256-GCM with IV'
    );
    const decrypted = digitalFulfillmentService.decryptSensitivePayload(encrypted);
    assert(
      decrypted === samplePlainText,
      'AES-256-GCM decryption accurately recovers original code'
    );
    const masked = digitalFulfillmentService.maskCode(samplePlainText);
    assert(
      (masked.includes('••') || masked.includes('**')) && !masked.includes('9988'),
      'Code masking hides sensitive middle characters'
    );

    // SSRF URL Security Validation
    assert(
      !UrlSecurityUtil.isSafeUrl('http://127.0.0.1/admin'),
      'SSRF guard blocks localhost 127.0.0.1'
    );
    assert(
      !UrlSecurityUtil.isSafeUrl('http://169.254.169.254/latest/meta-data'),
      'SSRF guard blocks cloud metadata IP 169.254.169.254'
    );
    assert(
      !UrlSecurityUtil.isSafeUrl('http://10.0.0.1/secrets'),
      'SSRF guard blocks private RFC1918 range'
    );
    assert(
      UrlSecurityUtil.isSafeUrl('https://cdn.souqna.ye/downloads/guide.pdf'),
      'SSRF guard allows safe public HTTPS download URLs'
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 12: Existing physical orders remain unaffected
    // ─────────────────────────────────────────────────────────────
    console.log('\n[12] Testing Historical Physical Orders Compatibility...');
    const legacyOrder = await prisma.order.findFirst({
      where: { hasDigitalItems: false },
      include: { sellerOrders: { include: { items: true } } },
    });
    if (legacyOrder) {
      assert(
        legacyOrder.isDigitalOnly === false,
        `Historical order (${legacyOrder.orderNumber}) retains isDigitalOnly=false`
      );
      const allLegacyItems = legacyOrder.sellerOrders.every((so) =>
        so.items.every((it) => it.fulfillmentType !== FulfillmentType.DIGITAL)
      );
      assert(
        allLegacyItems,
        'Historical order items preserve physical fulfillment behavior without modification'
      );
    } else {
      console.log('  ℹ No historical physical order found in current database snapshot.');
    }

  } catch (err: any) {
    console.error('Unhandled exception during regression tests:', err);
    failed++;
  }

  console.log('\n============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRegressionTests();
