import { VoucherValidationService } from '../services/voucher-validation.service';
import { VoucherCalculationService } from '../services/voucher-calculation.service';
import { VoucherStackingService } from '../services/voucher-stacking.service';
import { VoucherFundingService } from '../services/voucher-funding.service';
import { CartEvaluationItem, VoucherErrorCode } from '../voucher.types';

async function runVoucherEngineTests() {
  console.log('--- Starting Voucher Engine Test Suite ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  // 1. Code Normalization & Validation
  {
    const norm = VoucherValidationService.normalizeCode(' save-500_yer ');
    assert(norm === 'SAVE500YER', 'Code normalization strips spaces and punctuation and capitalizes');

    let thrown = false;
    try {
      VoucherValidationService.validateCodeFormat('AB');
    } catch (e: any) {
      thrown = e.code === VoucherErrorCode.VOUCHER_INVALID;
    }
    assert(thrown, 'Rejects codes shorter than 3 chars');
  }

  // 2. Percentage Discount & Max Discount Capping
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-1',
        sellerId: 'seller-1',
        productNameAr: 'منتج تجريبي',
        productNameEn: 'Test Product',
        unitPrice: 20000,
        quantity: 1,
        totalPrice: 20000,
        isFlashSale: false,
      },
    ];

    const voucher = {
      id: 'v-pct',
      code: 'PCT20',
      ownerType: 'PLATFORM',
      voucherType: 'DISCOUNT',
      discountType: 'PERCENTAGE',
      discountValue: 20, // 20% of 20,000 = 4,000
      maximumDiscount: 2000, // Capped at 2,000
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'PLATFORM',
    };

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      vouchers: [voucher],
      currency: 'SAR',
    });

    assert(calc.totalDiscount === 2000, 'Percentage voucher correctly capped by maximumDiscount (2,000 instead of 4,000)');
    assert(calc.finalPayableTotal === 18000, 'Payable total is 18,000 after 2,000 discount');
    assert(calc.platformFunding === 2000, 'Platform funded discount equals 2,000');
  }

  // 3. Fixed Discount & Zero-Floor Protection
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-1',
        sellerId: 'seller-1',
        productNameAr: 'منتج',
        productNameEn: 'Item',
        unitPrice: 700,
        quantity: 1,
        totalPrice: 700,
        isFlashSale: false,
      },
    ];

    const voucher = {
      id: 'v-fix',
      code: 'FIX1000',
      ownerType: 'PLATFORM',
      voucherType: 'DISCOUNT',
      discountType: 'FIXED',
      discountValue: 1000,
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'PLATFORM',
    };

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      vouchers: [voucher],
      currency: 'SAR',
    });

    assert(calc.totalDiscount === 700, 'Fixed discount cannot exceed item eligible amount (700 max)');
    assert(calc.finalPayableTotal === 0, 'Final payable cannot become negative');
  }

  // 4. Multi-Seller Cart Isolation (Seller A Voucher Never Discounts Seller B)
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-a',
        sellerId: 'seller-a',
        productNameAr: 'منتج أ',
        productNameEn: 'Product A',
        unitPrice: 10000,
        quantity: 1,
        totalPrice: 10000,
        isFlashSale: false,
      },
      {
        id: '2',
        cartItemId: 'item-2',
        productId: 'prod-2',
        storeId: 'store-b',
        sellerId: 'seller-b',
        productNameAr: 'منتج ب',
        productNameEn: 'Product B',
        unitPrice: 20000,
        quantity: 1,
        totalPrice: 20000,
        isFlashSale: false,
      },
    ];

    const sellerAVoucher = {
      id: 'v-seller-a',
      code: 'SELLER20',
      ownerType: 'SELLER',
      sellerId: 'seller-a',
      voucherType: 'DISCOUNT',
      discountType: 'PERCENTAGE',
      discountValue: 20, // 20% of 10,000 = 2,000
      scopeType: 'SELLER',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'SELLER',
    };

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      vouchers: [sellerAVoucher],
      currency: 'SAR',
    });

    assert(calc.sellerBreakdowns['seller-a'].sellerDiscount === 2000, 'Seller A discount is 2,000');
    assert(calc.sellerBreakdowns['seller-b'].sellerDiscount === 0, 'Seller B discount is strictly 0');
    assert(calc.sellerFunding === 2000, 'Seller funded amount is 2,000');
    assert(calc.platformFunding === 0, 'Platform funded amount is 0');
  }

  // 5. Free Shipping Voucher & Stacking Rules (Platform + Seller + Free Shipping)
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-a',
        sellerId: 'seller-a',
        productNameAr: 'منتج أ',
        productNameEn: 'Product A',
        unitPrice: 10000,
        quantity: 1,
        totalPrice: 10000,
        isFlashSale: false,
      },
    ];

    const platformVoucher = {
      id: 'v-plat',
      code: 'PLAT10',
      ownerType: 'PLATFORM',
      voucherType: 'DISCOUNT',
      discountType: 'PERCENTAGE',
      discountValue: 10, // 10% = 1,000
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'PLATFORM',
    };

    const sellerVoucher = {
      id: 'v-sell',
      code: 'SELL500',
      ownerType: 'SELLER',
      sellerId: 'seller-a',
      voucherType: 'DISCOUNT',
      discountType: 'FIXED',
      discountValue: 500,
      scopeType: 'SELLER',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'SELLER',
    };

    const shippingVoucher = {
      id: 'v-ship',
      code: 'FREESHIP',
      ownerType: 'PLATFORM',
      voucherType: 'FREE_SHIPPING',
      maximumShippingDiscount: 15, // Capped at 15
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'PLATFORM',
    };

    // Stacking verification
    const stackCheck = VoucherStackingService.validateVoucherStack([
      platformVoucher,
      sellerVoucher,
      shippingVoucher,
    ]);
    assert(stackCheck.isValid, 'Platform + Seller + Free Shipping are legally stackable together');

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      shippingFee: 25,
      vouchers: [platformVoucher, sellerVoucher, shippingVoucher],
      currency: 'SAR',
    });

    assert(calc.sellerDiscount === 500, 'Seller discount is 500');
    assert(calc.platformDiscount === 950, 'Platform discount applied on remaining subtotal (9,500 * 10% = 950)');
    assert(calc.shippingDiscount === 15, 'Shipping discount is capped at 15 YER');
    assert(calc.finalShippingFee === 10, 'Customer pays remaining 10 YER delivery fee (25 - 15)');
    assert(calc.platformFunding === 965, 'Platform funding = 950 + 15 = 965');
    assert(calc.sellerFunding === 500, 'Seller funding = 500');
  }

  // 6. Minimum Spend Enforcement
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-1',
        sellerId: 'seller-1',
        productNameAr: 'منتج',
        productNameEn: 'Item',
        unitPrice: 3000,
        quantity: 1,
        totalPrice: 3000,
        isFlashSale: false,
      },
    ];

    const voucher = {
      id: 'v-min',
      code: 'MIN5000',
      ownerType: 'PLATFORM',
      voucherType: 'DISCOUNT',
      discountType: 'FIXED',
      discountValue: 500,
      minimumOrderAmount: 5000, // Requires 5000
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
    };

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      vouchers: [voucher],
      currency: 'SAR',
    });

    assert(calc.appliedVouchers.length === 0, 'Voucher rejected when order subtotal is below minimumOrderAmount');
    assert(calc.rejectedVouchers[0]?.reasonCode === VoucherErrorCode.VOUCHER_MINIMUM_ORDER_NOT_MET, 'Correct error code returned for unmet minimum spend');
  }

  // 7. Seller Payout & Funding Model
  {
    const payout = VoucherFundingService.calculateSellerPayout({
      sellerSubtotal: 10000,
      commissionAmount: 1000, // 10%
      sellerFundedDiscount: 1500,
      platformFundedDiscount: 1000,
    });

    // Seller payout: Subtotal 10,000 - SellerDiscount 1,500 - Commission 1,000 = 7,500.
    // (Platform discount 1,000 does NOT reduce seller payout).
    assert(payout.sellerPayout === 7500, 'Seller payout correctly absorbs seller discount only, platform discount does not reduce payout');
  }

  // 8. Flash Sale Discount Base
  {
    const items: CartEvaluationItem[] = [
      {
        id: '1',
        cartItemId: 'item-1',
        productId: 'prod-1',
        storeId: 'store-1',
        sellerId: 'seller-1',
        productNameAr: 'منتج عرض سريع',
        productNameEn: 'Flash Product',
        unitPrice: 10000, // Original 10,000
        quantity: 1,
        totalPrice: 7000,
        isFlashSale: true,
        flashSaleUnitPrice: 7000, // Flash Sale 7,000
      },
    ];

    const voucher = {
      id: 'v-flash',
      code: 'PCT10',
      ownerType: 'PLATFORM',
      voucherType: 'DISCOUNT',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      scopeType: 'PLATFORM',
      status: 'ACTIVE',
      startAt: new Date(Date.now() - 10000),
      endAt: new Date(Date.now() + 1000000),
      fundingType: 'PLATFORM',
    };

    const calc = await VoucherCalculationService.calculateCartDiscounts({
      items,
      vouchers: [voucher],
      currency: 'SAR',
    });

    // 10% of 7,000 = 700 (NOT 10% of 10,000)
    assert(calc.totalDiscount === 700, 'Discount is calculated from Flash Sale price (7,000), not original price');
    assert(calc.finalPayableTotal === 6300, 'Final payable is 6,300');
  }

  console.log(`\n================================`);
  console.log(`Total tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runVoucherEngineTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
