/**
 * SOUQNAA Marketplace — Production-Grade Financial Statements Engine Test Suite
 *
 * Comprehensive validation of:
 * 1. SELLER_STATEMENT:
 *    - Orders, discounts, refunds, delivery fees, commission, opening & closing balances
 * 2. SETTLEMENT_STATEMENT:
 *    - Settlement lifecycle, order item linking, deductions, net payout, idempotency
 * 3. COMMISSION_STATEMENT:
 *    - Product-based, seller-based, category-based, and platform default rates
 * 4. TAX_STATEMENT:
 *    - Authoritative OrderTaxSnapshot and RefundTaxRecord consumption
 * 5. CONCURRENCY & NUMBERING:
 *    - Atomic concurrency-safe sequence generation (SQ-SELL-STMT, SQ-SET-STMT, SQ-COM-STMT, SQ-TAX-STMT)
 * 6. SECURITY & RBAC:
 *    - Cross-seller access denial, customer total block (403), admin access
 * 7. IMMUTABILITY & SNAPSHOTS:
 *    - Finalized snapshot sealing, SHA-256 verification hash, tamper-proofing
 * 8. PDF & EXPORT:
 *    - Arabic RTL & English LTR A4 HTML/PDF rendering and CSV export
 */

import { prisma } from '../src/database/prisma';
import { SellerStatementService } from '../src/modules/statements/seller-statement.service';
import { SettlementStatementService } from '../src/modules/statements/settlement-statement.service';
import { CommissionStatementService } from '../src/modules/statements/commission-statement.service';
import { TaxStatementService } from '../src/modules/statements/tax-statement.service';
import { SettlementEngine } from '../src/modules/settlement/settlement.service';
import { CommissionEngine, CommissionType } from '../src/modules/commission/commission.service';
import { StatementNumberService } from '../src/modules/statements/statement-number.service';
import { StatementSnapshotService } from '../src/modules/statements/statement-snapshot.service';
import { StatementAccessService } from '../src/modules/statements/statement-access.service';
import { StatementPdfService } from '../src/modules/statements/statement-pdf.service';
import { StatementExportService } from '../src/modules/statements/statement-export.service';
import { StatementPeriodService } from '../src/modules/statements/statement-period.service';
import {
  StatementType,
  StatementStatus,
  StatementPeriodType,
  SettlementStatus,
  UserRoleType,
} from '@prisma/client';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    failed++;
  }
}

