/**
 * SOUQNA — Production Financial Risk, COD, Commission Outstanding,
 * Wallet Deposits, Concurrency & Automatic Unblock E2E Test Runner
 *
 * Runs against the REAL PostgreSQL database using the real Prisma Client
 * and authoritative SellerFinancialRiskService.
 *
 * ZERO MOCK DATA - Real transactions, real DB rows, real ledger postings.
 */

import { prisma } from '../database/prisma';
import { SellerFinancialRiskService } from '../modules/commission/seller-financial-risk.service';

async function runE2ETests() {
  console.log('================================================================');
  console.log('🚀 SOUQNA E2E FINANCIAL RISK & COD ENGINE ACCEPTANCE TESTS START');
  console.log('================================================================\n');

  const timestamp = Date.now();
  const testPhone = `77${Math.floor(1000000 + Math.random() * 8999999)}`;
  const adminPhone = `77${Math.floor(1000000 + Math.random() * 8999999)}`;

  let sellerUserId = '';
  let sellerId = '';
  let storeId = '';
  let adminUserId = '';

  try {
    // -------------------------------------------------------------
    // Step 0: Create Real Entities in Postgres
    // -------------------------------------------------------------
    console.log('▶ Step 0: Setting up real test Seller, Store, and Admin in Postgres...');
    
    // Create Admin User
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-e2e-${timestamp}@souqna.online`,
        phone: adminPhone,
        firstName: 'مدير',
        lastName: 'المالية',
        passwordHash: '$2b$10$e2eHashedPasswordDummyAdminTestingOnly!',
        role: 'ADMIN',
        isActive: true,
      },
    });
    adminUserId = adminUser.id;

    // Create Seller User
    const sellerUser = await prisma.user.create({
      data: {
        email: `seller-e2e-${timestamp}@souqna.online`,
        phone: testPhone,
        firstName: 'تاجر',
        lastName: 'سوقنا التجريبي',
        passwordHash: '$2b$10$e2eHashedPasswordDummySellerTestingOnly!',
        role: 'SELLER',
        isActive: true,
      },
    });
    sellerUserId = sellerUser.id;

    // Create Seller Profile
    const seller = await prisma.seller.create({
      data: {
        userId: sellerUserId,
        status: 'ACTIVE',
        cashOnDeliveryEnabled: false,
        isFinanciallyRestricted: false,
        financialRestrictionLevel: 'NORMAL',
      },
    });
    sellerId = seller.id;

    // Create Store
    const store = await prisma.store.create({
      data: {
        sellerId: sellerId,
        name: `متجر الفخامة التجريبي ${timestamp}`,
        slug: `luxury-store-e2e-${timestamp}`,
        isActive: true,
        isVerified: true,
        cashOnDeliveryEnabled: false,
      },
    });
    storeId = store.id;

    // Create SellerBalance (Wallet)
    await prisma.sellerBalance.create({
      data: {
        sellerId: sellerId,
        availableBalance: 0,
        pendingBalance: 0,
        withdrawnBalance: 0,
        currency: 'YER',
      },
    });

    console.log(`✓ Real Postgres entities created: Seller ID=${sellerId}, Store ID=${storeId}, Admin ID=${adminUserId}\n`);

    // -------------------------------------------------------------
    // Step 1: Verify Initial Financial Standing (Zero balance & Zero liability)
    // -------------------------------------------------------------
    console.log('▶ Step 1: Checking Initial Standing (0 Balance, 0 Outstanding)...');
    let standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.availableBalance !== 0 || standing.outstandingCommission !== 0 || standing.financialRestrictionLevel !== 'NORMAL') {
      throw new Error(`Step 1 Failed: Expected 0 balance and NORMAL standing, got: ${JSON.stringify(standing)}`);
    }
    console.log(`✓ Standing verified: Outstanding=${standing.outstandingCommission} YER, Restriction=${standing.financialRestrictionLevel}\n`);

    // -------------------------------------------------------------
    // Step 2 & 3: Seller Enables COD & Backend Evaluates Eligibility
    // -------------------------------------------------------------
    console.log('▶ Step 2 & 3: Seller Enables COD & Server Checks Eligibility...');
    await prisma.$transaction(async (tx) => {
      await tx.seller.update({ where: { id: sellerId }, data: { cashOnDeliveryEnabled: true } });
      await tx.store.updateMany({ where: { sellerId }, data: { cashOnDeliveryEnabled: true } });
    });
    
    let codEval = await SellerFinancialRiskService.evaluateCodEligibility({
      sellerIds: [sellerId],
      governorate: 'Sana\'a',
    });
    if (!codEval.isCodAvailable) {
      throw new Error(`Step 2/3 Failed: COD should be available, got reason: ${codEval.reason}`);
    }
    console.log(`✓ COD is eligible for customer checkout: isCodAvailable=${codEval.isCodAvailable}\n`);

    // Helper to create an order with seller sub-order
    async function createTestOrder(seq: number, total: number, commissionRate: number) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `ORD-E2E-${seq}-${timestamp}`,
          userId: sellerUserId,
          subtotal: total,
          total: total,
          currency: 'YER',
          status: 'DELIVERED',
        },
      });

      const sellerOrder = await prisma.sellerOrder.create({
        data: {
          orderId: order.id,
          sellerId: sellerId,
          sellerOrderNumber: `SO-E2E-${seq}-${timestamp}`,
          subtotal: total,
          sellerPayout: total * (1 - commissionRate),
          status: 'DELIVERED',
        },
      });

      return { order, sellerOrder };
    }

    // -------------------------------------------------------------
    // Step 4: First COD Order Delivered -> Commission = 3,000 YER
    // (Wallet = 0 -> Outstanding = 3,000 YER, Level remains NORMAL)
    // -------------------------------------------------------------
    console.log('▶ Step 4: Order #1 Delivered -> Commission 3,000 YER with 0 Wallet Balance...');
    const { order: o1, sellerOrder: so1 } = await createTestOrder(1, 30000, 0.10);
    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
        sellerOrderId: so1.id,
        orderNumber: o1.orderNumber,
        sellerId: sellerId,
        commissionAmount: 3000,
        isCod: true,
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 3000 || standing.financialRestrictionLevel !== 'NORMAL') {
      throw new Error(`Step 4 Failed: Expected 3000 YER outstanding and NORMAL, got ${standing.outstandingCommission} YER, level=${standing.financialRestrictionLevel}`);
    }
    console.log(`✓ Order #1 processed: Outstanding=${standing.outstandingCommission} YER, Level=${standing.financialRestrictionLevel}\n`);

    // -------------------------------------------------------------
    // Step 5: Second Order Delivered -> Commission = 3,000 YER
    // (Total = 6,000 YER -> Reaches WARNING threshold 5,000 YER)
    // -------------------------------------------------------------
    console.log('▶ Step 5: Order #2 Delivered -> Commission 3,000 YER (Total 6,000 YER -> WARNING Threshold)...');
    const { order: o2, sellerOrder: so2 } = await createTestOrder(2, 30000, 0.10);
    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
        sellerOrderId: so2.id,
        orderNumber: o2.orderNumber,
        sellerId: sellerId,
        commissionAmount: 3000,
        isCod: true,
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 6000 || standing.financialRestrictionLevel !== 'WARNING') {
      throw new Error(`Step 5 Failed: Expected 6000 YER and WARNING, got ${standing.outstandingCommission} YER, level=${standing.financialRestrictionLevel}`);
    }
    console.log(`✓ Warning threshold crossed: Outstanding=${standing.outstandingCommission} YER, Level=${standing.financialRestrictionLevel}\n`);

    // -------------------------------------------------------------
    // Step 6: Third Order Delivered -> Commission = 2,500 YER
    // (Total = 8,500 YER -> Reaches CRITICAL threshold 8,000 YER)
    // -------------------------------------------------------------
    console.log('▶ Step 6: Order #3 Delivered -> Commission 2,500 YER (Total 8,500 YER -> CRITICAL Threshold)...');
    const { order: o3, sellerOrder: so3 } = await createTestOrder(3, 25000, 0.10);
    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
        sellerOrderId: so3.id,
        orderNumber: o3.orderNumber,
        sellerId: sellerId,
        commissionAmount: 2500,
        isCod: true,
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 8500 || standing.financialRestrictionLevel !== 'CRITICAL') {
      throw new Error(`Step 6 Failed: Expected 8500 YER and CRITICAL, got ${standing.outstandingCommission} YER, level=${standing.financialRestrictionLevel}`);
    }
    console.log(`✓ Critical threshold crossed: Outstanding=${standing.outstandingCommission} YER, Level=${standing.financialRestrictionLevel}\n`);

    // -------------------------------------------------------------
    // Step 7: Fourth Order Delivered -> Commission = 2,000 YER
    // (Total = 10,500 YER -> Reaches BLOCK threshold 10,000 YER -> RESTRICTED)
    // -------------------------------------------------------------
    console.log('▶ Step 7: Order #4 Delivered -> Commission 2,000 YER (Total 10,500 YER -> BLOCK Threshold)...');
    const { order: o4, sellerOrder: so4 } = await createTestOrder(4, 20000, 0.10);
    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.processDeliveredOrderCommission(tx, {
        sellerOrderId: so4.id,
        orderNumber: o4.orderNumber,
        sellerId: sellerId,
        commissionAmount: 2000,
        isCod: true,
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 10500 || !standing.isFinanciallyRestricted || standing.financialRestrictionLevel !== 'RESTRICTED') {
      throw new Error(`Step 7 Failed: Expected 10500 YER and RESTRICTED, got ${standing.outstandingCommission} YER, restricted=${standing.isFinanciallyRestricted}`);
    }
    console.log(`✓ Account Blocked: isFinanciallyRestricted=${standing.isFinanciallyRestricted}, Level=${standing.financialRestrictionLevel}\n`);

    // Check COD Eligibility now: Must be FALSE because seller is restricted!
    codEval = await SellerFinancialRiskService.evaluateCodEligibility({
      sellerIds: [sellerId],
    });
    if (codEval.isCodAvailable) {
      throw new Error('Step 7 Failed: COD must be INELIGIBLE when seller is restricted!');
    }
    console.log(`✓ Server-authoritative checkout check: COD unavailable due to restriction: reason="${codEval.reason}"\n`);

    // -------------------------------------------------------------
    // Step 8: Seller Submits Electronic Wallet Deposit of 3,500 YER
    // -------------------------------------------------------------
    console.log('▶ Step 8: Blocked Seller Submits Deposit of 3,500 YER...');
    const deposit1 = await prisma.walletDeposit.create({
      data: {
        userId: sellerUserId,
        userType: 'SELLER',
        sellerId: sellerId,
        amount: 3500,
        currency: 'YER',
        walletProvider: 'JAWALI',
        transferReference: `DEP-REF-1-${timestamp}`,
        status: 'PENDING',
        proofImageUrl: 'https://cdn.souqna.online/proofs/deposit-1.jpg',
      },
    });

    // Check standing: Outstanding is NOT yet reduced, seller is still RESTRICTED
    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 10500 || !standing.isFinanciallyRestricted) {
      throw new Error('Step 8 Failed: Pending deposit must NOT change outstanding balance before approval!');
    }
    console.log(`✓ Pending deposit did not alter financial authority. Outstanding remains: ${standing.outstandingCommission} YER\n`);

    // -------------------------------------------------------------
    // Step 9: Admin Finance Approves Deposit 1 (3,500 YER)
    // Outstanding reduces to 7,000 YER (> 4,000 unblock threshold -> seller remains restricted)
    // -------------------------------------------------------------
    console.log('▶ Step 9: Admin Approves Deposit #1 (3,500 YER)...');
    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.approveSellerDeposit(tx, {
        depositId: deposit1.id,
        adminUserId: adminUserId,
        approvedAmount: 3500,
        adminNote: 'تمت مطابقة الحوالة في الحساب البنكي',
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 7000 || !standing.isFinanciallyRestricted) {
      throw new Error(`Step 9 Failed: Outstanding should be 7000 YER and seller still restricted, got: ${standing.outstandingCommission} YER, restricted=${standing.isFinanciallyRestricted}`);
    }
    console.log(`✓ Deposit #1 Approved: Outstanding reduced to ${standing.outstandingCommission} YER. Seller correctly remains restricted (> 4,000 YER threshold).\n`);

    // -------------------------------------------------------------
    // Step 10: Concurrency Protection — Attempt Double Approval
    // -------------------------------------------------------------
    console.log('▶ Step 10: Testing Concurrency / Double Approval Protection on Deposit #1...');
    let doubleApprovalPrevented = false;
    try {
      await prisma.$transaction(async (tx) => {
        await SellerFinancialRiskService.approveSellerDeposit(tx, {
          depositId: deposit1.id,
          adminUserId: adminUserId,
          approvedAmount: 3500,
        });
      });
    } catch (err: any) {
      doubleApprovalPrevented = true;
      console.log(`✓ Double approval safely rejected by server: "${err.message}"`);
    }
    if (!doubleApprovalPrevented) {
      throw new Error('Step 10 Failed: Double approval was NOT rejected!');
    }
    console.log();

    // -------------------------------------------------------------
    // Step 11: Seller Submits Deposit 2 (4,000 YER) & Admin Approves
    // Outstanding reduces from 7,000 to 3,000 YER (<= 4,000 UNBLOCK THRESHOLD)
    // -> AUTOMATIC UNBLOCK TRIGGERED!
    // -------------------------------------------------------------
    console.log('▶ Step 11: Seller Submits Deposit #2 (4,000 YER) -> Reaching Unblock Threshold (<= 4,000 YER)...');
    const deposit2 = await prisma.walletDeposit.create({
      data: {
        userId: sellerUserId,
        userType: 'SELLER',
        sellerId: sellerId,
        amount: 4000,
        currency: 'YER',
        walletProvider: 'JAWALI',
        transferReference: `DEP-REF-2-${timestamp}`,
        status: 'PENDING',
        proofImageUrl: 'https://cdn.souqna.online/proofs/deposit-2.jpg',
      },
    });

    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.approveSellerDeposit(tx, {
        depositId: deposit2.id,
        adminUserId: adminUserId,
        approvedAmount: 4000,
        adminNote: 'اعتماد دفعة ثانية عبر محفظة جوالي',
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 3000 || standing.isFinanciallyRestricted) {
      throw new Error(`Step 11 Failed: Outstanding should be 3000 YER and seller AUTOMATICALLY UNBLOCKED, got: ${standing.outstandingCommission} YER, restricted=${standing.isFinanciallyRestricted}`);
    }
    console.log(`✓ AUTOMATIC UNBLOCK SUCCESSFUL: Outstanding=${standing.outstandingCommission} YER <= 4,000 threshold. isFinanciallyRestricted=${standing.isFinanciallyRestricted}, Level=${standing.financialRestrictionLevel}\n`);

    // Verify COD Eligibility is automatically RESTORED!
    codEval = await SellerFinancialRiskService.evaluateCodEligibility({
      sellerIds: [sellerId],
    });
    if (!codEval.isCodAvailable) {
      throw new Error(`Step 11 Failed: COD should be restored after unblock, got: ${codEval.reason}`);
    }
    console.log(`✓ Customer checkout COD availability automatically restored: isCodAvailable=${codEval.isCodAvailable}\n`);

    // -------------------------------------------------------------
    // Step 12: Seller Deposits Remaining Outstanding (3,000 YER)
    // Outstanding reaches 0 YER! All liabilities PAID.
    // -------------------------------------------------------------
    console.log('▶ Step 12: Seller Pays Remaining 3,000 YER -> Full Settlement...');
    const deposit3 = await prisma.walletDeposit.create({
      data: {
        userId: sellerUserId,
        userType: 'SELLER',
        sellerId: sellerId,
        amount: 3000,
        currency: 'YER',
        walletProvider: 'JAWALI',
        transferReference: `DEP-REF-3-${timestamp}`,
        status: 'PENDING',
        proofImageUrl: 'https://cdn.souqna.online/proofs/deposit-3.jpg',
      },
    });

    await prisma.$transaction(async (tx) => {
      await SellerFinancialRiskService.approveSellerDeposit(tx, {
        depositId: deposit3.id,
        adminUserId: adminUserId,
        approvedAmount: 3000,
        adminNote: 'سداد كامل المديونية المتبقية',
      });
    });

    standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
    if (standing.outstandingCommission !== 0 || standing.openOutstandingsCount !== 0) {
      throw new Error(`Step 12 Failed: Expected 0 outstanding and 0 open rows, got: ${standing.outstandingCommission} YER, open=${standing.openOutstandingsCount}`);
    }
    console.log(`✓ Full Outstanding Settled: Outstanding=${standing.outstandingCommission} YER, Open Liabilities=${standing.openOutstandingsCount}\n`);

    // Verify Ledger Entries
    const sellerBalance = await prisma.sellerBalance.findUnique({ where: { sellerId } });
    const ledgerCount = await prisma.sellerTransaction.count({
      where: {
        sellerBalanceId: sellerBalance!.id,
        type: 'OUTSTANDING_PAYMENT',
      },
    });
    if (ledgerCount !== 6) {
      throw new Error(`Step 12 Failed: Expected 6 FIFO amortized OUTSTANDING_PAYMENT ledger entries, found: ${ledgerCount}`);
    }
    console.log(`✓ Authoritative Ledger Entries Verified: ${ledgerCount} granular FIFO OUTSTANDING_PAYMENT entries in SellerTransaction Ledger.\n`);

    // -------------------------------------------------------------
    // Step 13: Manual Admin Unblock & Audit Trail Verification
    // -------------------------------------------------------------
    console.log('▶ Step 13: Testing Controlled Manual Admin Unblock & Audit Trail...');
    // Artificially restrict seller for test
    await prisma.seller.update({
      where: { id: sellerId },
      data: { isFinanciallyRestricted: true, financialRestrictionLevel: 'RESTRICTED' },
    });

    await SellerFinancialRiskService.manualAdminUnblock(adminUserId, sellerId, 'موافقة استثنائية من المدير المالي بموجب شيك ضمان');
    const unblockedSeller = await prisma.seller.findUnique({ where: { id: sellerId } });
    if (unblockedSeller?.isFinanciallyRestricted) {
      throw new Error('Step 13 Failed: Seller was not manually unblocked');
    }

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        action: 'SELLER_FINANCIAL_UNBLOCK_MANUAL',
        resource: 'sellers',
      },
    });
    if (!auditLog) {
      throw new Error('Step 13 Failed: AuditLog entry not created for manual unblock');
    }
    console.log(`✓ Manual Admin Unblock Succeeded & Audited in AuditLog: Action=${auditLog.action}, Details="${auditLog.details}"\n`);

    // -------------------------------------------------------------
    // Step 14: Financial Invariant Verification
    // -------------------------------------------------------------
    console.log('▶ Step 14: Verifying Financial Invariants...');
    const outstandings = await prisma.sellerOutstanding.findMany({ where: { sellerId } });
    for (const out of outstandings) {
      if (out.remainingAmount < 0) {
        throw new Error(`Financial invariant violation: Negative remainingAmount in ${out.id}`);
      }
      if (Math.abs(out.paidAmount + out.remainingAmount - out.amount) > 0.01) {
        throw new Error(`Financial invariant violation: paid (${out.paidAmount}) + remaining (${out.remainingAmount}) != amount (${out.amount})`);
      }
    }
    console.log(`✓ All financial invariants hold across ${outstandings.length} liability records.\n`);

    console.log('================================================================');
    console.log('🎉 ALL 14 E2E REAL BACKEND & DATABASE ACCEPTANCE TESTS PASSED! 🎉');
    console.log('================================================================\n');
  } catch (error: any) {
    console.error('❌ E2E TEST FAILED:', error);
    process.exit(1);
  } finally {
    // Clean up test data
    console.log('Cleaning up test entities...');
    try {
      if (sellerId) {
        const balance = await prisma.sellerBalance.findUnique({ where: { sellerId } });
        if (balance) {
          await prisma.sellerTransaction.deleteMany({ where: { sellerBalanceId: balance.id } });
        }
        await prisma.sellerOutstanding.deleteMany({ where: { sellerId } });
        await prisma.sellerBalance.deleteMany({ where: { sellerId } });
        await prisma.sellerOrder.deleteMany({ where: { sellerId } });
        await prisma.store.deleteMany({ where: { sellerId } });
        await prisma.seller.deleteMany({ where: { id: sellerId } });
      }
      if (sellerUserId) {
        await prisma.walletDeposit.deleteMany({ where: { userId: sellerUserId } });
        await prisma.order.deleteMany({ where: { userId: sellerUserId } });
        await prisma.user.deleteMany({ where: { id: sellerUserId } });
      }
      if (adminUserId) {
        await prisma.auditLog.deleteMany({ where: { userId: adminUserId } });
        await prisma.user.deleteMany({ where: { id: adminUserId } });
      }
      console.log('Cleanup complete.');
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr);
    }
    await prisma.$disconnect();
  }
}

runE2ETests();
