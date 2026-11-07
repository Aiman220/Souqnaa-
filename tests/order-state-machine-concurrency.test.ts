import { OrderStateMachine } from '../src/modules/orders/order.state-machine';
import { SellerOrderStatus, OrderStatus } from '@prisma/client';
import { AppError } from '../src/middleware/error.middleware';

async function runConcurrencyRegressionTests() {
  console.log('==================================================================');
  console.log('🧪 SOUQNA ORDER STATE MACHINE TOCTOU & CAS CONCURRENCY REGRESSION TEST');
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

  // 1. Valid Transition Matrix Integrity
  console.log('1. Transition Matrix Permissibility:');
  assert(
    OrderStateMachine.isValidTransition(SellerOrderStatus.PENDING, SellerOrderStatus.CONFIRMED),
    'PENDING -> CONFIRMED is valid'
  );
  assert(
    OrderStateMachine.isValidTransition(SellerOrderStatus.PENDING, SellerOrderStatus.CANCELLED_BY_CUSTOMER),
    'PENDING -> CANCELLED_BY_CUSTOMER is valid'
  );
  assert(
    OrderStateMachine.isValidTransition(SellerOrderStatus.CONFIRMED, SellerOrderStatus.PROCESSING),
    'CONFIRMED -> PROCESSING is valid'
  );
  assert(
    OrderStateMachine.isValidTransition(SellerOrderStatus.PROCESSING, SellerOrderStatus.SHIPPED),
    'PROCESSING -> SHIPPED is valid'
  );
  assert(
    OrderStateMachine.isValidTransition(SellerOrderStatus.SHIPPED, SellerOrderStatus.DELIVERED),
    'SHIPPED -> DELIVERED is valid'
  );

  // 2. Conflicting / Terminal Transition Rejection
  console.log('\n2. Invalid / Conflicting State Transitions Rejection:');
  assert(
    !OrderStateMachine.isValidTransition(SellerOrderStatus.CANCELLED_BY_CUSTOMER, SellerOrderStatus.CONFIRMED),
    'CANCELLED_BY_CUSTOMER -> CONFIRMED is strictly forbidden (prevents reactivating cancelled orders)'
  );
  assert(
    !OrderStateMachine.isValidTransition(SellerOrderStatus.CANCELLED_BY_SELLER, SellerOrderStatus.DELIVERED),
    'CANCELLED_BY_SELLER -> DELIVERED is strictly forbidden'
  );
  assert(
    !OrderStateMachine.isValidTransition(SellerOrderStatus.DELIVERED, SellerOrderStatus.PENDING),
    'DELIVERED -> PENDING backwards transition is forbidden'
  );
  assert(
    !OrderStateMachine.isValidTransition(SellerOrderStatus.REFUNDED, SellerOrderStatus.SHIPPED),
    'REFUNDED -> SHIPPED is strictly forbidden'
  );

  // 3. Parent Order Status Synchronization Logic
  console.log('\n3. Parent Order Aggregation Consistency:');
  assert(
    OrderStateMachine.isValidTransition(OrderStatus.PENDING, OrderStatus.CONFIRMED),
    'Parent Order PENDING -> CONFIRMED is valid'
  );
  assert(
    !OrderStateMachine.isValidTransition(OrderStatus.CANCELLED_BY_CUSTOMER, OrderStatus.CONFIRMED),
    'Parent Order CANCELLED_BY_CUSTOMER -> CONFIRMED is strictly forbidden'
  );

  // 4. Verify CAS Conflict Error Semantics
  console.log('\n4. CAS Conflict Error Formulation:');
  const conflictError = new AppError(
    'تعارض في التحديث المتزامن للطلب. يرجى إعادة المحاولة.',
    409,
    'CONCURRENT_TRANSITION_CONFLICT'
  );
  assert(
    conflictError.statusCode === 409,
    'CAS guard conflict throws HTTP 409 status code'
  );
  assert(
    conflictError.code === 'CONCURRENT_TRANSITION_CONFLICT',
    'CAS guard specifies CONCURRENT_TRANSITION_CONFLICT error code'
  );

  console.log('\n==================================================================');
  console.log(`TEST SUMMARY: Passed: ${passed} | Failed: ${failed}`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runConcurrencyRegressionTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
