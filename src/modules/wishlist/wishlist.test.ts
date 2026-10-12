import { prisma } from '../../database/prisma';
import { WishlistService } from './wishlist.service';

/**
 * Self-contained automated verification test suite for سوقناا Wishlist System
 */
async function runWishlistTests() {
  console.log('🧪 Starting Wishlist System Automated Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    // 1. Setup test user and products
    let testUser = await prisma.user.findFirst({
      where: { role: 'CUSTOMER' },
    });

    if (!testUser) {
      testUser = await prisma.user.create({
        data: {
          email: `test_wishlist_${Date.now()}@souqnaa.com`,
          passwordHash: 'dummy',
          firstName: 'مستخدم',
          lastName: 'تجريبي',
          role: 'CUSTOMER',
        },
      });
    }

    const testProduct = await prisma.product.findFirst({
      where: { isActive: true },
      include: { variants: true },
    });

    if (!testProduct) {
      throw new Error('No active test product found in database. Run seed first.');
    }

    console.log(`👤 Using Test Customer: ${testUser.id} (${testUser.firstName})`);
    console.log(`📦 Using Test Product: ${testProduct.id} (${testProduct.nameAr})`);

    // Clean up wishlist for test user
    const existingWishlist = await prisma.wishlist.findUnique({ where: { userId: testUser.id } });
    if (existingWishlist) {
      await prisma.wishlistItem.deleteMany({ where: { wishlistId: existingWishlist.id } });
    }

    // ── Test 1: Add to Wishlist ───────────────────────────────────────────────
    console.log('\n--- 1. Add to Wishlist ---');
    const addedItem = await WishlistService.addItem(testUser.id, {
      productId: testProduct.id,
      alertPreferences: { priceDrop: true, backInStock: true },
    });
    assert(addedItem !== null && addedItem.productId === testProduct.id, 'Item added to wishlist with authoritative snapshot price');
    assert(addedItem.addedPrice === testProduct.price, 'Snapshot addedPrice matches authoritative product price');

    // ── Test 2: Duplicate Protection ──────────────────────────────────────────
    console.log('\n--- 2. Duplicate Protection ---');
    const duplicateAdd = await WishlistService.addItem(testUser.id, {
      productId: testProduct.id,
    });
    assert(duplicateAdd.id === addedItem.id, 'Duplicate add safely updates item instead of creating duplicates');

    const countAfterDuplicate = await WishlistService.getWishlistCount(testUser.id);
    assert(countAfterDuplicate === 1, 'Wishlist count remains 1 after duplicate add');

    // ── Test 3: Membership Check (Single & Bulk) ──────────────────────────────
    console.log('\n--- 3. Membership Checks ---');
    const isWishlisted = await WishlistService.isWishlisted(testUser.id, testProduct.id);
    assert(isWishlisted === true, 'Single product membership check returns true');

    const isNotWishlisted = await WishlistService.isWishlisted(testUser.id, 'non_existent_product_123');
    assert(isNotWishlisted === false, 'Non-wishlisted product check returns false');

    const bulkCheck = await WishlistService.checkManyWishlist(testUser.id, [
      testProduct.id,
      'non_existent_product_123',
    ]);
    assert(bulkCheck[testProduct.id] === true && bulkCheck['non_existent_product_123'] === false, 'Bulk membership check returns accurate mapping');

    // ── Test 4: Paginated Wishlist with Price Drop Metadata ───────────────────
    console.log('\n--- 4. Paginated Query & Price Drop Calculation ---');
    // Simulate a price drop: set addedPrice higher than current price
    await prisma.wishlistItem.update({
      where: { id: addedItem.id },
      data: { addedPrice: testProduct.price + 50 },
    });

    const wishlistQuery = await WishlistService.getWishlist(testUser.id, {
      filter: 'price_dropped',
    });
    assert(wishlistQuery.items.length === 1, 'Filter price_dropped successfully filters price-dropped items');
    assert(wishlistQuery.items[0].isPriceDropped === true, 'isPriceDropped flag is true');
    assert(wishlistQuery.items[0].priceDropAmount === 50, 'priceDropAmount is calculated accurately (50 SAR)');

    // ── Test 5: Toggle Endpoint ───────────────────────────────────────────────
    console.log('\n--- 5. Toggle Item ---');
    const toggleRemove = await WishlistService.toggleItem(testUser.id, {
      productId: testProduct.id,
    });
    assert(toggleRemove.wishlisted === false, 'Toggle removes item when already present');

    const countAfterToggleRemove = await WishlistService.getWishlistCount(testUser.id);
    assert(countAfterToggleRemove === 0, 'Count is 0 after toggle remove');

    const toggleAdd = await WishlistService.toggleItem(testUser.id, {
      productId: testProduct.id,
    });
    assert(toggleAdd.wishlisted === true, 'Toggle adds item when not present');

    // ── Test 6: Move to Cart (Single Item) ────────────────────────────────────
    console.log('\n--- 6. Atomic Move to Cart ---');
    const moveResult = await WishlistService.moveToCart(testUser.id, testProduct.id);
    assert(moveResult.success === true, 'Single item moved to cart successfully');

    const countAfterMove = await WishlistService.getWishlistCount(testUser.id);
    assert(countAfterMove === 0, 'Item removed from wishlist after moving to cart');

    const cart = await prisma.cart.findUnique({
      where: { userId: testUser.id },
      include: { items: true },
    });
    const cartHasProduct = cart?.items.some((i) => i.productId === testProduct.id);
    assert(cartHasProduct === true, 'Cart contains the moved product');

    // ── Test 7: Move All to Cart ──────────────────────────────────────────────
    console.log('\n--- 7. Move All to Cart ---');
    // Add product back to wishlist
    const itemToMoveAll = await WishlistService.addItem(testUser.id, { productId: testProduct.id });
    const moveAllResult = await WishlistService.moveAllToCart(testUser.id);
    assert(moveAllResult.moved.length >= 1, 'Move all to cart processed eligible items');
    assert(moveAllResult.moved[0].productId === testProduct.id, 'Moved product id matches');

    // ── Test 8: Price-Drop Alert Evaluation & Spam Cooldown ──────────────────
    console.log('\n--- 8. Background Alert Engine ---');
    // Re-add product and simulate price drop
    const itemForAlert = await WishlistService.addItem(testUser.id, { productId: testProduct.id });
    await prisma.wishlistAlert.deleteMany({ where: { wishlistItemId: itemForAlert.id } });
    await prisma.wishlistItem.update({
      where: { id: itemForAlert.id },
      data: { addedPrice: testProduct.price * 1.25, currentPrice: testProduct.price, lastNotifiedPrice: null },
    });

    const alertResult = await WishlistService.evaluatePriceDrops({
      defaultThresholdPercent: 1.0,
      cooldownHours: 24,
    });
    assert(alertResult.detectedDrops >= 1, 'Price-drop alert engine detected drop and generated notification');

    // Cooldown test: run immediately again, should not create duplicate
    const secondAlertResult = await WishlistService.evaluatePriceDrops({
      defaultThresholdPercent: 1.0,
      cooldownHours: 24,
    });
    assert(secondAlertResult.notificationsSent === 0, 'Spam protection cooldown prevented duplicate notification');

    // ── Test 9: Admin Settings & Analytics ────────────────────────────────────
    console.log('\n--- 9. Admin Settings & Analytics ---');
    const adminAnalytics = await WishlistService.getAdminWishlistAnalytics();
    assert(adminAnalytics.kpis.totalWishlists >= 1, 'Admin analytics returns total wishlists KPI');
    assert(Array.isArray(adminAnalytics.topWishlistedProducts), 'Admin analytics returns top wishlisted products');

    const updatedSettings = await WishlistService.updateWishlistSettings({
      priceDropThreshold: 7.5,
      priceDropCooldownHours: 12,
    });
    assert(updatedSettings.priceDropThreshold === 7.5, 'Admin settings price drop threshold updated to 7.5%');
    assert(updatedSettings.priceDropCooldownHours === 12, 'Admin settings cooldown updated to 12 hours');

    console.log(`\n========================================`);
    console.log(`🎉 ALL TESTS COMPLETED: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Test runner error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runWishlistTests();
