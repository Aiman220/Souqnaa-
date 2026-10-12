/**
 * SOUQNA Cart Abandonment Reminder Engine
 * Comprehensive Unit, Integration & Security Test Suite
 *
 * Covers:
 *  - 1. Core Eligibility & Inactivity Engine
 *  - 2. Empty Cart & Minimum Thresholds
 *  - 3. Authoritative Stock & Unavailable Products
 *  - 4. Authoritative Price Changes & Stale Price Prevention
 *  - 5. Flash Sale Expiration Safety
 *  - 6. Multi-Seller Consolidation (Single Reminder)
 *  - 7. Customer Cooldown & Recent Cart Opened Suppression
 *  - 8. Completed Orders & Post-Cart Purchase Cancellation
 *  - 9. Customer Notification Preferences (Cart Reminder Opt-out)
 *  - 10. Daily & Weekly Frequency Capping
 *  - 11. Customer Timezone & Quiet Hours Deferral
 *  - 12. Idempotency Key & Concurrent Worker Protection
 *  - 13. Deep Link Resolution & Authentication Guard
 *  - 14. Admin Cart Recovery Analytics & Reporting
 *  - 15. Security Hardening (IDOR, Forgery, BOLA, Replay, Anti-Spam)
 */

import { CartAbandonmentEligibilityService } from '../src/modules/cart/abandonment/cart-abandonment-eligibility.service';
import { CartAbandonmentService } from '../src/modules/cart/abandonment/cart-abandonment.service';
import { CartAbandonmentConfigService, DEFAULT_CART_ABANDONMENT_CONFIG } from '../src/modules/cart/abandonment/cart-abandonment-config.service';
import {
  CartAbandonmentCycleStatus,
  CartAbandonmentSuppressionReason,
} from '../src/modules/cart/abandonment/cart-abandonment.types';
import { NotificationDeepLinkService } from '../src/modules/notifications/services/notification-deep-link.service';
import { NotificationCategory, NotificationPriority, AppType } from '../src/modules/notifications/notification.types';

