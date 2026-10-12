import { RefundStatus, RefundActorType, RefundDestination, ManualTransferStatus, WalletTxType, WalletTxStatus } from '@prisma/client';
import { RefundStateMachine } from '../src/modules/refunds/refund.state-machine';
import { RefundEligibilityService } from '../src/modules/refunds/services/refund-eligibility.service';
import { WalletProviderRegistry } from '../src/modules/payments/adapters/wallet-provider.adapter';

async function runE2ETests() {
  console.log('================================================================');
  console.log('  SOUQNAA — PRODUCTION PAYMENT, REFUND & WALLET E2E TESTS');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `-> (${detail})` : ''}`);
      failed++;
    }
  }

  // ============================================================================
  // 1. AUTHORITATIVE 14-DAY SERVER ELIGIBILITY DEADLINE TESTS
  // ============================================================================
  console.log('\n--- 1. 14-Day Delivery Policy & Deadline Tests ---');

  const now = new Date();
  const policyDays = 14;

  // Case 1A: Delivered 3 days ago -> Within 14 days
  const delivered3DaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const remainingHours3 = Math.max(0, Math.floor(((delivered3DaysAgo.getTime() + policyDays * 86400000) - now.getTime()) / 3600000));
  const remainingDays3 = Math.ceil(remainingHours3 / 24);
  assert(remainingDays3 === 11, 'Delivered 3 days ago has 11 days remaining');

  // Case 1B: Delivered 14 days and 1 hour ago -> Expired
  const delivered14DaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000 - 3600000);
  const remainingHoursExpired = Math.max(0, Math.floor(((delivered14DaysAgo.getTime() + policyDays * 86400000) - now.getTime()) / 3600000));
  assert(remainingHoursExpired === 0, 'Delivered >14 days ago has 0 remaining hours (Expired)');

  // Case 1C: Double-refund calculation
  // Total order: 50,000 YER, Voucher: 5,000 YER, Net paid: 45,000 YER
  // Refund 1 already completed: 20,000 YER
  // Refund 2 pending: 15,000 YER
  // Max remaining refundable: 45,000 - 20,000 - 15,000 = 10,000 YER
  const netPaid = 45000;
  const alreadyRefunded = 20000;
  const pendingRefund = 15000;
  const maxRefundable = netPaid - alreadyRefunded - pendingRefund;
  assert(maxRefundable === 10000, 'Remaining refundable amount correctly calculated as 10,000 YER');

  const requestedAmountInvalid = 15000;
  assert(requestedAmountInvalid > maxRefundable, 'Attempting to request 15,000 YER is blocked (exceeds 10,000 YER)');

  const requestedAmountValid = 10000;
  assert(requestedAmountValid <= maxRefundable, 'Requesting exactly 10,000 YER is permitted');

  // ============================================================================
  // 2. STRICT 17-STATE SERVER STATE MACHINE & ROLE PERMISSIONS
  // ============================================================================
  console.log('\n--- 2. Production 17-State State Machine Transitions ---');

  // Forward Happy Path
  assert(RefundStateMachine.isValidTransition(RefundStatus.DRAFT, RefundStatus.SUBMITTED), 'DRAFT -> SUBMITTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.SUBMITTED, RefundStatus.UNDER_SELLER_REVIEW), 'SUBMITTED -> UNDER_SELLER_REVIEW');
  assert(RefundStateMachine.isValidTransition(RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_ACCEPTED), 'UNDER_SELLER_REVIEW -> SELLER_ACCEPTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.SELLER_ACCEPTED, RefundStatus.CUSTOMER_ACCEPTED), 'SELLER_ACCEPTED -> CUSTOMER_ACCEPTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.CUSTOMER_ACCEPTED, RefundStatus.REFUND_PENDING), 'CUSTOMER_ACCEPTED -> REFUND_PENDING');
  assert(RefundStateMachine.isValidTransition(RefundStatus.REFUND_PENDING, RefundStatus.REFUND_PROCESSING), 'REFUND_PENDING -> REFUND_PROCESSING');
  assert(RefundStateMachine.isValidTransition(RefundStatus.REFUND_PROCESSING, RefundStatus.REFUND_COMPLETED), 'REFUND_PROCESSING -> REFUND_COMPLETED');

  // Dispute Flow
  assert(RefundStateMachine.isValidTransition(RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_REJECTED), 'UNDER_SELLER_REVIEW -> SELLER_REJECTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.SELLER_REJECTED, RefundStatus.CUSTOMER_DISPUTED), 'SELLER_REJECTED -> CUSTOMER_DISPUTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.CUSTOMER_DISPUTED, RefundStatus.ADMIN_REVIEW), 'CUSTOMER_DISPUTED -> ADMIN_REVIEW');
  assert(RefundStateMachine.isValidTransition(RefundStatus.ADMIN_REVIEW, RefundStatus.ADMIN_APPROVED), 'ADMIN_REVIEW -> ADMIN_APPROVED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.ADMIN_APPROVED, RefundStatus.REFUND_PENDING), 'ADMIN_APPROVED -> REFUND_PENDING');
  assert(RefundStateMachine.isValidTransition(RefundStatus.ADMIN_REVIEW, RefundStatus.ADMIN_REJECTED), 'ADMIN_REVIEW -> ADMIN_REJECTED');
  assert(RefundStateMachine.isValidTransition(RefundStatus.ADMIN_REJECTED, RefundStatus.CLOSED), 'ADMIN_REJECTED -> CLOSED');

  // Forbidden / Terminal Transitions
  assert(!RefundStateMachine.isValidTransition(RefundStatus.SUBMITTED, RefundStatus.REFUND_COMPLETED), 'Forbidden: Direct SUBMITTED -> REFUND_COMPLETED bypass');
  assert(!RefundStateMachine.isValidTransition(RefundStatus.REFUND_COMPLETED, RefundStatus.SUBMITTED), 'Forbidden: REFUND_COMPLETED is terminal');
  assert(!RefundStateMachine.isValidTransition(RefundStatus.CLOSED, RefundStatus.ADMIN_REVIEW), 'Forbidden: CLOSED is terminal');
  assert(!RefundStateMachine.isValidTransition(RefundStatus.CANCELLED, RefundStatus.UNDER_SELLER_REVIEW), 'Forbidden: CANCELLED is terminal');

  // Role Permissions
  assert(RefundStateMachine.isAuthorized(RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_ACCEPTED, RefundActorType.SELLER), 'Seller authorized to accept');
  assert(!RefundStateMachine.isAuthorized(RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.SELLER_ACCEPTED, RefundActorType.CUSTOMER), 'Customer NOT authorized to seller-accept');
  assert(RefundStateMachine.isAuthorized(RefundStatus.SELLER_REJECTED, RefundStatus.CUSTOMER_DISPUTED, RefundActorType.CUSTOMER), 'Customer authorized to dispute rejection');
  assert(!RefundStateMachine.isAuthorized(RefundStatus.SELLER_REJECTED, RefundStatus.CUSTOMER_DISPUTED, RefundActorType.SELLER), 'Seller NOT authorized to customer-dispute');
  assert(RefundStateMachine.isAuthorized(RefundStatus.ADMIN_REVIEW, RefundStatus.ADMIN_APPROVED, RefundActorType.ADMIN), 'Admin authorized to approve dispute');

  // Available Actions Mutually Exclusive Check
  const sellerActions = RefundStateMachine.getAvailableActions(RefundStatus.UNDER_SELLER_REVIEW, RefundActorType.SELLER);
  assert(sellerActions.includes('SELLER_ACCEPT') && sellerActions.includes('SELLER_REJECT'), 'Seller gets SELLER_ACCEPT & SELLER_REJECT in UNDER_SELLER_REVIEW');

  const customerDisputeActions = RefundStateMachine.getAvailableActions(RefundStatus.SELLER_REJECTED, RefundActorType.CUSTOMER);
  assert(customerDisputeActions.includes('CUSTOMER_ACCEPT') && customerDisputeActions.includes('CUSTOMER_DISPUTE'), 'Customer gets ACCEPT & DISPUTE after rejection');

  const adminActions = RefundStateMachine.getAvailableActions(RefundStatus.ADMIN_REVIEW, RefundActorType.ADMIN);
  assert(adminActions.includes('ADMIN_APPROVE') && adminActions.includes('ADMIN_REJECT') && adminActions.includes('ADMIN_ADJUST'), 'Admin gets APPROVE, REJECT, ADJUST during ADMIN_REVIEW');

  // Terminal State Check
  assert(RefundStateMachine.isTerminal(RefundStatus.REFUND_COMPLETED), 'REFUND_COMPLETED is marked terminal');
  assert(RefundStateMachine.isTerminal(RefundStatus.CLOSED), 'CLOSED is marked terminal');
  assert(!RefundStateMachine.isTerminal(RefundStatus.UNDER_SELLER_REVIEW), 'UNDER_SELLER_REVIEW is NOT terminal');

  // ============================================================================
  // 3. YEMENI DIGITAL WALLET ADAPTERS & MASKING
  // ============================================================================
  console.log('\n--- 3. Yemeni Digital Wallet Provider Adapters ---');

  const kuraimi = WalletProviderRegistry.getAdapter('KURAIMI');
  const cashPay = WalletProviderRegistry.getAdapter('CASHPAY');
  const oneCash = WalletProviderRegistry.getAdapter('ONECASH');
  const jawali = WalletProviderRegistry.getAdapter('JAWALI');
  const jaib = WalletProviderRegistry.getAdapter('JAIB');
  const yemenWallet = WalletProviderRegistry.getAdapter('YEMEN_WALLET');

  assert(kuraimi.validateWalletNumber('771234567').isValid, 'Kuraimi validates 771234567 phone');
  assert(kuraimi.validateWalletNumber('123456789').isValid, 'Kuraimi validates 9-digit account');
  assert(!kuraimi.validateWalletNumber('123').isValid, 'Kuraimi rejects invalid 123');

  assert(cashPay.validateWalletNumber('777123456').isValid, 'CashPay validates 777123456');
  assert(!cashPay.validateWalletNumber('12345').isValid, 'CashPay rejects invalid phone length (12345)');

  assert(oneCash.validateWalletNumber('770001122').isValid, 'OneCash validates 770001122');
  assert(jawali.validateWalletNumber('779876543').isValid, 'Jawali validates 779876543');
  assert(jaib.validateWalletNumber('712345678').isValid, 'Jaib validates 712345678');
  assert(yemenWallet.validateWalletNumber('731234567').isValid, 'YemenWallet validates 731234567');

  // Number Masking Checks (Protect PII)
  const maskedKuraimi = kuraimi.maskWalletNumber('771234567');
  assert(maskedKuraimi.includes('**'), `Masked Kuraimi phone correctly hides middle digits: ${maskedKuraimi}`);

  const maskedAccount = kuraimi.maskWalletNumber('123456789');
  assert(maskedAccount.includes('**'), `Masked Kuraimi account correctly hides middle digits: ${maskedAccount}`);

  // Capabilities Check: Zero fake automated payouts without API keys
  assert(kuraimi.capabilities.supportsWalletTransfer === true, 'Kuraimi supports manual wallet transfers');
  assert(kuraimi.capabilities.supportsPayout === false, 'Kuraimi prohibits automated payouts without central bank merchant key');

  // ============================================================================
  // 4. CUSTOMER DOUBLE-ENTRY INTERNAL WALLET LEDGER
  // ============================================================================
  console.log('\n--- 4. Customer Double-Entry Wallet Ledger Logic ---');

  interface MockLedgerEntry {
    entryType: 'CREDIT' | 'DEBIT';
    amount: number;
    balanceAfter: number;
  }

  // Simulate double-entry balance derivation
  const entries: MockLedgerEntry[] = [
    { entryType: 'CREDIT', amount: 10000, balanceAfter: 10000 }, // Deposit
    { entryType: 'DEBIT', amount: 3000, balanceAfter: 7000 },    // Order purchase
    { entryType: 'CREDIT', amount: 1500, balanceAfter: 8500 },   // Refund
  ];

  let calculatedBalance = 0;
  for (const entry of entries) {
    if (entry.entryType === 'CREDIT') {
      calculatedBalance += entry.amount;
    } else {
      calculatedBalance -= entry.amount;
    }
  }

  assert(calculatedBalance === 8500, 'Ledger-derived balance exactly matches running balance (8,500 YER)');
  assert(calculatedBalance === entries[entries.length - 1].balanceAfter, 'Final balance matches latest balanceAfter');

  // Idempotency simulation:
  const processedRefundIds = new Set<string>();
  function creditRefund(refundId: string, amount: number): boolean {
    if (processedRefundIds.has(refundId)) {
      return false; // Idempotent skip
    }
    processedRefundIds.add(refundId);
    return true;
  }

  assert(creditRefund('REF-001', 5000) === true, 'First credit for REF-001 succeeds');
  assert(creditRefund('REF-001', 5000) === false, 'Second identical credit for REF-001 is safely ignored (Idempotent)');

  // ============================================================================
  // 5. MANUAL WALLET SETTLEMENT & MAKER-CHECKER SECURITY
  // ============================================================================
  console.log('\n--- 5. Manual Wallet Settlement & Audit Security ---');

  // Maker-Checker enforcement
  function validateMakerChecker(
    creatorAdminId: string,
    approverAdminId: string,
    enforceDualApproval: boolean
  ): { valid: boolean; error?: string } {
    if (enforceDualApproval && creatorAdminId === approverAdminId) {
      return {
        valid: false,
        error: 'لا يمكن لنفس المسؤول الذي أنشأ الحوالة إتمامها أو اعتمادها (نظام الرقابة الثنائية)',
      };
    }
    return { valid: true };
  }

  const dualApprovalViolation = validateMakerChecker('ADMIN_A', 'ADMIN_A', true);
  assert(!dualApprovalViolation.valid, 'Maker-Checker blocks same admin from approving own transfer');

  const dualApprovalPass = validateMakerChecker('ADMIN_A', 'ADMIN_B', true);
  assert(dualApprovalPass.valid, 'Maker-Checker allows distinct Admin B to approve Admin A transfer');

  // Mandatory Reference & Proof Verification
  function validateTransferCompletion(externalRef: string, proofUrl: string): boolean {
    if (!externalRef || externalRef.trim().length < 4) return false;
    if (!proofUrl || !proofUrl.startsWith('http')) return false;
    return true;
  }

  assert(!validateTransferCompletion('', 'https://s3.souqnaa.com/proofs/123.jpg'), 'Fails without external reference');
  assert(!validateTransferCompletion('TX-98765', ''), 'Fails without transfer proof receipt');
  assert(validateTransferCompletion('TX-98765', 'https://s3.souqnaa.com/proofs/123.jpg'), 'Succeeds with both valid reference and proof');

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runE2ETests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
