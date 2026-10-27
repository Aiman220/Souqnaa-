import { prisma } from '../database/prisma';
import {
  OrderStatus,
  SellerOrderStatus,
  PaymentMethodType,
  PaymentStatus,
  RefundDestination,
} from '@prisma/client';
import { RefundEligibilityService } from '../modules/refunds/services/refund-eligibility.service';
import { RefundService } from '../modules/refunds/services/refund.service';
import { CustomerWalletService } from '../modules/wallet/customer-wallet.service';

async function runWorkstreamETestSuite() {
  console.log('================================================================');
  console.log('SOUQNAA — WORKSTREAM E: REFUNDS, RETURNS & MULTI-SELLER INTEGRATION');
  console.log('================================================================\n');

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

  const testSuffix = Date.now().toString().slice(-6);

  let customer: any;
  let storeA: any;
  let storeB: any;
  let productA: any;
  let productB: any;
  let order: any;
  let sellerOrderA: any;
  let sellerOrderB: any;
  let orderItemA: any;
  let orderItemB: any;
  let payment: any;
  let refundA: any;

  try {
    console.log('--- 0. Setup: Creating Multi-Seller Refund Fixtures ---');
    customer = await prisma.user.findFirst();
    if (!customer) throw new Error('No user found in database');

    const stores = await prisma.store.findMany({
      take: 2,
      include: { seller: true },
    });
    if (stores.length < 1) throw new Error('Need at least 1 store in database');
    storeA = stores[0];
    storeB = stores.length > 1 ? stores[1] : stores[0];

    const products = await prisma.product.findMany({ take: 2 });
    if (products.length < 1) throw new Error('Need at least 1 product in database');
    productA = products[0];
    productB = products.length > 1 ? products[1] : products[0];

    // Create a multi-seller parent order with 2 stores (COD)
    order = await prisma.order.create({
      data: {
        userId: customer.id,
        orderNumber: `ORD-REF-E-${testSuffix}`,
        displayOrderNumber: `#SQ-REF-E-${testSuffix}`,
        currency: 'YER',
        subtotal: 10000,
        deliveryFee: 1000,
        total: 11000,
        status: OrderStatus.PROCESSING,
        payment: {
          create: {
            method: PaymentMethodType.CASH_ON_DELIVERY,
            status: PaymentStatus.PAID,
            amount: 11000,
            currency: 'YER',
          },
        },
        sellerOrders: {
          create: [
            {
              sellerId: storeA.sellerId,
              sellerOrderNumber: `SO-A-${testSuffix}`,
              status: SellerOrderStatus.DELIVERED,
              subtotal: 4000,
              deliveryFee: 500,
              sellerPayout: 3800,
              deliveredAt: new Date(),
              items: {
                create: [
                  {
                    productId: productA.id,
                    productNameAr: productA.titleAr || 'Product A',
                    productNameEn: productA.titleEn || 'Product A',
                    quantity: 2,
                    unitPrice: 2000,
                    totalPrice: 4000,
                  },
                ],
              },
            },
            {
              sellerId: storeB.sellerId,
              sellerOrderNumber: `SO-B-${testSuffix}`,
              status: SellerOrderStatus.SHIPPED,
              subtotal: 6000,
              deliveryFee: 500,
              sellerPayout: 5700,
              items: {
                create: [
                  {
                    productId: productB.id,
                    productNameAr: productB.titleAr || 'Product B',
                    productNameEn: productB.titleEn || 'Product B',
                    quantity: 2,
                    unitPrice: 3000,
                    totalPrice: 6000,
                  },
                ],
              },
            },
          ],
        },
      },
      include: {
        payment: true,
        sellerOrders: {
          include: {
            items: true,
          },
        },
      },
    });

    sellerOrderA = order.sellerOrders[0];
    sellerOrderB = order.sellerOrders[1];
    orderItemA = sellerOrderA.items[0];
    orderItemB = sellerOrderB.items[0];
    payment = order.payment;

    assert(order && sellerOrderA && sellerOrderB, 'Setup: Multi-seller order created successfully');

    // --- TEST 1: Eligibility check allows delivered suborder refund even if sibling is SHIPPED ---
    console.log('\n--- 1. Testing Suborder Eligibility Scoping ---');
    const eligibility = await RefundEligibilityService.checkOrderEligibility(order.id, customer.id);
    assert(
      eligibility.isEligible === true,
      'Eligibility allows refund when delivered suborder exists despite parent order not DELIVERED'
    );
    const itemACheck = eligibility.items.find((i) => i.orderItemId === orderItemA.id);
    const itemBCheck = eligibility.items.find((i) => i.orderItemId === orderItemB.id);
    assert(itemACheck?.isEligible === true, 'Delivered suborder item A is marked eligible');
    assert(itemBCheck?.isEligible === false, 'Undelivered suborder item B is correctly marked ineligible');

    // --- TEST 2: Create Refund Request for Suborder A Only ---
    console.log('\n--- 2. Testing Targeted Suborder Refund Request Creation ---');
    refundA = await RefundService.createRefundRequest({
      orderId: order.id,
      customerId: customer.id,
      reasonText: 'منتج معيب أو تالف أثناء الشحن',
      description: 'المنتج A وصل مكسوراً جزئياً ويطلب استرداد القطعة التالفة',
      destination: RefundDestination.CUSTOMER_WALLET,
      items: [
        {
          orderItemId: orderItemA.id,
          quantity: 1, // Partial quantity refund
        },
      ],
    });

    assert(!!refundA.id, 'Refund request created for Suborder A');

    const updatedSellerOrderA = await prisma.sellerOrder.findUnique({ where: { id: sellerOrderA.id } });
    const updatedSellerOrderB = await prisma.sellerOrder.findUnique({ where: { id: sellerOrderB.id } });
    const updatedParentOrder = await prisma.order.findUnique({ where: { id: order.id } });

    assert(
      updatedSellerOrderA?.status === SellerOrderStatus.RETURN_REQUESTED,
      'Target Suborder A transitioned to RETURN_REQUESTED'
    );
    assert(
      updatedSellerOrderB?.status === SellerOrderStatus.SHIPPED,
      'Sibling Suborder B remained unchanged in SHIPPED status'
    );
    assert(
      updatedParentOrder?.status !== OrderStatus.RETURN_REQUESTED,
      'Parent Order did NOT blanket-transition to RETURN_REQUESTED while Suborder B is active'
    );

    // --- TEST 3: Partial Quantity Re-check (No Blanket Disqualification) ---
    console.log('\n--- 3. Testing Item-Level Remaining Quantity Refundability ---');
    const reEligibility = await RefundEligibilityService.checkOrderEligibility(order.id, customer.id);
    const reItemACheck = reEligibility.items.find((i) => i.orderItemId === orderItemA.id);
    assert(
      reItemACheck?.remainingRefundableQuantity === 1,
      'Remaining refundable quantity on item A is exactly 1 (2 original - 1 pending)'
    );

    // --- TEST 4: Financial Refund Execution & COD Wallet Routing ---
    console.log('\n--- 4. Testing Financial Refund Execution & COD Auto-Wallet Credit ---');
    const walletBefore = await CustomerWalletService.getAccountDetails(customer.id);
    const initialBalance = Number(walletBefore.availableBalance);

    // Approve and execute refund for item A (unitPrice 2000)
    await prisma.$transaction(async (tx) => {
      await (RefundService as any).executeFinancialRefundInternal(
        {
          ...refundA,
          approvedAmount: 2000,
          destination: RefundDestination.ORIGINAL_PAYMENT_METHOD, // COD should auto-credit CUSTOMER_WALLET
          currency: 'YER',
        },
        tx,
        customer.id
      );
    }, { maxWait: 10000, timeout: 25000 });

    const walletAfter = await CustomerWalletService.getAccountDetails(customer.id);
    assert(
      Number(walletAfter.availableBalance) === initialBalance + 2000,
      'COD refund automatically routed and credited to customer internal wallet (+2000 YER)'
    );

    const postRefundPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert(
      postRefundPayment?.status === PaymentStatus.PARTIALLY_REFUNDED,
      'Payment status is correctly marked PARTIALLY_REFUNDED'
    );

    const finalSellerOrderA = await prisma.sellerOrder.findUnique({ where: { id: sellerOrderA.id } });
    const finalSellerOrderB = await prisma.sellerOrder.findUnique({ where: { id: sellerOrderB.id } });
    const finalParentOrder = await prisma.order.findUnique({ where: { id: order.id } });

    assert(
      finalSellerOrderA?.status === SellerOrderStatus.REFUNDED,
      'Target Suborder A correctly updated to REFUNDED status'
    );
    assert(
      finalSellerOrderB?.status === SellerOrderStatus.SHIPPED,
      'Sibling Suborder B still remains untouched in SHIPPED status'
    );
    assert(
      finalParentOrder?.status !== OrderStatus.REFUNDED,
      'Parent Order NOT marked REFUNDED because sibling suborder B is still active'
    );

  } catch (err: any) {
    console.error('[TEST ERROR]', err);
    failed++;
  } finally {
    console.log('\n--- 5. Cleanup Fixtures ---');
    try {
      if (refundA?.id) {
        await prisma.refundStatusHistory.deleteMany({ where: { refundRequestId: refundA.id } });
        await prisma.refundRequestItem.deleteMany({ where: { refundRequestId: refundA.id } });
        await prisma.refundExecutionLock.deleteMany({ where: { refundId: refundA.id } });
        await prisma.refundRequest.deleteMany({ where: { id: refundA.id } });
      }
      if (order?.id) {
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: order.id } });
        await prisma.orderItem.deleteMany({ where: { sellerOrderId: { in: [sellerOrderA?.id, sellerOrderB?.id].filter(Boolean) } } });
        await prisma.sellerOrder.deleteMany({ where: { orderId: order.id } });
        await prisma.payment.deleteMany({ where: { orderId: order.id } });
        await prisma.order.deleteMany({ where: { id: order.id } });
      }
      console.log('[PASS] Test fixtures cleaned up successfully');
    } catch (cleanupErr) {
      console.error('[Cleanup Warning]', cleanupErr);
    }
  }

  console.log('\n====================================================');
  console.log(`WORKSTREAM E RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runWorkstreamETestSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
