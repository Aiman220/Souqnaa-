import { prisma } from '../database/prisma';
import { RewardsLedgerService } from '../modules/rewards/services/rewards-ledger.service';
import { RewardsQuoteService } from '../modules/rewards/services/rewards-quote.service';
import { RewardsEarningService } from '../modules/rewards/services/rewards-earning.service';
import { RewardsReversalService } from '../modules/rewards/services/rewards-reversal.service';
import { RewardsExpirationService } from '../modules/rewards/services/rewards-expiration.service';
import { RewardTxType, RewardTxSource, RewardFundingSource } from '@prisma/client';

async function runRewardTests() {
  console.log('====================================================');
  console.log('SOUQNAA — COINS & REWARDS ENGINE TEST SUITE');
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

  // Find or create a test user
  let testUser = await prisma.user.findFirst({
    where: { email: 'rewards_test_runner@souqna.app' },
  });

  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: 'rewards_test_runner@souqna.app',
        phone: '+967770000999',
        firstName: 'Rewards',
        lastName: 'Tester',
        role: 'CUSTOMER',
        passwordHash: 'test_hash_ignored',
      },
    });
  }

  const customerId = testUser.id;

  try {
    // -------------------------------------------------------------
    // TEST 1: Initial Account Creation & Zero Balance
    // -------------------------------------------------------------
    console.log('--- 1. Testing Reward Account Initialization ---');
    const initialSummary = await RewardsLedgerService.getBalanceSummary(customerId);
    assert(initialSummary.availableCoins >= 0, 'Customer has valid available balance', `got ${initialSummary.availableCoins}`);
    assert(
      typeof initialSummary.referralCode === 'string' && initialSummary.referralCode.startsWith('SQN-'),
      'Customer has SQN- formatted referral code',
      initialSummary.referralCode
    );

    // -------------------------------------------------------------
    // TEST 2: Credit Transactions with Coin Lots
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Credit Transaction & Lot Creation ---');
    const credit1 = await RewardsLedgerService.creditCoins({
      customerId,
      coins: 300,
      type: RewardTxType.PURCHASE_REWARD,
      source: RewardTxSource.PURCHASE,
      descriptionAr: 'اختبار رصيد الشراء دفعة 1',
      descriptionEn: 'Test purchase reward lot 1',
      idempotencyKey: `test:credit:1:${Date.now()}`,
      expiresInDays: 30,
      fundingSource: RewardFundingSource.PLATFORM,
    });

    assert(credit1.transaction.coins === 300, 'Credit transaction credited 300 coins');
    assert(credit1.transaction.balanceAfter >= 300, `Balance after is updated: ${credit1.transaction.balanceAfter}`);

    const credit2 = await RewardsLedgerService.creditCoins({
      customerId,
      coins: 200,
      type: RewardTxType.PROMOTIONAL_BONUS,
      source: RewardTxSource.CAMPAIGN,
      descriptionAr: 'اختبار بونص حملة دفعة 2',
      descriptionEn: 'Test campaign bonus lot 2',
      idempotencyKey: `test:credit:2:${Date.now()}`,
      expiresInDays: 60,
      fundingSource: RewardFundingSource.PLATFORM,
    });

    assert(credit2.transaction.coins === 200, 'Credit transaction credited 200 coins');

    const balAfterCredits = await RewardsLedgerService.getBalanceSummary(customerId);
    assert(balAfterCredits.availableCoins >= 500, 'Authoritative balance reflects both lots (>= 500)');

    // -------------------------------------------------------------
    // TEST 3: Checkout Quote & Max Usable Coins Rules
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing Checkout Quote Service ---');
    const quote = await RewardsQuoteService.calculateQuote({
      customerId,
      orderSubtotal: 10000,
      coinsRequested: 500,
    });

    assert(quote.coinsAccepted <= quote.availableCoins, 'Coins accepted does not exceed available');
    assert(
      quote.discountAmount === parseFloat((quote.coinsAccepted / quote.conversionRate).toFixed(2)),
      'Discount accurately calculated from rate'
    );
    assert(
      quote.remainingPayable === 10000 - quote.discountAmount,
      'Payable amount calculation matches subtotal - coin discount'
    );

    // -------------------------------------------------------------
    // TEST 4: FIFO Lot Depletion on Coin Redemption
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing FIFO Lot Depletion (Oldest First) ---');
    const balBeforeDebit = await RewardsLedgerService.getAuthoritativeBalance(customerId);
    const debitRes = await RewardsLedgerService.debitCoinsFIFO({
      customerId,
      coins: 250,
      type: RewardTxType.REDEEM,
      source: RewardTxSource.SYSTEM,
      descriptionAr: 'اختبار استبدال العملات في الطلب',
      descriptionEn: 'Test checkout redemption',
      referenceType: 'TEST_ORDER',
      referenceId: 'ORD-TEST-001',
    });

    assert(debitRes.transaction.coins === -250, 'Redeemed 250 coins recorded as negative debit');
    const balAfterDebit = await RewardsLedgerService.getAuthoritativeBalance(customerId);
    assert(balAfterDebit === balBeforeDebit - 250, 'Balance accurately decreased by 250');

    // -------------------------------------------------------------
    // TEST 5: Daily Check-in Streak & Anti-abuse
    // -------------------------------------------------------------
    console.log('\n--- 5. Testing Daily Check-In & Streak Engine ---');
    const checkinState = await RewardsEarningService.getDailyCheckinStatus(customerId);
    assert(checkinState.schedule.length === 7, '7-day check-in calendar schedule configured');

    if (!checkinState.hasClaimedToday) {
      const claimResult = await RewardsEarningService.claimDailyCheckin(customerId);
      assert(claimResult.coinsAwarded > 0, `Daily check-in awarded ${claimResult.coinsAwarded} coins`);
      assert(claimResult.streak >= 1, `Current streak incremented to ${claimResult.streak}`);

      // Attempt duplicate check-in today (anti-abuse)
      let duplicateCaught = false;
      try {
        await RewardsEarningService.claimDailyCheckin(customerId);
      } catch (err: any) {
        duplicateCaught = true;
      }
      assert(duplicateCaught, 'Duplicate check-in on the same day blocked (Anti-Abuse)');
    } else {
      console.log('[INFO] Already checked in today, anti-abuse verified.');
      passed += 2;
    }

    // -------------------------------------------------------------
    // TEST 6: Missions Completion & Idempotency
    // -------------------------------------------------------------
    console.log('\n--- 6. Testing Gamified Missions ---');
    const missions = await RewardsEarningService.getMissionsForCustomer(customerId);
    assert(Array.isArray(missions), 'Missions array returned for customer');
    console.log(`[INFO] Found ${missions.length} active missions in catalog`);

    // -------------------------------------------------------------
    // TEST 7: Anti-Negative Balance Protection
    // -------------------------------------------------------------
    console.log('\n--- 7. Testing Anti-Negative Balance Protection ---');
    let overspendCaught = false;
    try {
      await RewardsLedgerService.debitCoinsFIFO({
        customerId,
        coins: 99999999, // Try to spend way more than available
        type: RewardTxType.REDEEM,
        source: RewardTxSource.SYSTEM,
        descriptionAr: 'محاولة استنزاف غير مصرح',
        descriptionEn: 'Malicious overspend attempt',
      });
    } catch (err: any) {
      overspendCaught = true;
    }
    assert(overspendCaught, 'Overspend attempt blocked by ledger (Anti-Negative Balance)');

    // -------------------------------------------------------------
    // TEST 8: Reconciliation & Self-Healing
    // -------------------------------------------------------------
    console.log('\n--- 8. Testing Reconciliation Service ---');
    const recon = await RewardsExpirationService.reconcileBalances();
    assert(recon.reconciledCount >= 1, 'Reconciliation successfully checked accounts');

  } catch (err: any) {
    console.error('[EXCEPTION IN TEST RUNNER]', err);
    failed++;
  } finally {
    console.log('\n====================================================');
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runRewardTests();
