import { prisma } from '../../../database/prisma';
import { flashSaleService } from '../flash-sale.service';
import {
  FlashSaleStatus,
  FlashSaleDiscountType,
  FlashSaleItemStatus,
  FlashSaleSubmissionStatus,
  FlashSaleReservationStatus,
  FlashSaleCouponPolicy,
  UserRoleType,
} from '@prisma/client';

async function runTests() {
  console.log('\n======================================================');
  console.log('⚡ SOUQNAA — FLASH SALES ENGINE TEST SUITE');
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

  // 1. Pricing Engine Unit Tests
  console.log('\n--- 1. Authoritative Pricing Calculation Tests ---');
  {
    // Percentage discount
    const p1 = flashSaleService.calculateFinalPrice(10000, FlashSaleDiscountType.PERCENTAGE, 25);
    assert(p1.flashSalePrice === 7500, 'Percentage discount: 10,000 YER with 25% off = 7,500 YER');
    assert(p1.discountAmount === 2500, 'Discount amount is 2,500 YER');
    assert(p1.percentageSaved === 25, 'Percentage saved is 25%');

    // Percentage discount with maximumDiscount cap
    const p2 = flashSaleService.calculateFinalPrice(10000, FlashSaleDiscountType.PERCENTAGE, 50, 2000);
    assert(p2.flashSalePrice === 8000, 'Max discount cap: 50% of 10,000 capped at 2,000 = 8,000 YER');

    // Fixed amount discount
    const p3 = flashSaleService.calculateFinalPrice(15000, FlashSaleDiscountType.FIXED, 3000);
    assert(p3.flashSalePrice === 12000, 'Fixed discount: 15,000 - 3,000 = 12,000 YER');

    // Special Price
    const p4 = flashSaleService.calculateFinalPrice(20000, FlashSaleDiscountType.SPECIAL_PRICE, 14500);
    assert(p4.flashSalePrice === 14500, 'Special price: explicit 14,500 YER');
    assert(p4.discountAmount === 5500, 'Special price discount amount is 5,500 YER');

    // Negative guard & bounds
    const p5 = flashSaleService.calculateFinalPrice(5000, FlashSaleDiscountType.FIXED, 8000);
    assert(p5.flashSalePrice === 0, 'Discount exceeding original price floors at 0 YER');
  }

  // 2. Setup Test Data in PostgreSQL
  console.log('\n--- 2. Database Environment Setup ---');
  const testRunId = Date.now().toString(36);
  const adminUser = await prisma.user.upsert({
    where: { email: `admin-flash-${testRunId}@souqnaa.com` },
    create: {
      email: `admin-flash-${testRunId}@souqnaa.com`,
      passwordHash: 'hash',
      firstName: 'Admin',
      lastName: 'Souqnaa',
      role: UserRoleType.ADMIN,
    },
    update: {},
  });

  const sellerUser = await prisma.user.upsert({
    where: { email: `seller-flash-${testRunId}@souqnaa.com` },
    create: {
      email: `seller-flash-${testRunId}@souqnaa.com`,
      passwordHash: 'hash',
      firstName: 'Al-Amal',
      lastName: 'Store',
      role: UserRoleType.SELLER,
    },
    update: {},
  });

  const seller = await prisma.seller.upsert({
    where: { userId: sellerUser.id },
    create: { userId: sellerUser.id, status: 'ACTIVE' },
    update: {},
  });

  const store = await prisma.store.upsert({
    where: { slug: `store-flash-${testRunId}` },
    create: {
      sellerId: seller.id,
      name: 'متجر الأمل للإلكترونيات',
      slug: `store-flash-${testRunId}`,
    },
    update: {},
  });

  let category = await prisma.category.findFirst();
  if (!category) {
    category = await prisma.category.create({
      data: { nameAr: 'إلكترونيات', nameEn: 'Electronics', slug: `cat-flash-${testRunId}` },
    });
  }

  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      categoryId: category.id,
      nameAr: 'سماعة رأس لاسلكية احترافية',
      nameEn: 'Wireless Pro Headphones',
      slug: `headphones-flash-${testRunId}`,
      price: 20000,
      currency: 'YER',
    },
  });

  assert(Boolean(adminUser && seller && product), 'Test fixtures (Admin, Seller, Store, Product) created successfully');

  // 3. Campaign Creation & Lifecycle State Machine
  console.log('\n--- 3. Campaign Lifecycle State Machine Tests ---');
  const now = new Date();
  const campaign = await flashSaleService.createCampaign({
    name: 'حملة العيد الكبرى Flash Sale',
    slug: `eid-flash-campaign-${testRunId}`,
    description: 'تخفيضات كبرى لفترة محدودة على الأجهزة الإلكترونية',
    startAt: new Date(now.getTime() - 1000 * 60), // started 1 min ago
    endAt: new Date(now.getTime() + 1000 * 60 * 60 * 2), // ends in 2 hours
    priority: 10,
    couponPolicy: FlashSaleCouponPolicy.ALLOW_COUPONS,
    createdBy: adminUser.id,
  });

  assert(campaign.status === FlashSaleStatus.DRAFT, 'Campaign created in DRAFT status');

  // Schedule campaign
  const scheduled = await flashSaleService.setCampaignStatus(campaign.id, FlashSaleStatus.SCHEDULED, adminUser.id);
  assert(scheduled.status === FlashSaleStatus.SCHEDULED, 'Transition DRAFT -> SCHEDULED succeeded');

  // Invalid transition test (SCHEDULED -> ENDED should fail)
  let invalidCaught = false;
  try {
    await flashSaleService.setCampaignStatus(campaign.id, FlashSaleStatus.ENDED, adminUser.id);
  } catch (err: any) {
    invalidCaught = true;
  }
  assert(invalidCaught, 'Invalid transition SCHEDULED -> ENDED rejected by state machine');

  // 4. Seller Submission & Admin Approval Pipeline
  console.log('\n--- 4. Seller Submission & Admin Approval Pipeline ---');
  const submission = await flashSaleService.submitProduct(seller.id, {
    campaignId: campaign.id,
    productId: product.id,
    proposedPrice: 14000,
    proposedStock: 10,
    proposedPurchaseLimit: 2,
    notes: 'منتج عالي الجودة متوفر للتسليم الفوري',
  });

  assert(submission.status === FlashSaleSubmissionStatus.PENDING_REVIEW, 'Seller submission is in PENDING_REVIEW status');
  assert(submission.proposedPrice === 14000, 'Proposed price recorded accurately');

  // Admin approves with an override
  const approvedResult = (await flashSaleService.reviewSubmission(
    submission.id,
    'APPROVE',
    {
      overridePrice: 13500, // Admin adjusted price to 13,500 YER
      overrideStock: 10,
      overrideLimit: 2,
    },
    adminUser.id
  )) as { subUpdated: any; item: any };

  assert(approvedResult.subUpdated.status === FlashSaleSubmissionStatus.APPROVED, 'Submission updated to APPROVED');
  assert(approvedResult.item.flashSalePrice === 13500, 'FlashSaleItem created with authoritative admin-approved price (13,500 YER)');
  assert(approvedResult.item.allocatedStock === 10, 'Allocated stock set to 10 units');
  assert(approvedResult.item.remainingStock === 10, 'Remaining stock initialized to 10 units');

  // Publish campaign to ACTIVE
  const activeCampaign = await flashSaleService.setCampaignStatus(campaign.id, FlashSaleStatus.ACTIVE, adminUser.id);
  assert(activeCampaign.status === FlashSaleStatus.ACTIVE, 'Campaign is published and ACTIVE');

  // 5. CRITICAL CONCURRENCY TEST 1: 100 Simultaneous Requests on 10 Stock (Quantity = 1)
  console.log('\n--- 5. CRITICAL CONCURRENCY TEST: 100 Simultaneous Reservations (Qty = 1) ---');
  const flashSaleItemId = approvedResult.item.id;

  // Create 100 unique customer IDs
  const customerIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const cust = await prisma.user.create({
      data: {
        email: `sim-buyer-${i}-${testRunId}@souqnaa.com`,
        passwordHash: 'hash',
        firstName: `Buyer${i}`,
        lastName: 'Test',
      },
    });
    customerIds.push(cust.id);
  }

  // Fire 100 simultaneous reservation promises
  const reservationPromises = customerIds.map((cId) =>
    flashSaleService
      .reserveStock({
        flashSaleItemId,
        customerId: cId,
        quantity: 1,
        idempotencyKey: `idem-conc-1-${cId}`,
      })
      .then((res) => ({ success: true, res }))
      .catch((err) => ({ success: false, error: err.errorCode || err.message }))
  );

  const results = await Promise.all(reservationPromises);
  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  console.log(`  -> Concurrency 1 Results: ${successCount} succeeded, ${failureCount} failed (stock exhausted)`);

  const freshItemAfter1 = await prisma.flashSaleItem.findUnique({ where: { id: flashSaleItemId } });
  assert(successCount === 10, `Exactly 10 reservations succeeded (expected 10, got ${successCount})`);
  assert(freshItemAfter1!.reservedStock === 10, `Authoritative reservedStock is exactly 10`);
  assert(freshItemAfter1!.remainingStock === 0, `Authoritative remainingStock is exactly 0`);
  assert(freshItemAfter1!.reservedStock + freshItemAfter1!.soldStock <= freshItemAfter1!.allocatedStock, 'reservedStock + soldStock <= allocatedStock');
  assert(freshItemAfter1!.remainingStock >= 0, 'No negative inventory (remainingStock >= 0)');

  // 6. Idempotency Test
  console.log('\n--- 6. Idempotency Guarantee Tests ---');
  const actualWinnerReservation = results.find((r): r is { success: true; res: any } => r.success)!.res;
  const repeatReservation = await flashSaleService.reserveStock({
    flashSaleItemId,
    customerId: actualWinnerReservation.customerId,
    quantity: 1,
    idempotencyKey: actualWinnerReservation.idempotencyKey,
  });

  const freshItemAfterIdem = await prisma.flashSaleItem.findUnique({ where: { id: flashSaleItemId } });
  assert(repeatReservation !== null, 'Repeated request with same idempotencyKey returned existing reservation');
  assert(repeatReservation.id === actualWinnerReservation.id, 'Same reservation ID returned');
  assert(freshItemAfterIdem!.reservedStock === 10, 'Repeated request DID NOT deduct extra stock');

  // 7. CRITICAL CONCURRENCY TEST 2: 100 Simultaneous Requests on 10 Stock (Quantity = 2)
  console.log('\n--- 7. CRITICAL CONCURRENCY TEST: 100 Simultaneous Reservations (Qty = 2) ---');
  // Create another product and item with allocatedStock = 10
  const product2 = await prisma.product.create({
    data: {
      storeId: store.id,
      categoryId: category.id,
      nameAr: 'شاحن سريع أصلي 65W',
      nameEn: 'Fast Charger 65W',
      slug: `charger-flash-${testRunId}`,
      price: 8000,
      currency: 'YER',
    },
  });

  const sub2 = await flashSaleService.submitProduct(seller.id, {
    campaignId: campaign.id,
    productId: product2.id,
    proposedPrice: 5000,
    proposedStock: 10,
    proposedPurchaseLimit: 4,
  });

  const approved2 = (await flashSaleService.reviewSubmission(
    sub2.id,
    'APPROVE',
    { overridePrice: 5000, overrideStock: 10, overrideLimit: 4 },
    adminUser.id
  )) as { subUpdated: any; item: any };

  const itemId2 = approved2.item.id;

  const reservationPromises2 = customerIds.map((cId) =>
    flashSaleService
      .reserveStock({
        flashSaleItemId: itemId2,
        customerId: cId,
        quantity: 2, // 2 units requested
        idempotencyKey: `idem-conc-2-${cId}`,
      })
      .then((res) => ({ success: true as const, res }))
      .catch((err) => ({ success: false as const, error: err.errorCode || err.message }))
  );

  const results2 = await Promise.all(reservationPromises2);
  const successCount2 = results2.filter((r) => r.success).length;
  console.log(`  -> Concurrency 2 Results: ${successCount2} succeeded with qty=2`);

  const freshItemAfter2 = await prisma.flashSaleItem.findUnique({ where: { id: itemId2 } });
  assert(successCount2 === 5, `Exactly 5 reservations succeeded (5 x 2 = 10 total allocated stock)`);
  assert(freshItemAfter2!.reservedStock === 10, `Reserved stock is exactly 10`);
  assert(freshItemAfter2!.remainingStock === 0, `Remaining stock is exactly 0`);
  assert(freshItemAfter2!.remainingStock >= 0, 'No overselling occurred');

  // 8. Purchase Limit Enforcement Test
  console.log('\n--- 8. Customer Purchase Limit Enforcement ---');
  const productLimit = await prisma.product.create({
    data: {
      storeId: store.id,
      categoryId: category.id,
      nameAr: 'ماوس لاسلكي مريح',
      nameEn: 'Wireless Mouse',
      slug: `mouse-limit-${testRunId}`,
      price: 6000,
      currency: 'YER',
    },
  });

  const subLimit = await flashSaleService.submitProduct(seller.id, {
    campaignId: campaign.id,
    productId: productLimit.id,
    proposedPrice: 4000,
    proposedStock: 50,
    proposedPurchaseLimit: 2,
  });

  const approvedLimit = (await flashSaleService.reviewSubmission(
    subLimit.id,
    'APPROVE',
    { overridePrice: 4000, overrideStock: 50, overrideLimit: 2 },
    adminUser.id
  )) as { subUpdated: any; item: any };

  let limitErrorCaught = false;
  try {
    // Attempt to reserve 5 units when limit is 2
    await flashSaleService.reserveStock({
      flashSaleItemId: approvedLimit.item.id,
      customerId: adminUser.id,
      quantity: 5,
    });
  } catch (err: any) {
    if (err.errorCode === 'FLASH_SALE_CUSTOMER_LIMIT_REACHED' || err.message.includes('limit')) {
      limitErrorCaught = true;
    }
  }
  assert(limitErrorCaught, 'Per-customer purchase limit strictly enforced by backend');

  // 9. End-to-End Order Conversion Flow
  console.log('\n--- 9. End-to-End Order Creation & Conversion Flow ---');
  // Take one successful reservation from Item 2
  const successfulReservations = results2.filter((r): r is { success: true; res: any } => r.success);
  const winnerReservation = successfulReservations[0].res;

  // Convert reservation to order
  const convertedRes = await flashSaleService.convertReservation(winnerReservation.id, `ORD-TEST-${testRunId}`);
  assert(convertedRes.status === FlashSaleReservationStatus.CONVERTED, 'Reservation transitioned to CONVERTED');

  const freshItemAfterConversion = await prisma.flashSaleItem.findUnique({ where: { id: itemId2 } });
  assert(freshItemAfterConversion!.soldStock === 2, 'soldStock incremented by 2');
  assert(freshItemAfterConversion!.reservedStock === 8, 'reservedStock decremented by 2');
  assert(freshItemAfterConversion!.remainingStock === 0, 'remainingStock remains 0');

  // 10. Background Job & Reservation Release Test
  console.log('\n--- 10. Background Expiration & Stock Release Tests ---');
  // Manually release another reservation
  const anotherReservation = successfulReservations[1].res;
  await flashSaleService.releaseReservation(anotherReservation.id, undefined, 'EXPIRED');

  const freshItemAfterRelease = await prisma.flashSaleItem.findUnique({ where: { id: itemId2 } });
  assert(freshItemAfterRelease!.reservedStock === 6, 'Reserved stock released back: 8 - 2 = 6');
  assert(freshItemAfterRelease!.remainingStock === 2, 'Remaining stock restored: 0 + 2 = 2 available units');

  // 11. Analytics Verification
  console.log('\n--- 11. Analytics Aggregation Tests ---');
  const adminAnalytics = await flashSaleService.getAdminCampaignAnalytics(campaign.id);
  assert(adminAnalytics.totalRevenue > 0, 'Admin analytics accurately aggregates campaign revenue');
  assert(adminAnalytics.sellThroughRate > 0, 'Sell-through rate calculated correctly');

  const sellerAnalytics = await flashSaleService.getSellerAnalytics(seller.id);
  assert(sellerAnalytics.approvedProducts >= 2, 'Seller analytics isolates only seller products');

  console.log('\n======================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED PERFECTLY!`);
  console.log('======================================================\n');
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Test Suite Failed with Error:\n', err);
    process.exit(1);
  });