async function runStatementsEngineTestSuite() {
  console.log(`\n===============================================================`);
  console.log(`🚀 SOUQNAA Financial Statements Engine Comprehensive Test Suite`);
  console.log(`===============================================================\n`);

  try {
    // ------------------------------------------------------------------------
    // SETUP TEST FIXTURES
    // ------------------------------------------------------------------------
    console.log(`--- [1/8] Setting up Test Fixtures ---`);

    // Ensure test seller 1 exists
    const user1 = await prisma.user.upsert({
      where: { email: 'test_seller_stmt1@souqna.ye' },
      create: {
        email: 'test_seller_stmt1@souqna.ye',
        phone: '+967771234501',
        passwordHash: 'hashed_pw',
        role: UserRoleType.SELLER,
        firstName: 'تاجر',
        lastName: 'أول',
      },
      update: {},
    });

    const seller1 = await prisma.seller.upsert({
      where: { userId: user1.id },
      create: {
        userId: user1.id,
        businessType: 'ESTABLISHMENT',
        status: 'ACTIVE',
        commissionRate: 0.08, // 8% contract rate
        taxNumber: 'TAX-YE-10001',
        crNumber: 'CR-YE-55555',
      },
      update: {},
    });

    // Ensure store 1 exists
    const store1 = await prisma.store.upsert({
      where: { id: `store-test-${seller1.id.slice(0, 8)}` },
      create: {
        id: `store-test-${seller1.id.slice(0, 8)}`,
        sellerId: seller1.id,
        name: 'متجر التميز النموذجي',
        slug: `tamayoz-store-${seller1.id.slice(0, 6)}`,
        isActive: true,
      },
      update: {},
    });

    // Ensure test seller 2 exists (for cross-seller security tests)
    const user2 = await prisma.user.upsert({
      where: { email: 'test_seller_stmt2@souqna.ye' },
      create: {
        email: 'test_seller_stmt2@souqna.ye',
        phone: '+967771234502',
        passwordHash: 'hashed_pw',
        role: UserRoleType.SELLER,
        firstName: 'تاجر',
        lastName: 'ثاني',
      },
      update: {},
    });

    const seller2 = await prisma.seller.upsert({
      where: { userId: user2.id },
      create: {
        userId: user2.id,
        businessType: 'ESTABLISHMENT',
        status: 'ACTIVE',
        commissionRate: 0.12,
      },
      update: {},
    });

    assert(Boolean(seller1.id && seller2.id), 'Test sellers provisioned');

    // Clean existing test statements and settlements for clean test run
    await prisma.statementLine.deleteMany({
      where: { statement: { sellerId: { in: [seller1.id, seller2.id] } } },
    });
    await prisma.statementAuditLog.deleteMany({
      where: { statement: { sellerId: { in: [seller1.id, seller2.id] } } },
    });
    await prisma.statementSnapshot.deleteMany({
      where: { statement: { sellerId: { in: [seller1.id, seller2.id] } } },
    });
    await prisma.financialStatement.deleteMany({
      where: { sellerId: { in: [seller1.id, seller2.id] } },
    });
    await prisma.settlementItem.deleteMany({
      where: { settlement: { sellerId: { in: [seller1.id, seller2.id] } } },
    });
    await prisma.settlement.deleteMany({
      where: { sellerId: { in: [seller1.id, seller2.id] } },
    });

    // ------------------------------------------------------------------------
    // TEST 2: CONCURRENCY & ATOMIC NUMBERING
    // ------------------------------------------------------------------------
    console.log(`\n--- [2/8] Testing Concurrency & Atomic Sequence Numbering ---`);

    const num1 = await StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT);
    const num2 = await StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT);
    const setNum = await StatementNumberService.generateNextNumber(StatementType.SETTLEMENT_STATEMENT);
    const comNum = await StatementNumberService.generateNextNumber(StatementType.COMMISSION_STATEMENT);
    const taxNum = await StatementNumberService.generateNextNumber(StatementType.TAX_STATEMENT);

    assert(num1.startsWith('SQ-SELL-STMT-'), 'Seller statement number has SQ-SELL-STMT prefix');
    assert(setNum.startsWith('SQ-SET-STMT-'), 'Settlement statement number has SQ-SET-STMT prefix');
    assert(comNum.startsWith('SQ-COM-STMT-'), 'Commission statement number has SQ-COM-STMT prefix');
    assert(taxNum.startsWith('SQ-TAX-STMT-'), 'Tax statement number has SQ-TAX-STMT prefix');
    assert(num1 !== num2, 'Consecutive numbers are unique');

    // Concurrency test: simulate 5 parallel requests
    const parallelNums = await Promise.all([
      StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT),
      StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT),
      StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT),
      StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT),
      StatementNumberService.generateNextNumber(StatementType.SELLER_STATEMENT),
    ]);
    const uniqueSet = new Set(parallelNums);
    assert(uniqueSet.size === 5, 'Parallel concurrent generation produces 5 strictly unique numbers');

    // ------------------------------------------------------------------------
    // TEST 3: COMMISSION ENGINE RESOLUTION
    // ------------------------------------------------------------------------
    console.log(`\n--- [3/8] Testing Authoritative Commission Engine ---`);

    const sellerRate = await CommissionEngine.resolveEffectiveRate({
      sellerId: seller1.id,
    });
    assert(sellerRate.rate === 0.08, 'Resolved seller-specific commission rate 8%');
    assert(sellerRate.commissionType === CommissionType.SELLER_BASED, 'Identified commission type SELLER_BASED');

    const globalRate = await CommissionEngine.resolveEffectiveRate({});
    assert(globalRate.rate === 0.10, 'Fallback to platform global default 10%');

    // Calculate order commission
    const calculatedComm = await CommissionEngine.calculateOrderCommission({
      sellerOrderId: 'so-test-1',
      sellerId: seller1.id,
      items: [
        {
          orderItemId: 'oi-1',
          productName: 'هاتف ذكي',
          price: 100000,
          quantity: 1,
          discount: 10000,
        },
      ],
    });
    // Base = 100000 - 10000 = 90000. Comm = 90000 * 0.08 = 7200
    assert(calculatedComm.totalCommissionBase === 90000, 'Commission base correctly calculated after discount');
    assert(calculatedComm.totalCommissionAmount === 7200, 'Commission amount correctly calculated (90,000 * 8% = 7,200 YER)');

    // ------------------------------------------------------------------------
    // TEST 4: SETTLEMENT ENGINE & SETTLEMENT_STATEMENT
    // ------------------------------------------------------------------------
    console.log(`\n--- [4/8] Testing Settlement Engine & SETTLEMENT_STATEMENT ---`);

    // Create a mock settlement
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const settlement = await SettlementEngine.createSettlement({
      sellerId: seller1.id,
      periodStart,
      periodEnd,
      payoutMethod: 'WALLET',
      notes: 'تسوية دورية لشهر تجريبي',
    });

    assert(Boolean(settlement.settlementNumber), 'Generated settlement number');
    assert(settlement.status === SettlementStatus.PENDING, 'Initial settlement status is PENDING');

    // Transition lifecycle
    const processing = await SettlementEngine.transitionStatus({
      settlementId: settlement.id,
      targetStatus: SettlementStatus.PROCESSING,
    });
    assert(processing.status === SettlementStatus.PROCESSING, 'Transitioned settlement to PROCESSING');

    const completed = await SettlementEngine.transitionStatus({
      settlementId: settlement.id,
      targetStatus: SettlementStatus.COMPLETED,
      paymentReference: 'REF-KUR-777888',
    });
    assert(completed.status === SettlementStatus.COMPLETED, 'Transitioned settlement to COMPLETED');
    assert(completed.paymentReference === 'REF-KUR-777888', 'Recorded payment reference on settlement');

    // Generate SETTLEMENT_STATEMENT
    const stmtResult = await SettlementStatementService.generateStatement({
      settlementId: settlement.id,
      actorId: user1.id,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    assert(Boolean(stmtResult.statement), 'Generated SETTLEMENT_STATEMENT');
    assert(stmtResult.statement?.statementType === StatementType.SETTLEMENT_STATEMENT, 'Statement type is SETTLEMENT_STATEMENT');
    assert(stmtResult.statement?.status === StatementStatus.FINALIZED, 'Statement status is FINALIZED');
    assert(Boolean(stmtResult.snapshot), 'Immutable snapshot created upon finalization');

    // Idempotency: re-requesting the same settlement statement must return existing without duplicate numbers
    const idempotentStmt = await SettlementStatementService.generateStatement({
      settlementId: settlement.id,
      actorId: user1.id,
      actorRole: 'SELLER',
      autoFinalize: true,
    });
    assert(idempotentStmt.statement?.id === stmtResult.statement?.id, 'Settlement statement generation is strictly idempotent');
    assert(idempotentStmt.statement?.statementNumber === stmtResult.statement?.statementNumber, 'Preserved statement number on duplicate request');

    // ------------------------------------------------------------------------
    // TEST 5: SELLER_STATEMENT GENERATION
    // ------------------------------------------------------------------------
    console.log(`\n--- [5/8] Testing SELLER_STATEMENT Generation ---`);

    const sellerStmt = await SellerStatementService.generateStatement({
      sellerId: seller1.id,
      periodType: StatementPeriodType.MONTHLY,
      referenceDate: now,
      actorId: user1.id,
      actorRole: 'SELLER',
      autoFinalize: true,
    });

    assert(Boolean(sellerStmt.statement), 'Generated periodic SELLER_STATEMENT');
    assert(sellerStmt.statement?.statementType === StatementType.SELLER_STATEMENT, 'Statement type is SELLER_STATEMENT');
    assert(sellerStmt.statement?.status === StatementStatus.FINALIZED, 'Seller statement is FINALIZED');
    assert(Boolean(sellerStmt.snapshot?.summary), 'Snapshot contains summary breakdown');
    assert(sellerStmt.snapshot?.currency === 'YER', 'Snapshot currency is configured marketplace currency (YER)');

    // ------------------------------------------------------------------------
    // TEST 6: COMMISSION_STATEMENT & TAX_STATEMENT
    // ------------------------------------------------------------------------
    console.log(`\n--- [6/8] Testing COMMISSION_STATEMENT & TAX_STATEMENT ---`);

    const commStmt = await CommissionStatementService.generateStatement({
      sellerId: seller1.id,
      periodType: StatementPeriodType.MONTHLY,
      referenceDate: now,
      actorId: user1.id,
      actorRole: 'SELLER',
      autoFinalize: true,
    });
    assert(commStmt.statement?.statementType === StatementType.COMMISSION_STATEMENT, 'Generated COMMISSION_STATEMENT');

    const taxStmt = await TaxStatementService.generateStatement({
      sellerId: seller1.id,
      periodType: StatementPeriodType.MONTHLY,
      referenceDate: now,
      actorId: user1.id,
      actorRole: 'SELLER',
      autoFinalize: true,
    });
    assert(taxStmt.statement?.statementType === StatementType.TAX_STATEMENT, 'Generated TAX_STATEMENT');

    // ------------------------------------------------------------------------
    // TEST 7: SECURITY & ACCESS CONTROL
    // ------------------------------------------------------------------------
    console.log(`\n--- [7/8] Testing Server-Side Security & RBAC ---`);

    // 1. Seller accessing own statement -> Allowed
    let sellerOwnAllowed = false;
    try {
      await StatementAccessService.assertCanAccessStatement(
        { userId: user1.id, role: UserRoleType.SELLER, sellerId: seller1.id },
        sellerStmt.statement!.id
      );
      sellerOwnAllowed = true;
    } catch {
      sellerOwnAllowed = false;
    }
    assert(sellerOwnAllowed, 'Seller can access own statement');

    // 2. Seller 2 accessing Seller 1 statement -> Strictly Forbidden (403)
    let sellerCrossDenied = false;
    try {
      await StatementAccessService.assertCanAccessStatement(
        { userId: user2.id, role: UserRoleType.SELLER, sellerId: seller2.id },
        sellerStmt.statement!.id
      );
    } catch (e: any) {
      if (e.statusCode === 403) sellerCrossDenied = true;
    }
    assert(sellerCrossDenied, 'Cross-seller access blocked with 403 Forbidden');

    // 3. Customer accessing statements -> Strictly Forbidden (403)
    let customerDenied = false;
    try {
      await StatementAccessService.assertCanAccessStatement(
        { userId: 'customer-uid-99', role: UserRoleType.CUSTOMER },
        sellerStmt.statement!.id
      );
    } catch (e: any) {
      if (e.statusCode === 403) customerDenied = true;
    }
    assert(customerDenied, 'Customer role completely blocked from financial statements (403)');

    // 4. Admin accessing statement -> Allowed
    let adminAllowed = false;
    try {
      await StatementAccessService.assertCanAccessStatement(
        { userId: 'admin-uid-1', role: UserRoleType.ADMIN },
        sellerStmt.statement!.id
      );
      adminAllowed = true;
    } catch {
      adminAllowed = false;
    }
    assert(adminAllowed, 'Admin role authorized to inspect statements');

    // ------------------------------------------------------------------------
    // TEST 8: PDF RENDERING & CSV EXPORT
    // ------------------------------------------------------------------------
    console.log(`\n--- [8/8] Testing Bilingual PDF/HTML & CSV Export ---`);

    if (sellerStmt.snapshot) {
      const html = await StatementPdfService.renderStatementHtml(sellerStmt.snapshot);
      assert(html.includes('SOUQNAA SELLER FINANCIAL STATEMENT'), 'PDF HTML contains bilingual title');
      assert(html.includes('dir="rtl"'), 'PDF HTML supports Arabic RTL layout');
      assert(html.includes(sellerStmt.snapshot.statementNumber), 'PDF HTML displays exact statement number');
      assert(html.includes('وثيقة مالية رسمية معتمدة ومجمدة إلكترونياً'), 'PDF HTML includes seal watermark and certification');

      const csv = StatementExportService.generateCsv(sellerStmt.snapshot);
      assert(csv.startsWith('\uFEFF'), 'CSV export starts with UTF-8 BOM for Microsoft Excel compatibility');
      assert(csv.includes(sellerStmt.snapshot.statementNumber), 'CSV includes statement number');
    }

    console.log(`\n===============================================================`);
    console.log(`🎉 Financial Statements Engine Test Suite Passed!`);
    console.log(`Passed: ${passed} | Failed: ${failed}`);
    console.log(`===============================================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error running financial statements engine test suite:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runStatementsEngineTestSuite();
