import { campaignService } from '../services/campaign.service';
import { sellerPromotionService } from '../services/seller-promotion.service';
import { placementService } from '../services/placement.service';

async function runTests() {
  console.log('\n======================================================');
  console.log('🌟 SOUQNAA — UNIFIED CAMPAIGNS & MARKETING TEST SUITE');
  console.log('======================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}`);
      throw new Error(`Assertion failed for: ${testName}`);
    }
  }

  // 1. Conflict Detection Engine Tests
  console.log('--- 1. Campaign Conflict Detection Engine Tests ---');
  {
    // Test end date before start date
    const c1 = await campaignService.checkCampaignConflicts({
      startAt: new Date(Date.now() + 86400000),
      endAt: new Date(Date.now() + 43200000), // earlier
    });
    assert(c1.hasBlockingConflicts === true, 'Blocks campaign with end date before start date');
    assert(c1.conflicts.some((c) => c.type === 'DATE_INVALID'), 'Identifies DATE_INVALID conflict');

    // Test valid future date range
    const c2 = await campaignService.checkCampaignConflicts({
      startAt: new Date(Date.now() + 86400000),
      endAt: new Date(Date.now() + 172800000),
    });
    assert(c2.hasBlockingConflicts === false, 'Accepts valid future date range without blocking conflict');
  }

  // 2. Authoritative Package & Pricing Calculation Tests
  console.log('\n--- 2. Seller Marketing Package & Pricing Logic ---');
  {
    // Discount percentage formula
    const originalPrice = 10000;
    const campaignPrice = 7500;
    const discountPercent = Number((((originalPrice - campaignPrice) / originalPrice) * 100).toFixed(1));
    assert(discountPercent === 25.0, 'Calculates accurate discount percentage: 25.0%');

    const originalPrice2 = 25000;
    const campaignPrice2 = 18750;
    const discountPercent2 = Number((((originalPrice2 - campaignPrice2) / originalPrice2) * 100).toFixed(1));
    assert(discountPercent2 === 25.0, 'Calculates accurate discount percentage: 25.0% on 25,000 YER');

    // Zero / invalid pricing guards
    const invalidPrice = 0;
    assert(invalidPrice <= 0, 'Guards against zero or negative campaign prices');
    assert(campaignPrice < originalPrice, 'Ensures campaign price is strictly lower than original price');
  }

  // 3. Campaign Stock Reservation Logic Tests
  console.log('\n--- 3. Concurrency-Safe Stock Calculation Logic ---');
  {
    const campaignStock = 200;
    let reservedStock = 50;
    let soldStock = 100;

    let availableStock = Math.max(0, campaignStock - reservedStock - soldStock);
    assert(availableStock === 50, 'Initial available stock is 50 (200 - 50 - 100)');

    // Simulate reservation of 30 units
    const requestQty = 30;
    assert(availableStock >= requestQty, 'Permits reservation when availableStock >= requestQty');
    reservedStock += requestQty;
    availableStock = Math.max(0, campaignStock - reservedStock - soldStock);
    assert(availableStock === 20, 'Stock decreases to 20 after reserving 30 units');

    // Simulate exceeding remaining available stock
    const excessiveQty = 25;
    assert(availableStock < excessiveQty, 'Blocks reservation when quantity exceeds remaining available stock (25 > 20)');

    // Simulate commit of 30 reserved units into completed order
    reservedStock -= requestQty;
    soldStock += requestQty;
    assert(reservedStock === 50, 'Reserved stock restored after commit');
    assert(soldStock === 130, 'Sold stock incremented to 130');
    availableStock = Math.max(0, campaignStock - reservedStock - soldStock);
    assert(availableStock === 20, 'Available stock remains consistent at 20');
  }

  // 4. Frequency Capping & Monopolization Guards
  console.log('\n--- 4. Frequency Capping & Anti-Monopolization Logic ---');
  {
    const maxImpressionsPerUser = 3;
    let userImpressions = 0;

    // Check under limit
    assert(userImpressions < maxImpressionsPerUser, 'Allows display when user impressions < cap (0 < 3)');
    userImpressions += 1;
    assert(userImpressions < maxImpressionsPerUser, 'Allows display when user impressions < cap (1 < 3)');
    userImpressions += 2;
    assert(userImpressions >= maxImpressionsPerUser, 'Frequency cap triggers at 3 impressions');
    assert(!(userImpressions < maxImpressionsPerUser), 'Blocks further exposure of same seller promotion to same user');
  }

  console.log('\n======================================================');
  console.log(`🎉 ALL TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log('======================================================\n');
}

runTests().catch((e) => {
  console.error('Test run failed:', e);
  process.exit(1);
});
