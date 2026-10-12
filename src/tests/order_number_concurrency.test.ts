import { prisma } from '../database/prisma';
import { OrderNumberService } from '../services/orders/order-number.service';

async function runTests() {
  console.log('====================================================');
  console.log('SOUQNAA — ORDER NUMBERING & CONCURRENCY TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      if (details) console.error(`       Details: ${details}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Format & Specification Compliance
    // -------------------------------------------------------------
    console.log('--- 1. Testing Format & Specification Compliance ---');
    const fixedDate = new Date('2026-09-25T12:00:00Z');
    const formatted = OrderNumberService.formatPublicOrderNumber(123, fixedDate);
    assert(
      formatted === 'SQ-2026-0925-000123',
      'Public order number matches SQ-YYYY-MMDD-NNNNNN',
      `Expected SQ-2026-0925-000123, got: ${formatted}`
    );

    const shortDisplay = OrderNumberService.formatDisplayShort('SQ-2026-0925-000123');
    assert(
      shortDisplay === '#SQ-000123',
      'Short display matches #SQ-000123',
      `Expected #SQ-000123, got: ${shortDisplay}`
    );

    const s01 = OrderNumberService.generateSellerOrderNumber('SQ-2026-0925-000123', 1);
    assert(
      s01 === 'SQ-2026-0925-000123-S01',
      'Seller sub-order 1 matches SQ-YYYY-MMDD-NNNNNN-S01',
      `Expected SQ-2026-0925-000123-S01, got: ${s01}`
    );

    const s02 = OrderNumberService.generateSellerOrderNumber('SQ-2026-0925-000123', 2);
    assert(
      s02 === 'SQ-2026-0925-000123-S02',
      'Seller sub-order 2 matches SQ-YYYY-MMDD-NNNNNN-S02',
      `Expected SQ-2026-0925-000123-S02, got: ${s02}`
    );

    const shortSeller01 = OrderNumberService.formatSellerDisplayShort(s01);
    assert(
      shortSeller01 === '#SQ-000123-S01',
      'Seller short display matches #SQ-000123-S01',
      `Expected #SQ-000123-S01, got: ${shortSeller01}`
    );

    // Multi-vendor grouping
    const multiSellerSubOrders = OrderNumberService.generateSellerSubOrders('SQ-2026-0925-000123', 3);
    assert(
      multiSellerSubOrders.length === 3 &&
        multiSellerSubOrders[0].sellerOrderNumber === 'SQ-2026-0925-000123-S01' &&
        multiSellerSubOrders[1].sellerOrderNumber === 'SQ-2026-0925-000123-S02' &&
        multiSellerSubOrders[2].sellerOrderNumber === 'SQ-2026-0925-000123-S03',
      'Multi-vendor sub-orders assigned deterministic S01, S02, S03 sequentially'
    );

    // -------------------------------------------------------------
    // TEST 2: Single Atomic Reservation from Database
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Atomic Database Sequence Reservation ---');
    const singleResult = await OrderNumberService.generateNextOrderNumber();
    assert(
      typeof singleResult.orderSequence === 'number' && singleResult.orderSequence > 0,
      'Order sequence is a positive integer',
      `Sequence: ${singleResult.orderSequence}`
    );
    assert(
      /^SQ-\d{4}-\d{4}-\d{6}$/.test(singleResult.orderNumber),
      'Order number matches public format regex',
      `Generated: ${singleResult.orderNumber}`
    );
    assert(
      singleResult.displayOrderNumber.startsWith('SQ-'),
      'Display order number starts with SQ-',
      `Display: ${singleResult.displayOrderNumber}`
    );
    assert(
      OrderNumberService.formatDisplayShort(singleResult.orderNumber).startsWith('#SQ-'),
      'Short display helper starts with #SQ-',
      `Short display: ${OrderNumberService.formatDisplayShort(singleResult.orderNumber)}`
    );

    // -------------------------------------------------------------
    // TEST 3: High Concurrency Stress Test (120 Concurrent Requests)
    // -------------------------------------------------------------
    const CONCURRENCY_COUNT = 120;
    console.log(`\n--- 3. Stress-Testing Concurrency: ${CONCURRENCY_COUNT} Simultaneous Checkouts ---`);
    console.log(`Firing ${CONCURRENCY_COUNT} concurrent sequence reservations simultaneously...`);

    const startTime = Date.now();
    const concurrentPromises = Array.from({ length: CONCURRENCY_COUNT }, () =>
      OrderNumberService.generateNextOrderNumber()
    );

    const results = await Promise.all(concurrentPromises);
    const durationMs = Date.now() - startTime;
    console.log(`Completed ${CONCURRENCY_COUNT} concurrent reservations in ${durationMs}ms (${(durationMs / CONCURRENCY_COUNT).toFixed(2)}ms/req)`);

    const orderNumbers = results.map((r) => r.orderNumber);
    const sequences = results.map((r) => r.orderSequence);

    const uniqueOrderNumbers = new Set(orderNumbers);
    const uniqueSequences = new Set(sequences);

    assert(
      uniqueOrderNumbers.size === CONCURRENCY_COUNT,
      `Zero duplicate order numbers: exactly ${uniqueOrderNumbers.size}/${CONCURRENCY_COUNT} unique`,
      `Duplicates detected: ${CONCURRENCY_COUNT - uniqueOrderNumbers.size}`
    );

    assert(
      uniqueSequences.size === CONCURRENCY_COUNT,
      `Zero duplicate sequences: exactly ${uniqueSequences.size}/${CONCURRENCY_COUNT} unique`,
      `Duplicate sequences: ${CONCURRENCY_COUNT - uniqueSequences.size}`
    );

    const sortedSequences = [...sequences].sort((a, b) => a - b);
    const minSeq = sortedSequences[0];
    const maxSeq = sortedSequences[sortedSequences.length - 1];
    const rangeSpan = maxSeq - minSeq + 1;

    assert(
      rangeSpan === CONCURRENCY_COUNT,
      `Sequence is strictly continuous with zero gaps (Range: ${minSeq} to ${maxSeq}, Span: ${rangeSpan})`,
      `Expected span of ${CONCURRENCY_COUNT}, got: ${rangeSpan}`
    );

    // -------------------------------------------------------------
    // TEST 4: Idempotency Verification
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing Idempotency & Duplicate Prevention ---');
    const testIdempotencyKey = `test-idemp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Find any existing customer or admin user to link to test order
    const existingUser = await prisma.user.findFirst({ select: { id: true } });
    if (existingUser) {
      // Create first order with idempotencyKey
      const orderNumInfo = await OrderNumberService.generateNextOrderNumber();
      const createdOrder = await prisma.order.create({
        data: {
          idempotencyKey: testIdempotencyKey,
          userId: existingUser.id,
          orderNumber: orderNumInfo.orderNumber,
          orderSequence: orderNumInfo.orderSequence,
          displayOrderNumber: orderNumInfo.displayOrderNumber,
          subtotal: 100.0,
          total: 100.0,
          currency: 'YER',
          status: 'PENDING',
        },
      });

      // Simulate idempotent retry check
      const retryLookup = await prisma.order.findUnique({
        where: { idempotencyKey: testIdempotencyKey },
      });

      assert(
        retryLookup !== null && retryLookup.id === createdOrder.id,
        'Idempotency key correctly resolves existing order on retry',
        `Original ID: ${createdOrder.id}, Lookup ID: ${retryLookup?.id}`
      );
      assert(
        retryLookup?.orderNumber === createdOrder.orderNumber,
        'Idempotent retry returns identical orderNumber without generating a new one',
        `Order Number: ${retryLookup?.orderNumber}`
      );

      // Clean up test order
      await prisma.order.delete({ where: { id: createdOrder.id } });
      console.log('Cleaned up idempotency test order record.');
    } else {
      console.log('Skipping DB insert idempotency test: no user found.');
    }

    // -------------------------------------------------------------
    // SUMMARY
    // -------------------------------------------------------------
    console.log('\n====================================================');
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error during test execution:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
