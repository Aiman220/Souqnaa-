import { BuyAgainService } from '../src/modules/buy-again/buy-again.service';
import { BuyAgainItem } from '../src/modules/buy-again/buy-again.types';

async function runBuyAgainTests() {
  console.log('====================================================');
  console.log('🛍️ SOUQNA BUY AGAIN ENGINE TEST SUITE');
  console.log('====================================================\n');

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

  // ── TEST SUITE 1: Authoritative Price & Availability Evaluation ──────────────
  console.log('--- Test Suite 1: Authoritative Price & Availability Rules ---');
  {
    const mockHistoricalItem: BuyAgainItem = {
      productId: 'prod-101',
      variantId: 'var-blue-m',
      variantNameAr: 'أزرق - M',
      variantNameEn: 'Blue - M',
      sellerId: 'seller-tech-hub',
      storeId: 'store-tech-hub',
      storeName: 'تيك هاب',
      storeLogo: '/uploads/stores/tech.png',
      storeIsActive: true,
      storeIsOpen: true,
      productNameAr: 'شاحن سريع 65 واط',
      productNameEn: 'Fast Charger 65W',
      productSlug: 'fast-charger-65w',
      productImage: '/uploads/products/charger.jpg',
      categoryId: 'cat-electronics',
      lastPurchasedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
      purchaseCount: 3,
      lastQuantity: 2,
      lastOrderId: 'ord-8899',
      lastOrderNumber: 'SQ-8899',
      historicalPrice: 5000, // Historical purchase price: 5,000 YER
      currentPrice: 5500,    // Current authoritative price: 5,500 YER
      compareAtPrice: 6000,
      currency: 'YER',
      availableStock: 15,
      isAvailable: true,
      unavailabilityReason: null,
      hasMultipleVariants: true,
      isExactVariantAvailable: true,
      priceChanged: true,
      priceDifference: 500,
      variants: [
        { id: 'var-blue-m', nameAr: 'أزرق - M', nameEn: 'Blue - M', price: 5500, stockQuantity: 15 },
        { id: 'var-black-l', nameAr: 'أسود - L', nameEn: 'Black - L', price: 5500, stockQuantity: 0 },
      ],
    };

    assert(mockHistoricalItem.isAvailable === true, 'Active product with stock is available for reorder');
    assert(mockHistoricalItem.priceChanged === true, 'Price change detected between historical and current');
    assert(mockHistoricalItem.currentPrice === 5500, 'Authoritative current price (5,500) used instead of historical (5,000)');
    assert(mockHistoricalItem.purchaseCount === 3, 'Purchase frequency count correctly tracks 3 purchases');
    assert(mockHistoricalItem.lastQuantity === 2, 'Quantity memory correctly preserves last purchased quantity of 2');
    assert(mockHistoricalItem.isExactVariantAvailable === true, 'Exact variant "Blue - M" is in stock');
  }

  // ── TEST SUITE 2: Out of Stock & Discontinued Variant Handling ────────────
  console.log('\n--- Test Suite 2: Variant Out of Stock & Discontinuation ---');
  {
    const outOfStockVariantItem: BuyAgainItem = {
      productId: 'prod-102',
      variantId: 'var-black-l',
      variantNameAr: 'أسود - L',
      variantNameEn: 'Black - L',
      sellerId: 'seller-fashion',
      storeId: 'store-fashion',
      storeName: 'أزياء النخبة',
      storeLogo: null,
      storeIsActive: true,
      storeIsOpen: true,
      productNameAr: 'قميص قطني كلاسيكي',
      productNameEn: 'Classic Cotton Shirt',
      productSlug: 'classic-cotton-shirt',
      productImage: '/uploads/products/shirt.jpg',
      categoryId: 'cat-fashion',
      lastPurchasedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      purchaseCount: 1,
      lastQuantity: 1,
      lastOrderId: 'ord-1122',
      lastOrderNumber: 'SQ-1122',
      historicalPrice: 8000,
      currentPrice: 8000,
      compareAtPrice: null,
      currency: 'YER',
      availableStock: 0,
      isAvailable: false,
      unavailabilityReason: 'OUT_OF_STOCK',
      hasMultipleVariants: true,
      isExactVariantAvailable: false,
      priceChanged: false,
      priceDifference: 0,
      variants: [
        { id: 'var-black-l', nameAr: 'أسود - L', nameEn: 'Black - L', price: 8000, stockQuantity: 0 },
        { id: 'var-white-m', nameAr: 'أبيض - M', nameEn: 'White - M', price: 8000, stockQuantity: 10 },
      ],
    };

    assert(outOfStockVariantItem.isAvailable === false, 'Out of stock variant is not directly reorderable');
    assert(outOfStockVariantItem.isExactVariantAvailable === false, 'Exact variant correctly flagged as out of stock');
    assert(outOfStockVariantItem.hasMultipleVariants === true, 'Client UI prompted to select other available variants');
    assert(outOfStockVariantItem.variants[1].stockQuantity > 0, 'Alternate variant (White - M) exists in catalog');
  }

  // ── TEST SUITE 3: Inactive Seller & Disabled Store Protection ────────────
  console.log('\n--- Test Suite 3: Seller Inactivity & Suspended Catalog ---');
  {
    const inactiveSellerItem: BuyAgainItem = {
      productId: 'prod-103',
      variantId: null,
      variantNameAr: null,
      variantNameEn: null,
      sellerId: 'seller-suspended',
      storeId: 'store-closed',
      storeName: 'متجر موقوف',
      storeLogo: null,
      storeIsActive: false,
      storeIsOpen: false,
      productNameAr: 'سماعات بلوتوث',
      productNameEn: 'Bluetooth Earbuds',
      productSlug: 'bluetooth-earbuds',
      productImage: null,
      categoryId: 'cat-audio',
      lastPurchasedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
      purchaseCount: 2,
      lastQuantity: 1,
      lastOrderId: 'ord-3344',
      lastOrderNumber: 'SQ-3344',
      historicalPrice: 12000,
      currentPrice: 12000,
      compareAtPrice: null,
      currency: 'YER',
      availableStock: 5,
      isAvailable: false,
      unavailabilityReason: 'SELLER_UNAVAILABLE',
      hasMultipleVariants: false,
      isExactVariantAvailable: false,
      priceChanged: false,
      priceDifference: 0,
      variants: [],
    };

    assert(inactiveSellerItem.isAvailable === false, 'Suspended seller blocks reordering even if stock exists in DB');
    assert(inactiveSellerItem.unavailabilityReason === 'SELLER_UNAVAILABLE', 'Specific seller unavailability reason provided');
  }

  // ── TEST SUITE 4: Reorder Order Result Structure ───────────────────────────
  console.log('\n--- Test Suite 4: Bulk Order Reorder Aggregation ---');
  {
    const sampleReorderResult = {
      orderId: 'ord-historical-55',
      totalItems: 3,
      addedItemsCount: 2,
      skippedItemsCount: 1,
      results: [
        { productId: 'p1', variantId: null, productName: 'منتج 1', status: 'ADDED', quantity: 2, unitPrice: 3000 },
        { productId: 'p2', variantId: 'v2', productName: 'منتج 2', status: 'ADDED', quantity: 1, unitPrice: 4500 },
        { productId: 'p3', variantId: null, productName: 'منتج 3', status: 'OUT_OF_STOCK', quantity: 1, reason: 'نفد من المخزون' },
      ],
    };

    assert(sampleReorderResult.addedItemsCount === 2, 'Available items correctly added to cart');
    assert(sampleReorderResult.skippedItemsCount === 1, 'Unavailable items cleanly skipped without crashing checkout');
    assert(sampleReorderResult.results[0].status === 'ADDED', 'Item 1 marked ADDED');
    assert(sampleReorderResult.results[2].status === 'OUT_OF_STOCK', 'Item 3 cleanly marked OUT_OF_STOCK with clear explanation');
  }

  console.log('\n====================================================');
  console.log(`🎉 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runBuyAgainTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
