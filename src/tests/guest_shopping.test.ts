import { GuestService } from '../modules/guest/guest.service';

async function runTests() {
  console.log('====================================================');
  console.log('SOUQNAA — GUEST SHOPPING BACKEND TEST SUITE');
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
    // TEST 1: Guest Session Creation & Restoration
    // -------------------------------------------------------------
    console.log('--- 1. Testing Guest Session Creation & Restoration ---');
    const newSession = GuestService.createOrRestoreSession();
    assert(
      !!newSession.guestSessionId && newSession.guestSessionId.length === 36,
      'Generates valid 36-char UUID v4 session ID',
      `Got: ${newSession.guestSessionId}`
    );

    const expiresDate = new Date(newSession.expiresAt);
    const createdDate = new Date(newSession.createdAt);
    const diffDays = Math.round((expiresDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
    assert(
      diffDays === 30,
      'Sets 30-day session expiration policy',
      `Diff days: ${diffDays}`
    );

    // Session restoration
    const restoredSession = GuestService.createOrRestoreSession(newSession.guestSessionId);
    assert(
      restoredSession.guestSessionId === newSession.guestSessionId,
      'Restores valid existing session ID',
      `Expected ${newSession.guestSessionId}, got: ${restoredSession.guestSessionId}`
    );

    // Invalid format fallback
    const fallbackSession = GuestService.createOrRestoreSession('invalid-uuid-1234');
    assert(
      fallbackSession.guestSessionId !== 'invalid-uuid-1234' && fallbackSession.guestSessionId.length === 36,
      'Replaces invalid UUID format with fresh random UUID',
      `Got: ${fallbackSession.guestSessionId}`
    );

    // -------------------------------------------------------------
    // TEST 2: Empty Cart Validation
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Empty Cart Validation ---');
    const emptyCartValidation = await GuestService.validateCart({ items: [] });
    assert(
      emptyCartValidation.itemCount === 0 && emptyCartValidation.stores.length === 0,
      'Empty items returns 0 stores and 0 count',
      `Stores: ${emptyCartValidation.stores.length}, Count: ${emptyCartValidation.itemCount}`
    );
    assert(
      emptyCartValidation.subtotal === 0,
      'Empty items returns 0 subtotal'
    );

    // -------------------------------------------------------------
    // TEST 3: Wishlist Validation with Empty Items
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing Wishlist Validation ---');
    const emptyWishlist = await GuestService.validateWishlist([]);
    assert(
      emptyWishlist.totalCount === 0 && emptyWishlist.items.length === 0,
      'Empty wishlist items returns 0 items'
    );

    // -------------------------------------------------------------
    // TEST 4: Checkout Preparation Validation
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing Checkout Preparation Input Validation ---');
    let threwError = false;
    try {
      await GuestService.prepareCheckout({
        guestSessionId: newSession.guestSessionId,
        items: [],
        contact: { fullName: '', phoneNumber: '' },
        address: { city: '', street: '' },
      });
    } catch {
      threwError = true;
    }
    assert(
      threwError,
      'Throws error when preparing checkout with empty cart/invalid contact'
    );

    console.log('\n====================================================');
    console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal test error:', error);
    process.exit(1);
  }
}

runTests();
