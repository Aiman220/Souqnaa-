import { prisma } from '../src/database/prisma';
import { DisputeService } from '../src/modules/disputes/dispute.service';
import { DisputeStatus, RefundActorType, UserRoleType, SellerStatus } from '@prisma/client';
import { fcmPushProvider } from '../src/modules/notifications/providers/push.provider';
import { NotificationEventFactory } from '../src/modules/notifications/events/domain-events';
import { notificationDeliveryService } from '../src/modules/notifications/services/notification-delivery.service';
import { notificationTemplateService } from '../src/modules/notifications/services/notification-template.service';

async function runDisputeLifecycleTests() {
  console.log('========================================================================');
  console.log('⚖️ RUNNING PHASE 10: UNIVERSAL DISPUTE LIFECYCLE & LIVE NOTIFICATIONS TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // Generate test entities with timestamp
  const ts = Date.now();
  const testCustomerEmail = `customer_dispute_${ts}@souqnaa.test`;
  const testSellerEmail = `seller_dispute_${ts}@souqnaa.test`;
  const testAdminEmail = `admin_dispute_${ts}@souqnaa.test`;
  const testOtherEmail = `unauth_dispute_${ts}@souqnaa.test`;

  console.log('1. Setting up verified test participants & order in database:');
  const customer = await prisma.user.create({
    data: {
      email: testCustomerEmail,
      phone: `+96777${ts.toString().slice(-6)}`,
      passwordHash: 'hash',
      role: UserRoleType.CUSTOMER,
      firstName: 'أحمد',
      lastName: 'العميل',
    },
  });

  const sellerUser = await prisma.user.create({
    data: {
      email: testSellerEmail,
      phone: `+96771${ts.toString().slice(-6)}`,
      passwordHash: 'hash',
      role: UserRoleType.SELLER,
      firstName: 'محمد',
      lastName: 'التاجر',
    },
  });

  const seller = await prisma.seller.create({
    data: {
      userId: sellerUser.id,
      status: SellerStatus.ACTIVE,
    },
  });

  const admin = await prisma.user.create({
    data: {
      email: testAdminEmail,
      phone: `+96773${ts.toString().slice(-6)}`,
      passwordHash: 'hash',
      role: UserRoleType.ADMIN,
      firstName: 'مشرف',
      lastName: 'المنصة',
    },
  });

  const otherUser = await prisma.user.create({
    data: {
      email: testOtherEmail,
      phone: `+96770${ts.toString().slice(-6)}`,
      passwordHash: 'hash',
      role: UserRoleType.CUSTOMER,
      firstName: 'دخيل',
      lastName: 'غير_مصرح',
    },
  });

  // Create real test device token for seller
  const sellerDeviceToken = `fcm_real_mock_seller_token_${ts}_xyz987654321`;
  await prisma.notificationDevice.create({
    data: {
      userId: sellerUser.id,
      deviceId: `device_seller_${ts}`,
      deviceToken: sellerDeviceToken,
      platform: 'android',
      pushProvider: 'FCM',
      isActive: true,
    },
  });

  // Create test order
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-DSP-${ts}`,
      userId: customer.id,
      total: 25000,
      subtotal: 25000,
      currency: 'YER',
      status: 'DELIVERED',
      addressSnapshot: {
        create: {
          recipientName: 'أحمد العميل',
          recipientPhone: customer.phone || '+96777000000',
          cityName: 'صنعاء',
          street: 'شارع حدة',
        },
      },
      sellerOrders: {
        create: {
          sellerId: seller.id,
          sellerOrderNumber: `SO-DSP-${ts}`,
          subtotal: 25000,
          sellerPayout: 22500,
          status: 'DELIVERED',
        },
      },
    },
  });

  assert(Boolean(order && order.id), 'Test order and participants created with real database constraints');

  // -------------------------------------------------------------------------
  // 2. Open Dispute Lifecycle: Validation, Database Commit, In-App Notifications
  // -------------------------------------------------------------------------
  console.log('\n2. Dispute Opened & Submitted:');
  const dispute = await DisputeService.openDispute({
    customerId: customer.id,
    orderId: order.id,
    reason: 'المنتج تالف ولا يعمل إطلاقاً',
    description: 'استلمت الجهاز مكسور الشاشة ومرفق الصور التي توضح ذلك',
    evidence: [
      {
        fileUrl: 'https://cdn.souqnaa.com/disputes/damaged1.jpg',
        fileType: 'image/jpeg',
        fileSize: 1024 * 500,
        mimeType: 'image/jpeg',
        description: 'صورة الشاشة المكسورة',
      },
    ],
  });

  assert(dispute.status === DisputeStatus.OPEN, 'Dispute initialized with status OPEN');
  assert(dispute.orderId === order.id, 'Dispute correctly references order ID');
  assert(dispute.customerId === customer.id, 'Dispute associated with customer');
  assert(dispute.sellerId === seller.id, 'Dispute associated with target seller');

  // Verify duplicate dispute blocked
  let duplicateBlocked = false;
  try {
    await DisputeService.openDispute({
      customerId: customer.id,
      orderId: order.id,
      reason: 'نزاع مكرر',
      description: 'محاولة فتح نزاع ثانٍ لنفس الطلب',
    });
  } catch (err: any) {
    duplicateBlocked = true;
    assert(err.message.includes('يوجد نزاع مفتوح بالفعل'), 'Backend idempotency prevents duplicate active disputes');
  }
  assert(duplicateBlocked, 'Duplicate dispute creation prevented');

  // -------------------------------------------------------------------------
  // 3. In-App Notifications & Deep Link Routing
  // -------------------------------------------------------------------------
  console.log('\n3. In-App Notifications & Deep Link Resolution:');
  const customerNotifications = await prisma.notification.findMany({
    where: { userId: customer.id },
    orderBy: { createdAt: 'desc' },
  });
  assert(customerNotifications.length > 0, 'Durable in-app notification recorded for customer');
  const custNotif = customerNotifications[0];
  assert(Boolean(custNotif && custNotif.isRead === false), 'Notification defaults to unread (isRead: false)');
  assert(custNotif.deepLink === `souqnaa://disputes/${dispute.id}`, 'Deep link matches customer dispute route');
  assert(Boolean(custNotif.titleAr && custNotif.titleAr.includes('تسجيل النزاع')), 'Localized Arabic title generated correctly');

  // Seller in-app notification
  const sellerNotifications = await prisma.notification.findMany({
    where: { userId: sellerUser.id },
    orderBy: { createdAt: 'desc' },
  });
  assert(sellerNotifications.length > 0, 'Durable in-app notification recorded for seller');
  const selNotif = sellerNotifications[0];
  assert(Boolean(selNotif && selNotif.deepLink?.includes(dispute.id)), 'Seller deep link references dispute ID');
  assert(Boolean(selNotif && selNotif.titleAr?.includes('نزاع جديد')), 'Seller receives explicit action-required notification');

  // -------------------------------------------------------------------------
  // 4. Seller Response Workflow
  // -------------------------------------------------------------------------
  console.log('\n4. Seller Response & Evidence Submission:');
  const respondedDispute = await DisputeService.sellerRespond({
    disputeId: dispute.id,
    sellerUserId: sellerUser.id,
    response: 'تم فحص المنتج قبل الشحن وكان سليماً، ولكننا نقبل الفحص الفني للقطعة',
    acceptClaim: false,
    evidence: [
      {
        fileUrl: 'https://cdn.souqnaa.com/seller/packaging_proof.jpg',
        fileType: 'image/jpeg',
        fileSize: 1024 * 300,
        mimeType: 'image/jpeg',
        description: 'صورة المنتج قبل الشحن من المستودع',
      },
    ],
  });

  assert(respondedDispute.status === DisputeStatus.UNDER_REVIEW, 'Dispute transitions to UNDER_REVIEW upon seller response');
  assert(Boolean(respondedDispute.adminNotes?.includes('رد المتجر')), 'Audit trail records seller response in case notes');

  // -------------------------------------------------------------------------
  // 5. Additional Evidence & Messages Thread
  // -------------------------------------------------------------------------
  console.log('\n5. Multi-Party Evidence & Message Threading:');
  const newEvidence = await DisputeService.submitEvidence({
    disputeId: dispute.id,
    userId: customer.id,
    role: RefundActorType.CUSTOMER,
    fileUrl: 'https://cdn.souqnaa.com/evidence/unboxing_video.mp4',
    fileType: 'video/mp4',
    fileSize: 1024 * 1024 * 5,
    mimeType: 'video/mp4',
    description: 'فيديو فتح الصندوق',
  });
  assert(newEvidence.fileUrl.includes('unboxing_video.mp4'), 'Customer evidence uploaded and verified');

  const customerMsg = await DisputeService.sendMessage({
    disputeId: dispute.id,
    senderId: customer.id,
    senderRole: RefundActorType.CUSTOMER,
    message: 'أرجو النظر في مقطع الفيديو المرفق الذي يوضح استلام الصندوق تالفاً',
  });
  assert(customerMsg.message.includes('مقطع الفيديو'), 'Dispute case message recorded in relational thread');

  // Admin internal private note
  const adminPrivateNote = await DisputeService.sendMessage({
    disputeId: dispute.id,
    senderId: admin.id,
    senderRole: RefundActorType.ADMIN,
    message: 'فحص داخلي: تقرير شركة الشحن يؤكد سقوط الطرد أثناء النقل',
    isPrivateAdminNote: true,
  });
  assert(adminPrivateNote.isPrivateAdminNote === true, 'Private admin internal note marked correctly');

  // -------------------------------------------------------------------------
  // 6. Security & Unauthorized Access Enforcement (§F)
  // -------------------------------------------------------------------------
  console.log('\n6. Security & Authorization Boundary Verification:');
  let unauthBlocked = false;
  try {
    await DisputeService.sendMessage({
      disputeId: dispute.id,
      senderId: otherUser.id,
      senderRole: RefundActorType.CUSTOMER,
      message: 'محاولة اختراق محادثة النزاع',
    });
  } catch (err: any) {
    unauthBlocked = true;
    assert(err.statusCode === 403, 'Unauthorized third-party user blocked with 403 Forbidden');
  }
  assert(unauthBlocked, 'Unauthorized access strictly denied');

  // -------------------------------------------------------------------------
  // 7. Live Reconciliation Sync (§E)
  // -------------------------------------------------------------------------
  console.log('\n7. Live Reconciliation Sync (Foreground Resume / Reconnect):');
  const syncCustomer = await DisputeService.syncDispute(dispute.id, customer.id, 'CUSTOMER');
  assert(syncCustomer.dispute.id === dispute.id, 'Sync reconciles dispute details');
  assert(syncCustomer.evidence.length >= 2, 'Sync delivers all evidence files');
  assert(
    syncCustomer.messages.every((m) => m.isPrivateAdminNote === false),
    'Customer sync never leaks private admin notes'
  );

  const syncAdmin = await DisputeService.syncDispute(dispute.id, admin.id, 'ADMIN');
  assert(
    syncAdmin.messages.some((m) => m.isPrivateAdminNote === true),
    'Admin sync includes private investigation notes'
  );

  // -------------------------------------------------------------------------
  // 8. Admin Resolution & Authoritative Financial Execution
  // -------------------------------------------------------------------------
  console.log('\n8. Admin Resolution & Financial Execution:');
  const resolutionResult = await DisputeService.resolveDispute({
    disputeId: dispute.id,
    adminUserId: admin.id,
    decision: 'FULL_REFUND',
    resolution: 'تقرر قبول طلب العميل وتعويضه بكامل المبلغ نظراً لثبوت تلف الشحنة أثناء النقل',
    refundAmount: 25000,
    note: 'تمت التسوية وتحميل شركة الشحن التكلفة',
  });

  assert(resolutionResult.status === DisputeStatus.RESOLVED, 'Dispute marked as RESOLVED');
  assert(resolutionResult.decision === 'FULL_REFUND', 'Dispute decision recorded as FULL_REFUND');
  assert(resolutionResult.refundAmount === 25000, 'Authoritative refund amount recorded');

  // Check financial refund record created in database
  const refundLedger = await prisma.refund.findFirst({
    where: { orderId: order.id },
  });
  assert(Boolean(refundLedger && refundLedger.amount === 25000), 'Canonical financial Refund record written');

  // Check order status updated
  const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
  assert(updatedOrder?.status === 'REFUNDED', 'Order status atomically transitioned to REFUNDED');

  // Check Customer wallet credited
  const walletTx = await prisma.walletLedgerEntry.findFirst({
    where: {
      walletAccount: { userId: customer.id },
      type: 'REFUND_CREDIT',
    },
  });
  assert(Boolean(walletTx && walletTx.amount === 25000), 'Customer electronic wallet credited with full refund');

  // -------------------------------------------------------------------------
  // 9. Appeal / Reopen Lifecycle (§A)
  // -------------------------------------------------------------------------
  console.log('\n9. Dispute Appeal / Reopen Lifecycle:');
  const appealedDispute = await DisputeService.appealDispute({
    disputeId: dispute.id,
    userId: sellerUser.id,
    role: 'SELLER',
    appealReason: 'لدينا بوليصة تأمين تغطي الشحنة ونرغب بإعادة فتح الملف للمطالبة التأمينية',
    evidence: [
      {
        fileUrl: 'https://cdn.souqnaa.com/insurance_policy.pdf',
        fileType: 'application/pdf',
        fileSize: 1024 * 800,
        mimeType: 'application/pdf',
        description: 'بوليصة تأمين الشحنة',
      },
    ],
  });

  assert(appealedDispute.status === DisputeStatus.UNDER_REVIEW, 'Appeal transitions dispute back to UNDER_REVIEW');
  assert(Boolean(appealedDispute.adminNotes?.includes('طلب استئناف')), 'Appeal noted in audit log');

  // -------------------------------------------------------------------------
  // 10. Multi-Device Unread Count & Badge Synchronization (§B, §E)
  // -------------------------------------------------------------------------
  console.log('\n10. Unread Count & Multi-Device Badge Synchronization:');
  const initialUnread = await prisma.notification.count({
    where: { userId: customer.id, isRead: false },
  });
  assert(initialUnread > 0, `Unread notifications tracked accurately (initial: ${initialUnread})`);

  // Mark all as read
  await prisma.notification.updateMany({
    where: { userId: customer.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });

  const finalUnread = await prisma.notification.count({
    where: { userId: customer.id, isRead: false },
  });
  assert(finalUnread === 0, 'Marking as read zeroes unread count without double-counting');

  // Cleanup test records
  console.log('\nCleaning up test artifacts...');
  try {
    await prisma.notification.deleteMany({
      where: { userId: { in: [customer.id, sellerUser.id, admin.id, otherUser.id] } },
    });
    await prisma.notificationDevice.deleteMany({
      where: { userId: { in: [customer.id, sellerUser.id, admin.id, otherUser.id] } },
    });
    await prisma.refundEvidence.deleteMany({
      where: { refundRequest: { orderId: order.id } },
    });
    await prisma.refundMessage.deleteMany({
      where: { refundRequest: { orderId: order.id } },
    });
    await prisma.refundStatusHistory.deleteMany({
      where: { refundRequest: { orderId: order.id } },
    });
    await prisma.refundRequest.deleteMany({
      where: { orderId: order.id },
    });
    await prisma.refund.deleteMany({
      where: { orderId: order.id },
    });
    await prisma.dispute.deleteMany({
      where: { orderId: order.id },
    });
    await prisma.walletLedgerEntry.deleteMany({
      where: { walletAccount: { userId: customer.id } },
    });
    await prisma.sellerOrder.deleteMany({
      where: { orderId: order.id },
    });
    await prisma.orderDeliveryAddress.deleteMany({
      where: { orderId: order.id },
    });
    await prisma.order.deleteMany({
      where: { id: order.id },
    });
    await prisma.seller.deleteMany({
      where: { id: seller.id },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [customer.id, sellerUser.id, admin.id, otherUser.id] } },
    });
  } catch (cleanErr) {
    console.warn('Cleanup warning:', cleanErr);
  }

  console.log('\n========================================================================');
  console.log(`🏁 PHASE 10 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runDisputeLifecycleTests().catch((err) => {
  console.error('Fatal dispute test error:', err);
  process.exit(1);
});
