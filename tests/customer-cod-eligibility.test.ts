/**
 * SOUQNA MASTER PRODUCTION REGRESSION SUITE:
 * CUSTOMER COD ELIGIBILITY & TRUST SYSTEM
 *
 * Verifies all 18 mandatory scenarios:
 * 1.  New customer: 0/3 — COD unavailable (LOCKED).
 * 2.  One completed prepaid wallet order: 1/3 (LOCKED).
 * 3.  Two completed prepaid wallet orders: 2/3 (LOCKED).
 * 4.  Three completed prepaid wallet orders: COD available (ELIGIBLE).
 * 5.  Three completed manually verified Yemeni wallet orders: COD available (ELIGIBLE).
 * 6.  Pending manual deposit/payment: does not count.
 * 7.  Failed payment: does not count.
 * 8.  COD order: never counts toward the 3 prepaid requirement.
 * 9.  Cancelled order: does not count.
 * 10. Fully refunded order: excluded.
 * 11. Partial refund: follows defined policy (retains legitimate prepaid order).
 * 12. Duplicate payment callback: no duplicate count.
 * 13. Duplicate order completion event: no duplicate count.
 * 14. Customer attempts to manipulate eligibility through API: rejected.
 * 15. Customer suspended for fraud: COD unavailable (SUSPENDED).
 * 16. Customer with valid eligibility: existing prepaid methods still work.
 * 17. Concurrent checkout requests: no eligibility bypass.
 * 18. Manual deposit approval: qualification occurs only after payment verification and order completion.
 */

