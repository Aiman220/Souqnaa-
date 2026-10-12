import { prisma } from '../../../database/prisma';
import { VoucherClaimService } from '../services/voucher-claim.service';
import { VoucherRedemptionService } from '../services/voucher-redemption.service';

async function runConcurrencyTests() {
  console.log('--- Starting Voucher Concurrency & Idempotency Test Suite ---');
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

  // Find or create test customer
  let testCustomer = await prisma.user.findFirst({ where: { email: 'concurrency_test_customer@souqnaa.com' } });
  if (!testCustomer) {
    testCustomer = await prisma.user.create({
      data: {
        email: 'concurrency_test_customer@souqnaa.com',
        firstName: 'Test',
        lastName: 'Customer',
        passwordHash: 'dummy_hash',
      },
    });
  }

  // 1. Claim Concurrency Test (claimLimit = 1, perCustomerClaimLimit = 1)
  {
    const voucher = await prisma.voucher.create({
      data: {
        code: `CONCUR_CLAIM_${Date.now()}`,
        normalizedCode: `CONCURCLAIM${Date.now()}`,
        name: 'Concurrency Claim Test Voucher',
        ownerType: 'PLATFORM',
        voucherType: 'DISCOUNT',
        discountType: 'FIXED',
        discountValue: 100,
        scopeType: 'PLATFORM',
        isClaimable: true,
        claimLimit: 10,
        perCustomerClaimLimit: 1, // Only 1 allowed per customer
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 1000000),
        status: 'ACTIVE',
      },
    });

    // 50 simultaneous requests from same customer to claim
    const attempts = 50;
    const promises = Array.from({ length: attempts }).map(() =>
      VoucherClaimService.claimVoucher({
        voucherId: voucher.id,
        customerId: testCustomer!.id,
      }).then(
        () => true,
        () => false
      )
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r === true).length;

    assert(successes === 1, `Claim concurrency: 50 simultaneous claims resulted in exactly 1 success (actual: ${successes})`);

    const customerVouchersInDb = await prisma.customerVoucher.count({
      where: { voucherId: voucher.id, customerId: testCustomer!.id },
    });
    assert(customerVouchersInDb === 1, `Database contains exactly 1 customer_voucher record (actual: ${customerVouchersInDb})`);
  }

  // 2. Usage Limit Concurrency Test (usageLimit = 5, 50 simultaneous redemption attempts)
  {
    const voucher = await prisma.voucher.create({
      data: {
        code: `CONCUR_USE_${Date.now()}`,
        normalizedCode: `CONCURUSE${Date.now()}`,
        name: 'Concurrency Usage Test Voucher',
        ownerType: 'PLATFORM',
        voucherType: 'DISCOUNT',
        discountType: 'FIXED',
        discountValue: 50,
        scopeType: 'PLATFORM',
        usageLimit: 5, // Max 5 uses
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 1000000),
        status: 'ACTIVE',
      },
    });

    // Create 50 distinct test orders
    const testOrders = [];
    for (let i = 0; i < 20; i++) {
      const ord = await prisma.order.create({
        data: {
          orderNumber: `ORD_CONCUR_${Date.now()}_${i}`,
          userId: testCustomer!.id,
          subtotal: 500,
          total: 450,
          status: 'PENDING',
        },
      });
      testOrders.push(ord);
    }

    // 20 simultaneous redemptions across orders
    const promises = testOrders.map((ord) =>
      prisma.$transaction(async (tx) => {
        await VoucherRedemptionService.redeemVouchersForOrder({
          tx,
          orderId: ord.id,
          customerId: testCustomer!.id,
          currency: 'SAR',
          vouchers: [voucher],
          allocations: [
            {
              productId: 'dummy',
              sellerId: 'dummy-seller',
              voucherId: voucher.id,
              discountAmount: 50,
              fundingType: 'PLATFORM',
            },
          ],
        });
      }).then(
        () => true,
        () => false
      )
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r === true).length;

    assert(
      successes <= 5,
      `Usage limit concurrency: 20 simultaneous redemptions capped at usageLimit 5 (actual successes: ${successes})`
    );

    const updatedVoucher = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    assert(
      (updatedVoucher?.usageCount || 0) <= 5,
      `Voucher usageCount in DB never exceeds 5 (actual: ${updatedVoucher?.usageCount})`
    );
  }

  // 3. Idempotency Test
  {
    const voucher = await prisma.voucher.create({
      data: {
        code: `IDEMPOTENT_${Date.now()}`,
        normalizedCode: `IDEMPOTENT${Date.now()}`,
        name: 'Idempotency Test Voucher',
        ownerType: 'PLATFORM',
        voucherType: 'DISCOUNT',
        discountType: 'FIXED',
        discountValue: 25,
        scopeType: 'PLATFORM',
        usageLimit: 10,
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 1000000),
        status: 'ACTIVE',
      },
    });

    const testOrder = await prisma.order.create({
      data: {
        orderNumber: `ORD_IDEM_${Date.now()}`,
        userId: testCustomer!.id,
        subtotal: 200,
        total: 175,
        status: 'PENDING',
      },
    });

    const idempotencyKey = `key-${Date.now()}`;

    // First attempt
    await prisma.$transaction(async (tx) => {
      await VoucherRedemptionService.redeemVouchersForOrder({
        tx,
        orderId: testOrder.id,
        customerId: testCustomer!.id,
        currency: 'SAR',
        vouchers: [voucher],
        allocations: [
          {
            productId: 'dummy',
            sellerId: 'dummy-seller',
            voucherId: voucher.id,
            discountAmount: 25,
            fundingType: 'PLATFORM',
          },
        ],
        idempotencyKey,
      });
    });

    // Repeated retry attempt with same idempotencyKey
    await prisma.$transaction(async (tx) => {
      await VoucherRedemptionService.redeemVouchersForOrder({
        tx,
        orderId: testOrder.id,
        customerId: testCustomer!.id,
        currency: 'SAR',
        vouchers: [voucher],
        allocations: [
          {
            productId: 'dummy',
            sellerId: 'dummy-seller',
            voucherId: voucher.id,
            discountAmount: 25,
            fundingType: 'PLATFORM',
          },
        ],
        idempotencyKey,
      });
    });

    const redemptionsCount = await prisma.voucherRedemption.count({
      where: { idempotencyKey },
    });
    assert(redemptionsCount === 1, `Idempotency: exactly 1 redemption record exists despite repeated retry (actual: ${redemptionsCount})`);

    const vInDb = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    assert(vInDb?.usageCount === 1, `Idempotency: voucher usageCount is exactly 1 (actual: ${vInDb?.usageCount})`);
  }

  console.log(`\n================================`);
  console.log(`Concurrency tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runConcurrencyTests()
  .catch((err) => {
    console.error('Concurrency test error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