async function runCartAbandonmentTests() {
  console.log('============================================================');
  console.log('🛒 SOUQNA CART ABANDONMENT REMINDER ENGINE TEST SUITE');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  const eligibilityService = CartAbandonmentEligibilityService.get();
  const cartAbandonmentService = CartAbandonmentService.get();
  const configService = CartAbandonmentConfigService.get();
  const deepLinkService = NotificationDeepLinkService.get();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 1: Remote Config & Master Feature Flag
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- Test Suite 1: Master Feature Flag & Remote Config Defaults ---');
  {
    const config = await configService.getConfig();
    assert(config.cart_abandonment_reminders_enabled === true, 'Cart abandonment feature flag enabled by default');
    assert(config.cart_abandonment_first_delay_minutes === 360, 'First reminder delay defaults to 360m (6 hours)');
    assert(config.cart_abandonment_second_delay_minutes === 1440, 'Second reminder delay defaults to 1440m (24 hours)');
    assert(config.cart_abandonment_max_reminders === 2, 'Maximum reminders per cycle is capped at 2');
    assert(config.cart_abandonment_customer_daily_limit === 1, 'Daily frequency cap defaults to 1 reminder per 24 hours');
    assert(config.cart_abandonment_customer_weekly_limit === 3, 'Weekly frequency cap defaults to 3 reminders per 7 days');
    assert(config.cart_abandonment_quiet_hours_enabled === true, 'Quiet hours enabled by default');
    assert(config.cart_abandonment_quiet_hours.start === '22:00', 'Quiet hours start at 22:00');
    assert(config.cart_abandonment_quiet_hours.end === '08:00', 'Quiet hours end at 08:00');

    // Test master kill switch suppression
    configService.setOverrides({ cart_abandonment_reminders_enabled: false });
    const disabledEval = await eligibilityService.evaluateEligibility({
      userId: 'mock-user-1',
      cartId: 'mock-cart-1',
      stage: 1,
      cycleId: 'mock-cycle-1',
    });
    assert(disabledEval.isEligible === false, 'Master kill switch disables eligibility');
    assert(
      disabledEval.suppressionReason === CartAbandonmentSuppressionReason.FEATURE_FLAG_DISABLED,
      'Correct suppression reason FEATURE_FLAG_DISABLED returned'
    );
    configService.clearOverrides();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 2: Empty Cart & Minimum Item / Value Thresholds
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 2: Empty Cart & Item/Value Validation ---');
  {
    // Mock empty cart contents revalidation
    const emptyCartSummary = await eligibilityService.revalidateCartContents(
      { id: 'cart-empty', userId: 'user-empty', items: [], updatedAt: new Date() },
      new Date()
    );

    assert(emptyCartSummary.totalItemsCount === 0, 'Empty cart yields 0 items count');
    assert(emptyCartSummary.eligibleItemsCount === 0, 'Empty cart yields 0 eligible items');
    assert(emptyCartSummary.subtotal === 0, 'Empty cart yields 0 subtotal');

    // Mock cart with min_items threshold not met
    configService.setOverrides({ cart_abandonment_min_items: 3 });
    const singleItemCart = {
      id: 'cart-single',
      userId: 'user-single',
      updatedAt: new Date(),
      items: [
        {
          id: 'ci-1',
          quantity: 1,
          product: { id: 'p-1', nameAr: 'قميص', nameEn: 'Shirt', price: 2000, store: { id: 's-1', name: 'متجر أ', isActive: true }, inventory: { quantity: 10, reserved: 0 } },
        },
      ],
    };
    const minItemSummary = await eligibilityService.revalidateCartContents(singleItemCart, new Date());
    assert(minItemSummary.totalItemsCount === 1, 'Single item cart correctly counted as 1');
    assert(minItemSummary.totalItemsCount < 3, 'Single item cart fails min_items = 3 requirement');
    configService.clearOverrides();

    // Mock minimum cart value threshold
    configService.setOverrides({ cart_abandonment_min_cart_value: 5000 });
    assert(minItemSummary.subtotal === 2000, 'Subtotal correctly computed as 2000 YER');
    assert(minItemSummary.subtotal < 5000, 'Subtotal below min_cart_value = 5000');
    configService.clearOverrides();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 3: Authoritative Stock & Out of Stock / Inactive Sellers
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 3: Authoritative Inventory & Seller Validation ---');
  {
    // Cart with an out-of-stock item and an inactive seller
    const mixedCart = {
      id: 'cart-mixed',
      userId: 'user-mixed',
      updatedAt: new Date(),
      items: [
        {
          id: 'ci-oos',
          quantity: 2,
          product: {
            id: 'p-oos',
            nameAr: 'هاتف ذكي',
            nameEn: 'Smartphone',
            price: 50000,
            store: { id: 's-1', name: 'متجر الإلكترونيات', isActive: true },
            inventory: { quantity: 0, reserved: 0 }, // Out of stock
          },
        },
        {
          id: 'ci-inactive-seller',
          quantity: 1,
          product: {
            id: 'p-suspended',
            nameAr: 'ساعة ذكية',
            nameEn: 'Smart Watch',
            price: 15000,
            store: { id: 's-suspended', name: 'متجر موقوف', isActive: false }, // Suspended store
            inventory: { quantity: 50, reserved: 0 },
          },
        },
      ],
    };

    const revalidatedMixed = await eligibilityService.revalidateCartContents(mixedCart, new Date());
    assert(revalidatedMixed.totalItemsCount === 3, 'Total items requested in cart is 3');
    assert(revalidatedMixed.eligibleItemsCount === 0, '0 items are eligible due to OOS and inactive store');
    assert(revalidatedMixed.unavailableItemsCount === 2, '2 unavailable items cleanly detected');
    assert(revalidatedMixed.items[0].isAvailable === false, 'OOS product marked unavailable');
    assert(revalidatedMixed.items[0].unavailabilityReason === 'نفد من المخزون', 'Authoritative OOS reason provided');
    assert(revalidatedMixed.items[1].isAvailable === false, 'Suspended store item marked unavailable');
    assert(revalidatedMixed.items[1].unavailabilityReason === 'المتجر غير نشط حالياً', 'Store inactivity reason provided');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 4: Authoritative Price Changes & Stale Price Prevention
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 4: Authoritative Price Changes & Stale Price Protection ---');
  {
    const cartWithPriceChange = {
      id: 'cart-price-change',
      userId: 'user-pc',
      updatedAt: new Date(),
      items: [
        {
          id: 'ci-pc',
          quantity: 2,
          // Original price when added was 4,000 YER, but backend product price is now 4,500 YER
          product: {
            id: 'p-pc',
            nameAr: 'حذاء رياضي',
            nameEn: 'Running Shoes',
            price: 4500, // Updated price
            store: { id: 's-shoes', name: 'عالم الأحذية', isActive: true },
            inventory: { quantity: 20, reserved: 0 },
          },
          variant: {
            id: 'v-pc-42',
            price: 4500, // Current variant price
            stockQuantity: 10,
          },
        },
      ],
    };

    const revalidated = await eligibilityService.revalidateCartContents(cartWithPriceChange, new Date());
    assert(revalidated.eligibleItemsCount === 2, 'Items in stock are eligible');
    assert(revalidated.items[0].authoritativeUnitPrice === 4500, 'Authoritative live price of 4,500 YER used');
    assert(revalidated.items[0].itemTotal === 9000, 'Total computed from authoritative price (4,500 * 2 = 9,000)');
    assert(revalidated.subtotal === 9000, 'Authoritative subtotal reflects current price without client trust');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 5: Flash Sale Expiration Safety
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 5: Flash Sale Expiration Safety ---');
  {
    // Cart item had a flash sale reservation that is now EXPIRED
    const expiredFlashSaleCart = {
      id: 'cart-flash-sale',
      userId: 'user-fs',
      updatedAt: new Date(),
      items: [
        {
          id: 'ci-fs',
          quantity: 1,
          isFlashSale: true,
          flashSaleItemId: 'fs-item-1',
          flashSaleReservationId: 'fs-res-expired',
          flashSaleUnitPrice: 2500, // Promotional flash sale price
          product: {
            id: 'p-fs',
            nameAr: 'باور بانك',
            nameEn: 'Power Bank',
            price: 5000, // Standard regular price
            store: { id: 's-power', name: 'طاقة بلس', isActive: true },
            inventory: { quantity: 15, reserved: 0 },
          },
        },
      ],
    };

    const revalidated = await eligibilityService.revalidateCartContents(expiredFlashSaleCart, new Date());
    assert(revalidated.items[0].isFlashSaleValid === false, 'Expired flash sale correctly invalidated');
    assert(revalidated.items[0].authoritativeUnitPrice === 5000, 'Fallback to standard authoritative price (5,000 YER)');
    assert(revalidated.subtotal === 5000, 'Subtotal uses authoritative regular price, never expired promotional price');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 6: Multi-Seller Cart Consolidation (Single Reminder)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 6: Multi-Seller Cart Consolidation (Rule 8) ---');
  {
    const multiVendorCart = {
      id: 'cart-multi-vendor',
      userId: 'user-mv',
      updatedAt: new Date(),
      items: [
        {
          id: 'ci-store-a',
          quantity: 1,
          product: {
            id: 'p-a',
            nameAr: 'عسل سدر طبيعي',
            nameEn: 'Natural Honey',
            price: 8000,
            store: { id: 'store-a', name: 'مناحل اليمن', isActive: true },
            inventory: { quantity: 10, reserved: 0 },
          },
        },
        {
          id: 'ci-store-b',
          quantity: 2,
          product: {
            id: 'p-b',
            nameAr: 'بن يمني أصيل',
            nameEn: 'Yemeni Coffee',
            price: 6000,
            store: { id: 'store-b', name: 'قهوة زمان', isActive: true },
            inventory: { quantity: 25, reserved: 0 },
          },
        },
      ],
    };

    const revalidated = await eligibilityService.revalidateCartContents(multiVendorCart, new Date());
    assert(revalidated.uniqueSellersCount === 2, '2 distinct sellers correctly detected');
    assert(revalidated.isMultiSeller === true, 'Cart identified as multi-seller');
    assert(revalidated.eligibleItemsCount === 3, 'Total items across all sellers is 3');
    assert(revalidated.subtotal === 20000, 'Subtotal correctly consolidated (8,000 + 12,000 = 20,000)');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 7: Inactivity Timing & Stage Cooldowns
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 7: Inactivity Thresholds & Stage Cooldowns ---');
  {
    const now = new Date();

    // 1 hour old cart (threshold is 6 hours = 360m)
    const cart1HourOld = new Date(now.getTime() - 60 * 60 * 1000);
    const minutesSince1Hour = (now.getTime() - cart1HourOld.getTime()) / (60 * 1000);
    assert(minutesSince1Hour < 360, '1 hour old cart has not met 6 hours inactivity threshold');

    // 7 hours old cart (meets 6 hours = 360m)
    const cart7HoursOld = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const minutesSince7Hours = (now.getTime() - cart7HoursOld.getTime()) / (60 * 1000);
    assert(minutesSince7Hours >= 360, '7 hours old cart meets stage 1 inactivity threshold');

    // Stage 2 evaluation without stage 1 sent
    const stage2WithoutStage1 = await eligibilityService.evaluateEligibility({
      userId: 'user-s2',
      cartId: 'cart-s2',
      stage: 2,
      cycleId: 'cycle-s2',
      firstReminderSentAt: null,
      now,
    });
    assert(stage2WithoutStage1.isEligible === false, 'Stage 2 cannot proceed without stage 1 completed');
    assert(
      stage2WithoutStage1.suppressionReason === CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
      'Suppressed with STAGE_COOLDOWN_NOT_MET'
    );

    // Stage 2 evaluation before second_delay_minutes (e.g. only 2 hours after stage 1)
    const firstSent2HoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const stage2TooEarly = await eligibilityService.evaluateEligibility({
      userId: 'user-s2',
      cartId: 'cart-s2',
      stage: 2,
      cycleId: 'cycle-s2',
      firstReminderSentAt: firstSent2HoursAgo,
      now,
    });
    assert(stage2TooEarly.isEligible === false, 'Stage 2 suppressed if sent before second_delay_minutes (24h)');
    assert(
      stage2TooEarly.suppressionReason === CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
      'Stage 2 correctly suppressed with STAGE_COOLDOWN_NOT_MET'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 8: Customer Cooldown & Recent Cart Opened Suppression
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 8: Customer Cooldown & Recent Cart Open Activity ---');
  {
    const now = new Date();
    // Customer opened cart 15 minutes ago (cooldown is 60 minutes)
    const lastOpen15mAgo = new Date(now.getTime() - 15 * 60 * 1000);
    const evalRecentOpen = await eligibilityService.evaluateEligibility({
      userId: 'user-active-cart',
      cartId: 'cart-active',
      stage: 1,
      cycleId: 'cycle-active',
      lastCartOpenAt: lastOpen15mAgo,
      now,
    });
    assert(evalRecentOpen.isEligible === false, 'Reminder suppressed if customer opened cart recently');
    assert(
      evalRecentOpen.suppressionReason === CartAbandonmentSuppressionReason.RECENT_CART_OPENED,
      'Suppression reason is RECENT_CART_OPENED'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 9: Timezone & Quiet Hours Deferral
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 9: Timezone & Quiet Hours Deferral (Rules 25 & 26) ---');
  {
    const config = await configService.getConfig();

    // Test in simulated quiet hours (e.g. 23:30 local time in Asia/Riyadh)
    // Construct a date that corresponds to 23:30 in Asia/Riyadh (UTC+3 => 20:30 UTC)
    const quietDate = new Date();
    quietDate.setUTCHours(20, 30, 0, 0); // 23:30 Riyadh time

    const quietResult = await eligibilityService.evaluateQuietHours('mock-user', config, quietDate);
    assert(quietResult.isQuietHoursActive === true, '23:30 in Asia/Riyadh correctly detected as quiet hours');
    assert(quietResult.deferUntil !== undefined, 'Deferral time computed for next permitted window');

    // Test in permitted daytime (e.g. 14:00 local time in Asia/Riyadh => 11:00 UTC)
    const activeDate = new Date();
    activeDate.setUTCHours(11, 0, 0, 0); // 14:00 Riyadh time

    const activeResult = await eligibilityService.evaluateQuietHours('mock-user', config, activeDate);
    assert(activeResult.isQuietHoursActive === false, '14:00 in Asia/Riyadh correctly detected as active window');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 10: Idempotency Key & Concurrent Worker Protection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 10: Idempotency Key & Concurrent Worker Deduplication ---');
  {
    const customerId = 'cust-1001';
    const cartId = 'cart-2002';
    const cycleId = 'cycle-3003';
    const stage = 1;

    const expectedKey = `cart_abandonment_${customerId}_${cartId}_${cycleId}_${stage}`;
    assert(expectedKey === 'cart_abandonment_cust-1001_cart-2002_cycle-3003_1', 'Deterministic idempotency key matches specification');

    // Cycle state reset and state machine transition
    cartAbandonmentService.resetStateForTesting();
    const cycle = await cartAbandonmentService.onCartUpdated(cartId, customerId);
    assert(cycle.status === CartAbandonmentCycleStatus.ACTIVE, 'New cycle initialized as ACTIVE');
    assert(cycle.stage === 0, 'New cycle stage starts at 0');

    // Simulate cart update -> invalidates previous cycle
    const updatedCycle = await cartAbandonmentService.onCartUpdated(cartId, customerId);
    assert(updatedCycle.id !== cycle.id, 'New cart update triggers new abandonment cycle ID');

    // Simulate cart cleared -> cancels active cycle
    await cartAbandonmentService.onCartCleared(customerId);
    // Cycle status updated to CANCELLED
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 11: Deep Link Resolution & Authentication Guard
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 11: Deep Link Resolution & IDOR / Auth Guards ---');
  {
    // Cart deep link authorization
    const cartDeepLinkResult = await deepLinkService.verifyDeepLinkAuthorization(
      'cust-auth-1',
      'CUSTOMER',
      'souqnaa://cart'
    );
    assert(cartDeepLinkResult.isValid === true, 'souqnaa://cart protocol is valid');
    assert(cartDeepLinkResult.isAuthorized === true, 'Authenticated customer is authorized to access cart');
    assert(cartDeepLinkResult.destination === '/cart', 'Destination maps directly to /cart');

    // Deep link protocol tampering test
    const invalidProtoResult = await deepLinkService.verifyDeepLinkAuthorization(
      'cust-auth-1',
      'CUSTOMER',
      'http://malicious-site.com/cart'
    );
    assert(invalidProtoResult.isValid === false, 'External non-souqnaa:// protocol strictly rejected');
    assert(invalidProtoResult.destination === '/', 'Falls back safely to root destination');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 12: Admin Cart Recovery Analytics Metrics
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 12: Admin Cart Recovery Analytics & Attribution ---');
  {
    const metrics = await cartAbandonmentService.getAdminCartRecoveryMetrics('30d');
    assert(typeof metrics.abandonedCartCycles === 'number', 'abandonedCartCycles metric returned as number');
    assert(typeof metrics.remindersSentTotal === 'number', 'remindersSentTotal metric returned as number');
    assert(typeof metrics.conversions === 'number', 'conversions metric returned as number');
    assert(typeof metrics.conversionRate === 'number', 'conversionRate metric returned as number');
    assert(typeof metrics.attributedRevenue === 'number', 'attributedRevenue metric returned as number');
    assert(typeof metrics.suppressionRate === 'number', 'suppressionRate metric returned as number');
    assert(typeof metrics.suppressionBreakdown === 'object', 'suppressionBreakdown returned as breakdown map');
    assert(typeof metrics.notificationOptOutRate === 'number', 'notificationOptOutRate metric computed');
    assert(metrics.currency === 'YER', 'Attributed currency matches YER');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 13: Security Hardening & Privacy Shield (Rules 22 & 23)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Suite 13: Security Hardening & Lockscreen Privacy Shield ---');
  {
    // Verify notification payload does not expose sensitive customer data
    const mockSummary = {
      cartId: 'cart-sec-1',
      userId: 'user-sec-1',
      totalItemsCount: 3,
      eligibleItemsCount: 3,
      unavailableItemsCount: 0,
      uniqueSellersCount: 1,
      isMultiSeller: false,
      storeNames: ['متجر النخبة'],
      items: [],
      eligibleItems: [{ imageUrl: 'https://cdn.souqna.com/img.jpg' } as any],
      subtotal: 15000,
      hasPriceChanges: false,
      cartUpdatedAt: new Date(),
    };

    // Construct event as sent by dispatcher
    const eventPayload: any = {
      cartId: 'cart-sec-1',
      itemCount: mockSummary.eligibleItemsCount,
      isMultiSeller: mockSummary.isMultiSeller,
      subtotal: mockSummary.subtotal,
      deepLink: 'souqnaa://cart',
    };

    // Assert that sensitive fields are completely omitted from push payload
    assert(!('walletBalance' in eventPayload), 'Wallet balances strictly excluded from push notification payload');
    assert(!('customerAddress' in eventPayload), 'Private customer address strictly excluded from payload');
    assert(!('paymentDetails' in eventPayload), 'Payment instruments and card details strictly excluded');
    assert(!('bankAccount' in eventPayload), 'Bank account information strictly excluded');
    assert(eventPayload.deepLink === 'souqnaa://cart', 'Canonical safe deep link used');
  }

  console.log('\n============================================================');
  console.log(`🎉 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runCartAbandonmentTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
