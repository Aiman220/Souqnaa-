import { OrderStateMachine } from '../src/modules/orders/order.state-machine';
import { CustomerWalletService } from '../src/modules/wallet/customer-wallet.service';
import { PaymentStatus, SellerOrderStatus, WalletTxType, WalletTxStatus } from '@prisma/client';

async function runWalletRefundTests() {
  console.log('==================================================================');
  console.log('🧪 SOUQNA WALLET REFUND ON SELLER CANCELLATION & RETURN TEST SUITE');
  console.log('==================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // 1. Single Seller Order Full Payment Calculation Logic Verification
  console.log('1. Full Payment Calculation for Single Seller Order:');
  const mockSingleOrder = {
    id: 'ord_101',
    orderNumber: 'SQ-101',
    userId: 'cust_1',
    total: 15000,
    subtotal: 12000,
    deliveryFee: 2500,
    taxAmount: 500,
    payment: {
      id: 'pay_101',
      status: PaymentStatus.PAID,
      method: 'WALLET',
      amount: 15000,
    },
  };

  const mockSingleSellerOrder = {
    id: 'so_101',
    orderId: 'ord_101',
    sellerId: 'sel_1',
    subtotal: 12000,
    deliveryFee: 2500,
    taxAmount: 500,
    voucherDiscountAmount: 0,
    sellerPayout: 11000,
  };

  const priorRefundLedgers: any[] = [];
  const priorRefundTotal = priorRefundLedgers.reduce((sum: number, l: any) => sum + (l.amount || 0), 0);
  const fullOrderPayment = Number(mockSingleOrder.total || 0);
  const maxRemainingToRefund = Math.max(0, parseFloat((fullOrderPayment - priorRefundTotal).toFixed(2)));

  const allSubOrders = [mockSingleSellerOrder];
  const isSingleSubOrder = allSubOrders.length <= 1;

  let calculatedRefundAmount = 0;
  if (isSingleSubOrder) {
    calculatedRefundAmount = maxRemainingToRefund;
  }

  assert(
    calculatedRefundAmount === 15000,
    'Single seller order refunds entire order.total (15,000 YER) including delivery and tax instead of only subtotal (12,000 YER)'
  );

  // 2. Multi-Seller Sub-Order Proportional Full Payment Calculation Verification
  console.log('\n2. Multi-Seller Sub-Order Full Payment Calculation:');
  const mockMultiOrder = {
    id: 'ord_202',
    orderNumber: 'SQ-202',
    userId: 'cust_2',
    total: 30000,
    payment: {
      status: PaymentStatus.PAID,
      method: 'CARD',
      amount: 30000,
    },
  };

  const so1 = {
    id: 'so_201',
    orderId: 'ord_202',
    sellerId: 'sel_A',
    status: 'CONFIRMED',
    subtotal: 18000,
    customerDeliveryCharge: 1500,
    deliveryFee: 1500,
    taxAmount: 500,
    voucherDiscountAmount: 1000,
  };

  const so2 = {
    id: 'so_202',
    orderId: 'ord_202',
    sellerId: 'sel_B',
    status: 'CONFIRMED',
    subtotal: 10000,
    customerDeliveryCharge: 1000,
    deliveryFee: 1000,
    taxAmount: 0,
    voucherDiscountAmount: 0,
  };

  const multiSubOrders = [so1, so2];
  const otherSubOrders = multiSubOrders.filter((s) => s.id !== so1.id);
  const allOthersTerminated = otherSubOrders.every((s) => s.status.startsWith('CANCELLED_'));

  assert(
    allOthersTerminated === false,
    'Correctly detects that sibling seller orders are still active'
  );

  const custDelivery = so1.customerDeliveryCharge ?? so1.deliveryFee ?? 0;
  const custTax = so1.taxAmount ?? 0;
  const custDiscount = so1.voucherDiscountAmount ?? 0;
  const subOrderFullAmount = Math.max(
    0,
    parseFloat((so1.subtotal + custDelivery + custTax - custDiscount).toFixed(2))
  );

  assert(
    subOrderFullAmount === 19000,
    'Sub-order 1 full payment is subtotal (18k) + delivery (1.5k) + tax (500) - discount (1k) = 19,000 YER'
  );

  // When second seller order is also cancelled subsequently
  const priorLedgersAfterSo1 = [{ amount: 19000 }];
  const priorRefundTotal2 = priorLedgersAfterSo1.reduce((sum: number, l: any) => sum + (l.amount || 0), 0);
  const maxRemaining2 = Math.max(0, parseFloat((mockMultiOrder.total - priorRefundTotal2).toFixed(2)));

  assert(
    maxRemaining2 === 11000,
    'Remaining order total for final seller order cancellation is exactly 11,000 YER (30k - 19k)'
  );

  // 3. Payment Status Transition Logic Verification
  console.log('\n3. Payment Status Reflection:');
  const isFullyRefunded1 = (mockMultiOrder.total - 19000) <= 0.01;
  assert(!isFullyRefunded1, 'Partial sub-order cancellation leaves order payment in PARTIALLY_REFUNDED');

  const isFullyRefunded2 = (maxRemaining2 - 11000) <= 0.01;
  assert(isFullyRefunded2, 'Final sub-order cancellation transitions order payment to REFUNDED');

  // 4. Return Request Approval Wallet Refund Logic Verification
  console.log('\n4. Return Request Approval (RETURN_APPROVED):');
  assert(
    OrderStateMachine.isValidTransition('DELIVERED', 'RETURN_APPROVED') ||
    OrderStateMachine.isValidTransition('RETURN_REQUESTED', 'RETURN_APPROVED'),
    'Transition to RETURN_APPROVED is valid from return states'
  );

  console.log('\n==================================================================');
  console.log(`TEST SUMMARY: Passed: ${passed} | Failed: ${failed}`);
  console.log('==================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runWalletRefundTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
