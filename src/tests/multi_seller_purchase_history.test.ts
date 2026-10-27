import { prisma } from '../database/prisma';
import { OrderStatus, SellerOrderStatus, PaymentMethodType, PaymentStatus, UserRoleType } from '@prisma/client';

async function runMultiSellerTestSuite() {
  console.log('================================================================');
  console.log('SOUQNAA — WORKSTREAM D: MULTI-SELLER & PURCHASE HISTORY TEST');
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

  let customer1: any;
  let customer2: any;
  let storeA: any;
  let storeB: any;
  let storeC: any;
  let productA: any;
  let productB: any;
  let productC: any;
  let multiSellerOrder: any;

  try {
    console.log('--- 0. Setup: Creating Multi-Seller Fixtures ---');
    customer1 = await prisma.user.findFirst();
    if (!customer1) throw new Error('No user found in database');

    customer2 = await prisma.user.findFirst({
      where: { id: { not: customer1.id } },
    });
    if (!customer2) {
      customer2 = await prisma.user.create({
        data: {
          email: `test-cust2-${testSuffix}@souqnaa.online`,
          phone: `+96777${testSuffix}`,
          firstName: 'Test',
          lastName: 'Customer2',
          role: UserRoleType.CUSTOMER,
          passwordHash: 'dummy_hash',
          isVerified: true,
        },
      });
    }

    const stores = await prisma.store.findMany({
      take: 3,
      include: { seller: true },
    });
    if (stores.length < 1) throw new Error('Need at least 1 store in database');
    storeA = stores[0];
    storeB = stores.length > 1 ? stores[1] : stores[0];
    storeC = stores.length > 2 ? stores[2] : stores[0];

    const products = await prisma.product.findMany({ take: 3 });
    if (products.length < 1) throw new Error('Need at least 1 product in database');
    productA = products[0];
    productB = products.length > 1 ? products[1] : products[0];
    productC = products.length > 2 ? products[2] : products[0];

    // Create a multi-seller parent order
    multiSellerOrder = await prisma.order.create({
      data: {
        userId: customer1.id,
        orderNumber: `ORD-MULTI-${testSuffix}`,
        displayOrderNumber: `#SQ-MULTI-${testSuffix}`,
        subtotal: 300,
        deliveryFee: 30,
        total: 330,
        currency: 'YER',
        status: OrderStatus.PROCESSING,
        payment: {
          create: {
            method: PaymentMethodType.WALLET,
            status: PaymentStatus.PAID,
            amount: 330,
            currency: 'YER',
          },
        },
        sellerOrders: {
          create: [
            {
              sellerId: storeA.sellerId,
              status: SellerOrderStatus.PENDING,
              subtotal: 100,
              deliveryFee: 10,
              sellerPayout: 90,
              items: {
                create: [
                  {
                    productId: productA.id,
                    productNameAr: 'منتج تجريبي 1',
                    productNameEn: 'Test Product 1',
                    quantity: 1,
                    unitPrice: 100,
                    totalPrice: 100,
                  },
                ],
              },
            },
            {
              sellerId: storeB.sellerId,
              status: SellerOrderStatus.PROCESSING,
              subtotal: 100,
              deliveryFee: 10,
              sellerPayout: 90,
              items: {
                create: [
                  {
                    productId: productB.id,
                    productNameAr: 'منتج تجريبي 2',
                    productNameEn: 'Test Product 2',
                    quantity: 1,
                    unitPrice: 100,
                    totalPrice: 100,
                  },
                ],
              },
            },
            {
              sellerId: storeC.sellerId,
              status: SellerOrderStatus.SHIPPED,
              subtotal: 100,
              deliveryFee: 10,
              sellerPayout: 90,
              items: {
                create: [
                  {
                    productId: productC.id,
                    productNameAr: 'منتج تجريبي 3',
                    productNameEn: 'Test Product 3',
                    quantity: 1,
                    unitPrice: 100,
                    totalPrice: 100,
                  },
                ],
              },
            },
          ],
        },
      },
      include: {
        sellerOrders: {
          include: {
            items: true,
          },
        },
      },
    });

    assert(
      multiSellerOrder.sellerOrders.length === 3,
      'Multi-seller order created with 3 distinct SellerOrders',
      `Found ${multiSellerOrder.sellerOrders.length}`
    );

    // -------------------------------------------------------------
    // 1. Multi-Tab Discoverability: Filter matching
    // -------------------------------------------------------------
    console.log('\n--- 1. Testing Multi-Seller Multi-Tab Discoverability ---');

    // PENDING filter matches because suborder A is PENDING
    const pendingOrders = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        OR: [
          { status: OrderStatus.PENDING },
          { sellerOrders: { some: { status: SellerOrderStatus.PENDING } } },
        ],
      },
    });
    assert(
      pendingOrders.length === 1,
      'Multi-seller order discoverable in PENDING tab due to suborder A',
      `Found ${pendingOrders.length}`
    );

    // TO_SHIP filter matches because suborder B is PROCESSING
    const toShipOrders = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        OR: [
          { status: { in: [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.READY_TO_SHIP] } },
          { sellerOrders: { some: { status: { in: [SellerOrderStatus.CONFIRMED, SellerOrderStatus.PROCESSING, SellerOrderStatus.READY_TO_SHIP] } } } },
        ],
      },
    });
    assert(
      toShipOrders.length === 1,
      'Multi-seller order discoverable in TO_SHIP tab due to suborder B',
      `Found ${toShipOrders.length}`
    );

    // SHIPPED filter matches because suborder C is SHIPPED
    const shippedOrders = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        OR: [
          { status: OrderStatus.SHIPPED },
          { sellerOrders: { some: { status: SellerOrderStatus.SHIPPED } } },
        ],
      },
    });
    assert(
      shippedOrders.length === 1,
      'Multi-seller order discoverable in SHIPPED tab due to suborder C',
      `Found ${shippedOrders.length}`
    );

    // COMPLETED filter should NOT match yet
    const completedOrders = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        status: OrderStatus.DELIVERED,
      },
    });
    assert(
      completedOrders.length === 0,
      'Multi-seller order NOT matched in COMPLETED tab before full delivery',
      `Found ${completedOrders.length}`
    );

    // -------------------------------------------------------------
    // 2. Partial Fulfillment Delivery & Waiting For Review
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing Partial Delivery & Waiting For Review Scoping ---');

    // Suborder C is delivered to customer
    const suborderC = multiSellerOrder.sellerOrders.find(
      (so: any) => so.status === SellerOrderStatus.SHIPPED
    );
    await prisma.sellerOrder.update({
      where: { id: suborderC.id },
      data: { status: SellerOrderStatus.DELIVERED },
    });

    // Verify TO_REVIEW tab finds this order for customer 1
    const toReviewOrdersCust1 = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        OR: [
          {
            status: OrderStatus.DELIVERED,
            sellerOrders: {
              some: {
                status: SellerOrderStatus.DELIVERED,
                items: {
                  some: {
                    productReviews: {
                      none: {
                        userId: customer1.id,
                      },
                    },
                  },
                },
              },
            },
          },
          {
            sellerOrders: {
              some: {
                status: SellerOrderStatus.DELIVERED,
                items: {
                  some: {
                    productReviews: {
                      none: {
                        userId: customer1.id,
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    assert(
      toReviewOrdersCust1.length === 1,
      'Delivered suborder enables TO_REVIEW discovery for customer 1',
      `Found ${toReviewOrdersCust1.length}`
    );

    // -------------------------------------------------------------
    // 3. User Scoping Regression Verification:
    // When customer 2 reviews product C, customer 1 must STILL have review pending
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing Review Isolation Between Users ---');
    const cust2Review = await prisma.productReview.create({
      data: {
        userId: customer2.id,
        productId: productC.id,
        sellerId: storeC.sellerId,
        orderId: multiSellerOrder.id,
        sellerOrderId: suborderC.id,
        orderItemId: suborderC.items[0].id,
        rating: 5,
        body: 'Great product from customer 2!',
        locale: 'ar',
      },
    });

    const toReviewOrdersCust1AfterCust2Review = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        sellerOrders: {
          some: {
            status: SellerOrderStatus.DELIVERED,
            items: {
              some: {
                productReviews: {
                  none: {
                    userId: customer1.id, // Scoped to customer 1
                  },
                },
              },
            },
          },
        },
      },
    });
    assert(
      toReviewOrdersCust1AfterCust2Review.length === 1,
      'Customer 2 review does NOT wipe Customer 1 review pending badge',
      `Found ${toReviewOrdersCust1AfterCust2Review.length}`
    );

    // When customer 1 submits review for product C:
    const cust1Review = await prisma.productReview.create({
      data: {
        userId: customer1.id,
        productId: productC.id,
        sellerId: storeC.sellerId,
        orderId: multiSellerOrder.id,
        sellerOrderId: suborderC.id,
        orderItemId: suborderC.items[0].id,
        rating: 5,
        body: 'Excellent product from customer 1!',
        locale: 'ar',
      },
    });

    const toReviewOrdersCust1AfterOwnReview = await prisma.order.findMany({
      where: {
        id: multiSellerOrder.id,
        userId: customer1.id,
        sellerOrders: {
          some: {
            status: SellerOrderStatus.DELIVERED,
            items: {
              some: {
                productReviews: {
                  none: {
                    userId: customer1.id,
                  },
                },
              },
            },
          },
        },
      },
    });
    assert(
      toReviewOrdersCust1AfterOwnReview.length === 0,
      'Customer 1 review immediately clears item from TO_REVIEW tab',
      `Found ${toReviewOrdersCust1AfterOwnReview.length}`
    );

    // Clean up reviews created during test
    await prisma.productReview.deleteMany({
      where: {
        id: { in: [cust1Review.id, cust2Review.id] },
      },
    });

    console.log('\n--- 4. Cleanup Fixtures ---');
    const soIds = multiSellerOrder.sellerOrders.map((so: any) => so.id);
    await prisma.orderItem.deleteMany({
      where: { sellerOrderId: { in: soIds } },
    });
    await prisma.sellerOrder.deleteMany({
      where: { orderId: multiSellerOrder.id },
    });
    await prisma.payment.deleteMany({
      where: { orderId: multiSellerOrder.id },
    });
    await prisma.order.delete({
      where: { id: multiSellerOrder.id },
    });
    console.log('[PASS] Test fixtures cleaned up successfully');
  } catch (error: any) {
    console.error('[ERROR during test execution]', error);
    failed++;
  } finally {
    console.log('\n====================================================');
    console.log(`MULTI-SELLER TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runMultiSellerTestSuite();