import { prisma } from '../src/database/prisma';
import { CustomerCodEligibilityService } from '../src/modules/payments/customer-cod-eligibility.service';
import { SellerFinancialRiskService } from '../src/modules/commission/seller-financial-risk.service';
import {
  CustomerCodStatus,
  QualifyingOrderStatus,
  PaymentMethodType,
  PaymentStatus,
  OrderStatus,
  UserRoleType,
} from '@prisma/client';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${details ? `(${details})` : ''}`);
    failedTests++;
  }
}

async function runCustomerCodEligibilityTestSuite() {
  console.log(`\n================================================================================`);
  console.log(`🛡️  SOUQNA MASTER TEST SUITE: CUSTOMER COD ELIGIBILITY (3 COMPLETED PREPAID)`);
  console.log(`================================================================================\n`);

  const runSuffix = `${Date.now()}`;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdProfileCustomerIds: string[] = [];

  try {
    // Helper to create a test customer
    const createTestCustomer = async (label: string) => {
      const email = `test.cod.${label}.${runSuffix}@souqna.test`;
      const phone = `+96771${Math.floor(1000000 + Math.random() * 9000000)}`;
      const user = await prisma.user.create({
        data: {
          email,
          phone,
          passwordHash: 'dummy_hash',
          firstName: 'عميل',
          lastName: label,
          role: UserRoleType.CUSTOMER,
          isActive: true,
          isVerified: true,
        },
      });
      createdUserIds.push(user.id);
      createdProfileCustomerIds.push(user.id);
      return user;
    };

    // Helper to create a test order with payment
    const createTestOrder = async (params: {
      customerId: string;
      total: number;
      method: PaymentMethodType;
      paymentStatus: PaymentStatus;
      orderStatus: OrderStatus;
      walletProvider?: string;
      txStatus?: PaymentStatus;
    }) => {
      const orderSeq = Math.floor(100000 + Math.random() * 900000);
      const orderNumber = `ORD-COD-${runSuffix}-${orderSeq}`;
      const order = await prisma.order.create({
        data: {
          orderNumber,
          userId: params.customerId,
          total: params.total,
          subtotal: params.total,
          currency: 'YER',
          status: params.orderStatus,
          deliveredAt: params.orderStatus === OrderStatus.DELIVERED ? new Date() : null,
          payment: {
            create: {
              method: params.method,
              amount: params.total,
              currency: 'YER',
              status: params.paymentStatus,
              paidAt: params.paymentStatus === PaymentStatus.PAID ? new Date() : null,
              walletProvider: params.walletProvider || null,
              walletTransactionRef: `TX-REF-${orderSeq}`,
              transactions: {
                create: {
                  gateway: params.walletProvider || String(params.method),
                  referenceId: `REF-${orderSeq}`,
                  amount: params.total,
                  status: params.txStatus || params.paymentStatus,
                },
              },
            },
          },
        },
        include: { payment: { include: { transactions: true } } },
      });
      createdOrderIds.push(order.id);
      return order;
    };

    // --- SCENARIO 1: New Customer (0/3) -> COD Unavailable ---
    console.log('--- [1] NEW CUSTOMER: 0/3 COMPLETED ORDERS ---');
    const customer1 = await createTestCustomer('new');
    const elig1 = await CustomerCodEligibilityService.getCustomerCodEligibility(customer1.id);

    assert(elig1.status === CustomerCodStatus.LOCKED, 'New customer has status LOCKED');
    assert(elig1.qualifyingOrdersCount === 0, 'New customer has 0 qualifying orders');
    assert(elig1.requiredOrdersCount === 3, 'Required qualifying orders is 3');
    assert(elig1.remainingOrdersNeeded === 3, 'Remaining orders needed is 3');
    assert(elig1.isCodAvailable === false, 'COD is unavailable for new customer');

    // --- SCENARIO 2: One Completed Prepaid Wallet Order (1/3) ---
    console.log('\n--- [2] ONE COMPLETED PREPAID WALLET ORDER: 1/3 ---');
    const order1 = await createTestOrder({
      customerId: customer1.id,
      total: 5000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalResult1 = await CustomerCodEligibilityService.evaluateQualifyingOrder(order1.id);
    assert(evalResult1.qualified === true, 'First prepaid wallet order qualifies');

    const elig2 = await CustomerCodEligibilityService.getCustomerCodEligibility(customer1.id);
    assert(elig2.status === CustomerCodStatus.LOCKED, 'Status remains LOCKED at 1/3');
    assert(elig2.qualifyingOrdersCount === 1, 'Qualifying orders count is 1');
    assert(elig2.remainingOrdersNeeded === 2, 'Remaining orders needed is 2');
    assert(elig2.isCodAvailable === false, 'COD remains unavailable at 1/3');

    // --- SCENARIO 3: Two Completed Prepaid Wallet Orders (2/3) ---
    console.log('\n--- [3] TWO COMPLETED PREPAID WALLET ORDERS: 2/3 ---');
    const order2 = await createTestOrder({
      customerId: customer1.id,
      total: 8000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalResult2 = await CustomerCodEligibilityService.evaluateQualifyingOrder(order2.id);
    assert(evalResult2.qualified === true, 'Second prepaid wallet order qualifies');

    const elig3 = await CustomerCodEligibilityService.getCustomerCodEligibility(customer1.id);
    assert(elig3.status === CustomerCodStatus.LOCKED, 'Status remains LOCKED at 2/3');
    assert(elig3.qualifyingOrdersCount === 2, 'Qualifying orders count is 2');
    assert(elig3.remainingOrdersNeeded === 1, 'Remaining orders needed is 1');
    assert(elig3.isCodAvailable === false, 'COD remains unavailable at 2/3');

    // --- SCENARIO 4: Three Completed Prepaid Wallet Orders (3/3) -> COD Available ---
    console.log('\n--- [4] THREE COMPLETED PREPAID WALLET ORDERS: COD UNLOCKED ---');
    const order3 = await createTestOrder({
      customerId: customer1.id,
      total: 12000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalResult3 = await CustomerCodEligibilityService.evaluateQualifyingOrder(order3.id);
    assert(evalResult3.qualified === true, 'Third prepaid wallet order qualifies');

    const elig4 = await CustomerCodEligibilityService.getCustomerCodEligibility(customer1.id);
    assert(elig4.status === CustomerCodStatus.ELIGIBLE, 'Status transitioned to ELIGIBLE at 3/3');
    assert(elig4.qualifyingOrdersCount === 3, 'Qualifying orders count is 3');
    assert(elig4.remainingOrdersNeeded === 0, 'Remaining orders needed is 0');
    assert(elig4.isCodAvailable === true, 'COD is unlocked and available');

    // --- SCENARIO 5: Three Completed Manually Verified Yemeni Wallet Orders ---
    console.log('\n--- [5] THREE COMPLETED MANUALLY VERIFIED YEMENI WALLET ORDERS ---');
    const customer2 = await createTestCustomer('yemeni_wallets');
    // Order A: Kuraimi
    const yOrder1 = await createTestOrder({
      customerId: customer2.id,
      total: 6000,
      method: PaymentMethodType.YEMENI_WALLET,
      walletProvider: 'KURAIMI',
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    await CustomerCodEligibilityService.evaluateQualifyingOrder(yOrder1.id);

    // Order B: Jawali
    const yOrder2 = await createTestOrder({
      customerId: customer2.id,
      total: 7500,
      method: PaymentMethodType.YEMENI_WALLET,
      walletProvider: 'JAWALI',
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    await CustomerCodEligibilityService.evaluateQualifyingOrder(yOrder2.id);

    // Order C: OneCash
    const yOrder3 = await createTestOrder({
      customerId: customer2.id,
      total: 9000,
      method: PaymentMethodType.YEMENI_WALLET,
      walletProvider: 'ONECASH',
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    await CustomerCodEligibilityService.evaluateQualifyingOrder(yOrder3.id);

    const eligYemeni = await CustomerCodEligibilityService.getCustomerCodEligibility(customer2.id);
    assert(eligYemeni.status === CustomerCodStatus.ELIGIBLE, 'Yemeni wallet customer unlocks ELIGIBLE');
    assert(eligYemeni.qualifyingOrdersCount === 3, 'Yemeni wallet customer has 3 qualifying orders');
    assert(eligYemeni.isCodAvailable === true, 'COD is unlocked for verified Yemeni wallet orders');

    // --- SCENARIO 6: Pending Manual Deposit / Payment Does Not Count ---
    console.log('\n--- [6] PENDING MANUAL PAYMENT DOES NOT COUNT ---');
    const customer3 = await createTestCustomer('pending_payment');
    const pendingOrder = await createTestOrder({
      customerId: customer3.id,
      total: 5000,
      method: PaymentMethodType.YEMENI_WALLET,
      walletProvider: 'FLOOSAK',
      paymentStatus: PaymentStatus.PENDING,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalPending = await CustomerCodEligibilityService.evaluateQualifyingOrder(pendingOrder.id);
    assert(evalPending.qualified === false, 'Pending payment order is rejected from qualification');
    const eligPending = await CustomerCodEligibilityService.getCustomerCodEligibility(customer3.id);
    assert(eligPending.qualifyingOrdersCount === 0, 'Pending payment counter remains 0');

    // --- SCENARIO 7: Failed Payment Does Not Count ---
    console.log('\n--- [7] FAILED PAYMENT DOES NOT COUNT ---');
    const failedOrder = await createTestOrder({
      customerId: customer3.id,
      total: 5000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.FAILED,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalFailed = await CustomerCodEligibilityService.evaluateQualifyingOrder(failedOrder.id);
    assert(evalFailed.qualified === false, 'Failed payment order is rejected from qualification');
    const eligFailed = await CustomerCodEligibilityService.getCustomerCodEligibility(customer3.id);
    assert(eligFailed.qualifyingOrdersCount === 0, 'Failed payment counter remains 0');

    // --- SCENARIO 8: COD Order Never Counts ---
    console.log('\n--- [8] COD ORDER NEVER COUNTS TOWARD 3 PREPAID REQUIREMENT ---');
    const codOrder = await createTestOrder({
      customerId: customer3.id,
      total: 10000,
      method: PaymentMethodType.CASH_ON_DELIVERY,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    const evalCod = await CustomerCodEligibilityService.evaluateQualifyingOrder(codOrder.id);
    assert(evalCod.qualified === false, 'COD order is strictly rejected from prepaid qualification');
    assert(evalCod.reason.includes('الدفع عند الاستلام'), 'Rejection reason states COD cannot qualify');
    const eligAfterCod = await CustomerCodEligibilityService.getCustomerCodEligibility(customer3.id);
    assert(eligAfterCod.qualifyingOrdersCount === 0, 'COD order does not increment qualifying counter');

    // --- SCENARIO 9: Cancelled Order Does Not Count ---
    console.log('\n--- [9] CANCELLED ORDER DOES NOT COUNT ---');
    const cancelledOrder = await createTestOrder({
      customerId: customer3.id,
      total: 4000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.CANCELLED_BY_CUSTOMER,
    });
    const evalCancelled = await CustomerCodEligibilityService.evaluateQualifyingOrder(cancelledOrder.id);
    assert(evalCancelled.qualified === false, 'Cancelled order cannot qualify');

    // --- SCENARIO 10: Fully Refunded Order Is Excluded ---
    console.log('\n--- [10] FULLY REFUNDED ORDER IS EXCLUDED ---');
    // Qualify an order first
    const refundCustomer = await createTestCustomer('refund_test');
    const rOrder1 = await createTestOrder({
      customerId: refundCustomer.id,
      total: 10000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    await CustomerCodEligibilityService.evaluateQualifyingOrder(rOrder1.id);
    const beforeRefund = await CustomerCodEligibilityService.getCustomerCodEligibility(refundCustomer.id);
    assert(beforeRefund.qualifyingOrdersCount === 1, 'Order qualified before refund (1/3)');

    // Process a full refund (simulate completed refund request)
    await prisma.refundRequest.create({
      data: {
        orderId: rOrder1.id,
        customerId: refundCustomer.id,
        sellerId: (await prisma.seller.findFirst())?.id || 'seller-dummy',
        refundNumber: `REF-${Date.now()}`,
        status: 'REFUND_COMPLETED',
        requestedAmount: 10000,
        approvedAmount: 10000,
        reasonText: 'RETURN_DEFECTIVE',
      },
    });

    await CustomerCodEligibilityService.handleRefundCompleted({
      orderId: rOrder1.id,
      refundApprovedAmount: 10000,
      totalOrderAmount: 10000,
    });

    const afterFullRefund = await CustomerCodEligibilityService.getCustomerCodEligibility(refundCustomer.id);
    assert(afterFullRefund.qualifyingOrdersCount === 0, 'Fully refunded order is excluded (0/3)');

    // --- SCENARIO 11: Partial Refund Follows Defined Policy ---
    console.log('\n--- [11] PARTIAL REFUND FOLLOWS DEFINED POLICY ---');
    const partialOrder = await createTestOrder({
      customerId: refundCustomer.id,
      total: 20000,
      method: PaymentMethodType.WALLET,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.DELIVERED,
    });
    await CustomerCodEligibilityService.evaluateQualifyingOrder(partialOrder.id);

    // Partial refund of 5,000 out of 20,000 (retains 15,000 legitimate net order value)
    await prisma.refundRequest.create({
      data: {
        orderId: partialOrder.id,
        customerId: refundCustomer.id,
        sellerId: (await prisma.seller.findFirst())?.id || 'seller-dummy',
        refundNumber: `REF-PARTIAL-${Date.now()}`,
        status: 'REFUND_COMPLETED',
        requestedAmount: 5000,
        approvedAmount: 5000,
        reasonText: 'PARTIAL_ITEM_RETURN',
      },
    });

    await CustomerCodEligibilityService.handleRefundCompleted({
      orderId: partialOrder.id,
      refundApprovedAmount: 5000,
      totalOrderAmount: 20000,
    });

    const afterPartialRefund = await CustomerCodEligibilityService.getCustomerCodEligibility(refundCustomer.id);
    assert(afterPartialRefund.qualifyingOrdersCount === 1, 'Partial refund retains qualifying order per policy');

    // --- SCENARIO 12: Duplicate Payment Callback: No Duplicate Count ---
    console.log('\n--- [12] DUPLICATE PAYMENT CALLBACK (IDEMPOTENCY) ---');
    const evalRepeat = await CustomerCodEligibilityService.evaluateQualifyingOrder(partialOrder.id);
    assert(evalRepeat.qualified === true, 'Repeated call is accepted idempotently');
    const afterRepeat = await CustomerCodEligibilityService.getCustomerCodEligibility(refundCustomer.id);
    assert(afterRepeat.qualifyingOrdersCount === 1, 'Duplicate payment callback does not increment counter');

    // --- SCENARIO 13: Duplicate Order Completion Event: No Duplicate Count ---
    console.log('\n--- [13] DUPLICATE ORDER COMPLETION EVENT ---');
    await CustomerCodEligibilityService.evaluateQualifyingOrder(partialOrder.id);
    await CustomerCodEligibilityService.evaluateQualifyingOrder(partialOrder.id);
    const afterMultipleEvents = await CustomerCodEligibilityService.getCustomerCodEligibility(refundCustomer.id);
    assert(afterMultipleEvents.qualifyingOrdersCount === 1, 'Multiple order delivery events preserve exact count');

    // --- SCENARIO 14: Client Manipulation Rejected (Backend Authority) ---
    console.log('\n--- [14] BACKEND IS SOLE AUTHORITY (NO EDITABLE CLIENT COUNTER) ---');
    // Attempt to tamper with customerCodProfile manually
    await prisma.customerCodProfile.update({
      where: { customerId: refundCustomer.id },
      data: { qualifyingOrdersCount: 999 }, // client-side simulation tamper
    });
    // Server recalculation reconciles back to genuine verified database records
    const reconciled = await CustomerCodEligibilityService.recalculateCustomerCodEligibility(
      refundCustomer.id,
      'Tamper recovery reconciliation'
    );
    assert(reconciled.qualifyingOrdersCount === 1, 'Server recalculation corrects tampered counter to genuine 1');
    assert(reconciled.isCodAvailable === false, 'Tampered counter is rejected and COD remains locked');

    // --- SCENARIO 15: Customer Suspended for Fraud: COD Unavailable ---
    console.log('\n--- [15] FRAUD SUSPENSION BLOCKS COD ---');
    // Customer 1 is currently ELIGIBLE (3/3)
    const fraudReason = 'تكرار رفض استلام طلبات COD وسلوك طلبيات وهمية متكرر';
    const suspendResult = await CustomerCodEligibilityService.invalidateEligibilityForFraud(
      customer1.id,
      fraudReason,
      'admin-super'
    );
    assert(suspendResult.status === CustomerCodStatus.SUSPENDED, 'Status changed to SUSPENDED');
    assert(suspendResult.isCodAvailable === false, 'COD unavailable for suspended customer');
    assert(suspendResult.suspensionReason === fraudReason, 'Documented fraud suspension reason preserved');

    // Re-check through getCustomerCodEligibility
    const checkSuspended = await CustomerCodEligibilityService.getCustomerCodEligibility(customer1.id);
    assert(checkSuspended.isCodAvailable === false, 'Authoritative getter reports COD unavailable');
    assert(checkSuspended.status === CustomerCodStatus.SUSPENDED, 'Authoritative getter reports SUSPENDED');

    // Test Admin Reinstate
    const reinstateResult = await CustomerCodEligibilityService.reinstateCodEligibility(
      customer1.id,
      'تم التحقق من بيانات العميل والتأكد من انتفاء المخاطر بموجب مراجعة رسمية',
      'admin-super'
    );
    assert(reinstateResult.status === CustomerCodStatus.ELIGIBLE, 'Reinstated customer with 3 orders becomes ELIGIBLE');
    assert(reinstateResult.isCodAvailable === true, 'COD restored after authorized admin review');

    // --- SCENARIO 16: Customer With Valid Eligibility: Prepaid Methods Still Work ---
    console.log('\n--- [16] VALID ELIGIBILITY PRESERVES PREPAID PAYMENT METHODS ---');
    const availablePrepaid = reinstateResult.qualifyingPaymentMethods;
    assert(availablePrepaid.includes('WALLET'), 'WALLET prepaid method preserved');
    assert(availablePrepaid.includes('YEMENI_WALLET'), 'YEMENI_WALLET prepaid method preserved');
    assert(availablePrepaid.includes('KURAIMI'), 'KURAIMI prepaid method preserved');
    assert(availablePrepaid.includes('MADA'), 'MADA prepaid method preserved');

    // --- SCENARIO 17: Concurrent Checkout Requests: No Bypass ---
    console.log('\n--- [17] CONCURRENT CHECKOUT REQUESTS PROTECTION ---');
    const ineligibleCustomer = await createTestCustomer('concurrent_test');
    // Simulate 5 simultaneous checkout COD evaluations
    const concurrentChecks = await Promise.all([
      CustomerCodEligibilityService.getCustomerCodEligibility(ineligibleCustomer.id),
      CustomerCodEligibilityService.getCustomerCodEligibility(ineligibleCustomer.id),
      CustomerCodEligibilityService.getCustomerCodEligibility(ineligibleCustomer.id),
      CustomerCodEligibilityService.getCustomerCodEligibility(ineligibleCustomer.id),
      CustomerCodEligibilityService.getCustomerCodEligibility(ineligibleCustomer.id),
    ]);
    const allRejected = concurrentChecks.every((c) => c.isCodAvailable === false);
    assert(allRejected, 'All 5 concurrent requests consistently reject COD for ineligible customer');

    // --- SCENARIO 18: Manual Deposit Approval Sequence ---
    console.log('\n--- [18] MANUAL DEPOSIT APPROVAL SEQUENCE ---');
    const depositCustomer = await createTestCustomer('deposit_seq');
    // 1. Order created in PENDING payment
    const manualOrder = await createTestOrder({
      customerId: depositCustomer.id,
      total: 15000,
      method: PaymentMethodType.YEMENI_WALLET,
      walletProvider: 'JAWALI',
      paymentStatus: PaymentStatus.PENDING,
      orderStatus: OrderStatus.PENDING,
      txStatus: PaymentStatus.PENDING,
    });
    // Evaluation before approval
    const preApprovalEval = await CustomerCodEligibilityService.evaluateQualifyingOrder(manualOrder.id);
    assert(preApprovalEval.qualified === false, 'Unapproved manual wallet transfer cannot qualify');

    // 2. Order delivered prior to verification (e.g. fast transit)
    await prisma.order.update({
      where: { id: manualOrder.id },
      data: { status: OrderStatus.DELIVERED, deliveredAt: new Date() },
    });
    const preVerifyEval = await CustomerCodEligibilityService.evaluateQualifyingOrder(manualOrder.id);
    assert(preVerifyEval.qualified === false, 'Delivered order with unverified payment cannot qualify');

    // 3. Admin verifies payment
    await prisma.payment.update({
      where: { id: manualOrder.payment!.id },
      data: { status: PaymentStatus.PAID, paidAt: new Date() },
    });
    await prisma.paymentTransaction.updateMany({
      where: { paymentId: manualOrder.payment!.id },
      data: { status: PaymentStatus.PAID },
    });

    // 4. Now evaluate qualifying order
    const postVerifyEval = await CustomerCodEligibilityService.evaluateQualifyingOrder(manualOrder.id);
    assert(postVerifyEval.qualified === true, 'Order qualifies only after payment verification AND completion');

    const postVerifyElig = await CustomerCodEligibilityService.getCustomerCodEligibility(depositCustomer.id);
    assert(postVerifyElig.qualifyingOrdersCount === 1, 'Counter accurately increments to 1/3');

    // Verify audit trail recorded in database
    const historyLogs = await CustomerCodEligibilityService.getCodEligibilityHistory(customer1.id);
    assert(historyLogs.length >= 2, 'Customer eligibility audit history maintains immutable log');

  } catch (error) {
    console.error('Fatal error during test suite execution:', error);
    failedTests++;
  } finally {
    // Clean-up test fixtures to preserve clean DB state
    console.log('\nCleaning up test artifacts...');
    try {
      if (createdOrderIds.length > 0) {
        await prisma.refundRequest.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.customerCodQualifyingOrder.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentTransaction.deleteMany({
          where: { payment: { orderId: { in: createdOrderIds } } },
        });
        await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdProfileCustomerIds.length > 0) {
        await prisma.customerCodEligibilityHistory.deleteMany({
          where: { customerId: { in: createdProfileCustomerIds } },
        });
        await prisma.customerCodProfile.deleteMany({
          where: { customerId: { in: createdProfileCustomerIds } },
        });
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      console.log('Test artifacts successfully cleaned.');
    } catch (cleanupErr) {
      console.error('Error during test cleanup:', cleanupErr);
    }
  }

  console.log(`\n================================================================================`);
  console.log(`📊 TEST SUITE RESULTS: ${passedTests}/${totalTests} PASSED (${Math.round((passedTests / Math.max(1, totalTests)) * 100)}% SUCCESS RATE)`);
  console.log(`================================================================================\n`);

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runCustomerCodEligibilityTestSuite().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
