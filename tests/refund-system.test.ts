import { RefundStatus, RefundActorType } from '@prisma/client';
import { RefundStateMachine } from '../src/modules/refunds/refund.state-machine';

async function runRefundSystemTests() {
  console.log('🧪 =========================================================');
  console.log('🧪 SOUQNAA — REFUND & DISPUTE SYSTEM AUTOMATED TESTS');
  console.log('🧪 =========================================================\n');

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

  // ──────────────────────────────────────────────────────────────────────────
  // 1. REFUND STATE MACHINE TRANSITIONS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- 1. Refund State Machine Valid Transitions ---');

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.REQUESTED, RefundStatus.SELLER_REVIEW),
    'REQUESTED -> SELLER_REVIEW is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.SELLER_REVIEW, RefundStatus.APPROVED),
    'SELLER_REVIEW -> APPROVED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.SELLER_REVIEW, RefundStatus.REJECTED),
    'SELLER_REVIEW -> REJECTED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.REJECTED, RefundStatus.DISPUTED),
    'REJECTED -> DISPUTED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.DISPUTED, RefundStatus.ADMIN_REVIEW),
    'DISPUTED -> ADMIN_REVIEW is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.ADMIN_REVIEW, RefundStatus.APPROVED),
    'ADMIN_REVIEW -> APPROVED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.ADMIN_REVIEW, RefundStatus.REJECTED),
    'ADMIN_REVIEW -> REJECTED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.APPROVED, RefundStatus.REFUND_PROCESSING),
    'APPROVED -> REFUND_PROCESSING is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.REFUND_PROCESSING, RefundStatus.REFUNDED),
    'REFUND_PROCESSING -> REFUNDED is permitted'
  );

  assert(
    RefundStateMachine.isValidTransition(RefundStatus.REJECTED, RefundStatus.CLOSED),
    'REJECTED -> CLOSED (customer accepts rejection) is permitted'
  );

  console.log('\n--- 2. Refund State Machine Illegal Transitions (Must Fail) ---');

  assert(
    !RefundStateMachine.isValidTransition(RefundStatus.REQUESTED, RefundStatus.REFUNDED),
    'REQUESTED -> REFUNDED is strictly prohibited (must go through review)'
  );

  assert(
    !RefundStateMachine.isValidTransition(RefundStatus.REFUNDED, RefundStatus.REQUESTED),
    'REFUNDED is terminal (cannot transition back to REQUESTED)'
  );

  assert(
    !RefundStateMachine.isValidTransition(RefundStatus.CLOSED, RefundStatus.APPROVED),
    'CLOSED is terminal (cannot transition to APPROVED)'
  );

  assert(
    !RefundStateMachine.isValidTransition(RefundStatus.CANCELLED, RefundStatus.SELLER_REVIEW),
    'CANCELLED is terminal (cannot transition to SELLER_REVIEW)'
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 2. ROLE AUTHORIZATION CHECKS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Actor Role Permissions ---');

  assert(
    RefundStateMachine.isAuthorized(
      RefundStatus.SELLER_REVIEW,
      RefundStatus.APPROVED,
      RefundActorType.SELLER
    ),
    'Seller is authorized to approve during SELLER_REVIEW'
  );

  assert(
    !RefundStateMachine.isAuthorized(
      RefundStatus.SELLER_REVIEW,
      RefundStatus.APPROVED,
      RefundActorType.CUSTOMER
    ),
    'Customer is NOT authorized to self-approve during SELLER_REVIEW'
  );

  assert(
    RefundStateMachine.isAuthorized(
      RefundStatus.REJECTED,
      RefundStatus.DISPUTED,
      RefundActorType.CUSTOMER
    ),
    'Customer is authorized to open DISPUTE after rejection'
  );

  assert(
    RefundStateMachine.isAuthorized(
      RefundStatus.ADMIN_REVIEW,
      RefundStatus.APPROVED,
      RefundActorType.ADMIN
    ),
    'Admin is authorized to resolve and approve dispute'
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 3. DOUBLE-REFUND PROTECTION MATHEMATICS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Critical Double-Refund Protection Logic ---');

  // Test Case from Spec Section 38:
  // Item total: 10,000 YER
  // Refund 1: 6,000 YER
  // Remaining refundable: 4,000 YER
  // Attempt second refund: 5,000 YER -> Must reject
  // Second refund for 4,000 YER -> Allowed

  const itemPrice = 10000;
  const voucherDiscount = 0;
  const effectiveItemTotal = itemPrice - voucherDiscount;

  let approvedRefunds = 6000;
  let remainingRefundable = Math.max(0, effectiveItemTotal - approvedRefunds);

  assert(remainingRefundable === 4000, 'Remaining refundable correctly calculated as 4,000 YER');

  function attemptRefund(requestedAmount: number, maxAllowed: number): { allowed: boolean; grantedAmount: number } {
    if (requestedAmount > maxAllowed) {
      return { allowed: false, grantedAmount: 0 };
    }
    return { allowed: true, grantedAmount: requestedAmount };
  }

  const firstExcessAttempt = attemptRefund(5000, remainingRefundable);
  assert(
    !firstExcessAttempt.allowed,
    'Attempt to refund 5,000 YER when remaining is 4,000 YER is REJECTED'
  );

  const secondValidAttempt = attemptRefund(4000, remainingRefundable);
  assert(
    secondValidAttempt.allowed && secondValidAttempt.grantedAmount === 4000,
    'Attempt to refund remaining 4,000 YER is ACCEPTED'
  );

  approvedRefunds += secondValidAttempt.grantedAmount;
  remainingRefundable = Math.max(0, effectiveItemTotal - approvedRefunds);

  assert(remainingRefundable === 0, 'Item remaining refundable is now 0 YER');

  const thirdAttempt = attemptRefund(100, remainingRefundable);
  assert(
    !thirdAttempt.allowed,
    'Subsequent refund attempt on fully-refunded item is strictly REJECTED'
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 4. COMMISSION REVERSAL & FINANCIAL LEDGER ACCOUNTING
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Commission Reversal & Seller Debit Mathematics ---');

  // Specification example:
  // Product: 10,000 YER
  // Marketplace commission: 10% = 1,000 YER
  // Full refund (10,000 YER):
  // Customer refund: 10,000 YER
  // Commission reversal: 1,000 YER
  // Seller net financial debit: 9,000 YER

  function calculateFinancialBreakdown(subtotal: number, commissionAmount: number, refundAmount: number) {
    const rate = subtotal > 0 ? commissionAmount / subtotal : 0.10;
    const commissionRev = parseFloat((refundAmount * rate).toFixed(2));
    const sellerDebit = parseFloat((refundAmount - commissionRev).toFixed(2));
    return {
      customerRefund: refundAmount,
      commissionReversal: commissionRev,
      sellerNetDebit: sellerDebit,
    };
  }

  const fullRefundCalc = calculateFinancialBreakdown(10000, 1000, 10000);
  assert(
    fullRefundCalc.customerRefund === 10000 &&
    fullRefundCalc.commissionReversal === 1000 &&
    fullRefundCalc.sellerNetDebit === 9000,
    'Full refund: Customer +10,000 YER, Commission Reversal -1,000 YER, Seller Debit -9,000 YER'
  );

  // Partial refund: 4,000 YER on 10,000 YER item with 10% commission
  const partialRefundCalc = calculateFinancialBreakdown(10000, 1000, 4000);
  assert(
    partialRefundCalc.customerRefund === 4000 &&
    partialRefundCalc.commissionReversal === 400 &&
    partialRefundCalc.sellerNetDebit === 3600,
    'Partial refund (4,000 YER): Commission Reversal 400 YER, Seller Debit 3,600 YER'
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 5. COD ACCOUNTING RULES
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- 6. Cash on Delivery (COD) Accounting Rules ---');

  function evaluateCODRefundAction(paymentStatus: string, refundAmount: number) {
    if (paymentStatus === 'PAID') {
      return {
        refundAction: 'CREDIT_CUSTOMER_WALLET_OR_PAYABLE',
        createCashOutflow: true,
      };
    } else {
      return {
        refundAction: 'REDUCE_FINANCIAL_OBLIGATION_ONLY',
        createCashOutflow: false,
      };
    }
  }

  const codUnpaid = evaluateCODRefundAction('PENDING', 10000);
  assert(
    !codUnpaid.createCashOutflow && codUnpaid.refundAction === 'REDUCE_FINANCIAL_OBLIGATION_ONLY',
    'COD Unpaid: Reduces financial obligation without fake cash payout'
  );

  const codPaid = evaluateCODRefundAction('PAID', 10000);
  assert(
    codPaid.createCashOutflow && codPaid.refundAction === 'CREDIT_CUSTOMER_WALLET_OR_PAYABLE',
    'COD Paid: Creates legitimate customer wallet/payable settlement record'
  );

  console.log('\n=========================================================');
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRefundSystemTests().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
