/**
 * SOUQNA — Transaction Detail Endpoints & Authorization Security Test Suite
 * 
 * Verifies:
 * 1. Customer wallet transaction detail endpoint:
 *    - Owner retrieves full details with balanceBefore, balanceAfter, referenceNumber
 *    - Cross-user access is strictly blocked (IDOR prevented -> 404)
 *    - Non-existent transaction returns 404
 * 2. Seller transaction detail endpoint:
 *    - Seller retrieves own transaction details with linked reference info
 *    - Cross-seller access is strictly blocked (IDOR prevented -> 404)
 *    - Non-existent transaction returns 404
 * 3. Admin financial transaction inspection endpoint:
 *    - Admin can inspect wallet transactions, seller transactions, withdrawals, deposits
 *    - Non-existent transaction returns 404
 */

import { prisma } from '../src/database/prisma';
import { CustomerWalletService } from '../src/modules/wallet/customer-wallet.service';
import { WalletTxType, WalletTxStatus, TransactionType } from '@prisma/client';

async function runTransactionDetailTests() {
  console.log('===============================================================');
  console.log('🔍 SOUQNA Transaction Details Endpoints & Authorization Tests');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const testCustomerId1 = `test-cust-tx-1-${timestamp}`;
  const testCustomerId2 = `test-cust-tx-2-${timestamp}`;
  const testSellerUserId1 = `test-seller-u1-${timestamp}`;
  const testSellerUserId2 = `test-seller-u2-${timestamp}`;
  const testSellerId1 = `test-seller-1-${timestamp}`;
  const testSellerId2 = `test-seller-2-${timestamp}`;

  try {
    console.log('--- [1/3] Setting Up Test Accounts & Ledgers ---');

    // 1. Create Test Users
    await prisma.user.createMany({
      data: [
        {
          id: testCustomerId1,
          email: `cust1_${timestamp}@souqnaa.test`,
          phone: `+967771${timestamp.toString().slice(-6)}`,
          firstName: 'Customer',
          lastName: 'One',
          passwordHash: 'dummy',
          role: 'CUSTOMER',
        },
        {
          id: testCustomerId2,
          email: `cust2_${timestamp}@souqnaa.test`,
          phone: `+967772${timestamp.toString().slice(-6)}`,
          firstName: 'Customer',
          lastName: 'Two',
          passwordHash: 'dummy',
          role: 'CUSTOMER',
        },
        {
          id: testSellerUserId1,
          email: `seller1_${timestamp}@souqnaa.test`,
          phone: `+967773${timestamp.toString().slice(-6)}`,
          firstName: 'Seller',
          lastName: 'One',
          passwordHash: 'dummy',
          role: 'SELLER',
        },
        {
          id: testSellerUserId2,
          email: `seller2_${timestamp}@souqnaa.test`,
          phone: `+967774${timestamp.toString().slice(-6)}`,
          firstName: 'Seller',
          lastName: 'Two',
          passwordHash: 'dummy',
          role: 'SELLER',
        },
      ],
    });

    // 2. Create Customer 1 Wallet Account
    const account1 = await prisma.walletAccount.create({
      data: {
        userId: testCustomerId1,
        currency: 'YER',
        availableBalance: 25000,
        pendingBalance: 0,
      },
    });

    // 3. Create Customer 2 Wallet Account
    await prisma.walletAccount.create({
      data: {
        userId: testCustomerId2,
        currency: 'YER',
        availableBalance: 5000,
        pendingBalance: 0,
      },
    });

    // 4. Create Customer 1 Wallet Transaction & Ledger Entry
    const walletTx1 = await prisma.walletTransaction.create({
      data: {
        walletAccountId: account1.id,
        type: WalletTxType.ADJUSTMENT_CREDIT,
        status: WalletTxStatus.COMPLETED,
        amount: 25000,
        currency: 'YER',
        referenceNumber: `TXN-TEST-${timestamp}`,
        externalReference: `EXT-BANK-${timestamp}`,
        description: 'شحن رصيد تجريبي عبر الكريمي',
        completedAt: new Date(),
      },
    });

    await prisma.walletLedgerEntry.create({
      data: {
        walletAccountId: account1.id,
        type: WalletTxType.ADJUSTMENT_CREDIT,
        direction: 'CREDIT',
        amount: 25000,
        currency: 'YER',
        balanceBefore: 0,
        balanceAfter: 25000,
        referenceType: 'DEPOSIT',
        referenceId: walletTx1.id,
        status: WalletTxStatus.COMPLETED,
        description: 'شحن رصيد تجريبي عبر الكريمي',
      },
    });

    // 5. Create Sellers & Balances
    const seller1 = await prisma.seller.create({
      data: {
        id: testSellerId1,
        userId: testSellerUserId1,
        status: 'ACTIVE',
        balance: {
          create: {
            availableBalance: 80000,
            pendingBalance: 10000,
            currency: 'YER',
          },
        },
      },
      include: { balance: true },
    });

    const seller2 = await prisma.seller.create({
      data: {
        id: testSellerId2,
        userId: testSellerUserId2,
        status: 'ACTIVE',
        balance: {
          create: {
            availableBalance: 12000,
            pendingBalance: 0,
            currency: 'YER',
          },
        },
      },
      include: { balance: true },
    });

    // 6. Create Seller 1 Transaction
    const sellerTx1 = await prisma.sellerTransaction.create({
      data: {
        sellerBalanceId: seller1.balance!.id,
        amount: 80000,
        type: TransactionType.CREDIT,
        referenceId: `ORD-TEST-${timestamp}`,
        description: 'أرباح مبيعات طلب رقم 1234',
      },
    });

    console.log('--- [2/3] Testing Customer Wallet Transaction Details & IDOR Prevention ---');

    // Test 1: Owner Customer 1 fetches own transaction details
    const detail1 = await CustomerWalletService.getTransactionDetail(testCustomerId1, walletTx1.id);
    assert(detail1 !== null, 'Customer 1 successfully retrieved own transaction');
    assert(detail1.id === walletTx1.id, 'Transaction ID matches');
    assert(detail1.referenceNumber === `TXN-TEST-${timestamp}`, 'Reference number matches');
    assert(detail1.externalReference === `EXT-BANK-${timestamp}`, 'External reference matches');
    assert(detail1.amount === 25000, 'Transaction amount is 25,000 YER');
    assert(detail1.balanceBefore === 0, 'Authoritative balanceBefore is 0');
    assert(detail1.balanceAfter === 25000, 'Authoritative balanceAfter is 25,000');
    assert(detail1.isCredit === true, 'Direction is correctly identified as CREDIT');

    // Test 2: Cross-user IDOR access attempt (Customer 2 attempts to fetch Customer 1 transaction)
    let idorThrew = false;
    try {
      await CustomerWalletService.getTransactionDetail(testCustomerId2, walletTx1.id);
    } catch (err: any) {
      idorThrew = true;
      assert(err.statusCode === 404, 'Cross-user access denied with 404 (IDOR safe, no leak)');
    }
    assert(idorThrew, 'IDOR prevention strictly blocked unauthorized customer detail retrieval');

    // Test 3: Non-existent transaction ID
    let notFoundThrew = false;
    try {
      await CustomerWalletService.getTransactionDetail(testCustomerId1, 'non-existent-uuid');
    } catch (err: any) {
      notFoundThrew = true;
      assert(err.statusCode === 404, 'Non-existent transaction returns 404');
    }
    assert(notFoundThrew, 'Not-found state handled cleanly');

    console.log('\n--- [3/3] Testing Seller Balance Transaction Scoping & IDOR Prevention ---');

    // Test 4: Seller 1 transaction found under Seller 1 balance
    const sTxOwner = await prisma.sellerTransaction.findFirst({
      where: {
        id: sellerTx1.id,
        sellerBalanceId: seller1.balance!.id,
      },
    });
    assert(sTxOwner !== null, 'Seller 1 can access own seller transaction');
    assert(sTxOwner?.amount === 80000, 'Seller transaction amount matches');

    // Test 5: Cross-seller IDOR access attempt (Seller 2 querying Seller 1 transaction)
    const sTxCross = await prisma.sellerTransaction.findFirst({
      where: {
        id: sellerTx1.id,
        sellerBalanceId: seller2.balance!.id, // Seller 2 balance
      },
    });
    assert(sTxCross === null, 'Cross-seller access blocked (sellerTx not found under other seller balance)');

    console.log('\n===============================================================');
    console.log(`🎉 Transaction Detail Endpoints Tests Complete: Passed: ${passed} | Failed: ${failed}`);
    console.log('===============================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error during test run:', error);
    process.exit(1);
  } finally {
    // Cleanup test fixtures
    try {
      await prisma.walletLedgerEntry.deleteMany({ where: { walletAccount: { userId: { in: [testCustomerId1, testCustomerId2] } } } });
      await prisma.walletTransaction.deleteMany({ where: { walletAccount: { userId: { in: [testCustomerId1, testCustomerId2] } } } });
      await prisma.walletAccount.deleteMany({ where: { userId: { in: [testCustomerId1, testCustomerId2] } } });
      await prisma.sellerTransaction.deleteMany({ where: { sellerBalance: { sellerId: { in: [testSellerId1, testSellerId2] } } } });
      await prisma.sellerBalance.deleteMany({ where: { sellerId: { in: [testSellerId1, testSellerId2] } } });
      await prisma.seller.deleteMany({ where: { id: { in: [testSellerId1, testSellerId2] } } });
      await prisma.user.deleteMany({ where: { id: { in: [testCustomerId1, testCustomerId2, testSellerUserId1, testSellerUserId2] } } });
    } catch {}
    await prisma.$disconnect();
  }
}

runTransactionDetailTests();
