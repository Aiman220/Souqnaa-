import { prisma } from '../src/database/prisma';
import { SupportService } from '../src/modules/support/support.service';
import {
  SupportRequesterType,
  SupportPriority,
  SupportConversationStatus,
} from '@prisma/client';

async function runSupportTestSuite() {
  console.log('====================================================');
  console.log('🧪 RUNNING PRODUCTION SUPPORT CHAT CENTER TEST SUITE');
  console.log('====================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failedTests++;
    }
  }

  try {
    // 1. Find or create test customer, seller, and agent
    let customerUser = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
    if (!customerUser) {
      customerUser = await prisma.user.create({
        data: {
          email: 'test.customer@souqnaa.com',
          firstName: 'عميل',
          lastName: 'اختباري',
          role: 'CUSTOMER',
          passwordHash: 'dummy',
        },
      });
    }

    let sellerUser = await prisma.user.findFirst({ where: { role: 'SELLER' } });
    if (!sellerUser) {
      sellerUser = await prisma.user.create({
        data: {
          email: 'test.seller@souqnaa.com',
          firstName: 'بائع',
          lastName: 'اختباري',
          role: 'SELLER',
          passwordHash: 'dummy',
        },
      });
    }

    let adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!adminUser) {
      adminUser = await prisma.user.create({
        data: {
          email: 'test.admin@souqnaa.com',
          firstName: 'مشرف',
          lastName: 'الدعم',
          role: 'ADMIN',
          passwordHash: 'dummy',
        },
      });
    }

    // Departments & Categories
    const department = await prisma.supportDepartment.findFirst();
    const category = await prisma.supportCategory.findFirst();

    // Ensure agent exists
    let agent = await prisma.supportAgent.findUnique({ where: { adminUserId: adminUser.id } });
    if (!agent) {
      agent = await prisma.supportAgent.create({
        data: {
          adminUserId: adminUser.id,
          displayName: 'وكيل الدعم أحمد',
          online: true,
          status: 'ONLINE',
          maxConcurrentChats: 5,
          currentActiveChats: 0,
        },
      });
    }

    console.log('1. Customer creates support ticket');
    const customerConv = await SupportService.createConversation({
      requesterType: SupportRequesterType.CUSTOMER,
      requesterId: customerUser.id,
      subject: 'استفسار عن شحنة متأخرة',
      categoryId: category?.id,
      departmentId: department?.id,
      priority: SupportPriority.URGENT,
      initialMessage: 'مرحباً، طلبي لم يصل حتى الآن وأحتاج مساعدة سريعة.',
    });

    assert(customerConv != null, 'Customer conversation created');
    assert(customerConv.ticketNumber != null, 'Support ticket generated');
    assert(customerConv.ticketNumber.startsWith('SUP-'), `Ticket number follows format SUP-YYYY-XXXXXX (${customerConv.ticketNumber})`);
    assert(customerConv.firstResponseDueAt != null, 'SLA first response deadline calculated');
    assert(customerConv.resolutionDueAt != null, 'SLA resolution deadline calculated');

    console.log('\n2. Seller creates support ticket');
    const sellerConv = await SupportService.createConversation({
      requesterType: SupportRequesterType.SELLER,
      requesterId: sellerUser.id,
      subject: 'طلب تسوية المستحقات الأسبوعية',
      categoryId: category?.id,
      departmentId: department?.id,
      priority: SupportPriority.HIGH,
      initialMessage: 'نود مراجعة مستحقات المتجر لدفعة هذا الأسبوع.',
    });

    assert(sellerConv != null, 'Seller conversation created');
    assert(sellerConv.requesterType === SupportRequesterType.SELLER, 'Requester type marked as SELLER');

    console.log('\n3. Queue & Claim Operations');
    // Release customerConv to QUEUED to test explicit manual claim
    await SupportService.releaseConversation(customerConv.conversationId, adminUser.id);
    const queuedConv = await prisma.supportConversation.findUnique({
      where: { conversationId: customerConv.conversationId },
    });
    assert(queuedConv?.status === SupportConversationStatus.QUEUED, 'Conversation successfully released back to QUEUED');

    // Agent claims conversation
    const claimed = await SupportService.claimConversation(customerConv.conversationId, adminUser.id);
    assert(claimed.status === SupportConversationStatus.IN_PROGRESS, 'Conversation assigned to agent via claim');
    assert(claimed.agentId === agent.id, 'Assigned agent matches');

    // Concurrency Safety: Another agent attempting to claim the same conversation must be rejected with 409
    let duplicateClaimBlocked = false;
    let adminUser2 = await prisma.user.findFirst({ where: { role: 'ADMIN', id: { not: adminUser.id } } });
    if (!adminUser2) {
      adminUser2 = await prisma.user.create({
        data: {
          email: 'test.admin2@souqnaa.com',
          firstName: 'وكيل',
          lastName: 'ثاني',
          role: 'ADMIN',
          passwordHash: 'dummy',
        },
      });
    }
    let agent2 = await prisma.supportAgent.findUnique({ where: { adminUserId: adminUser2.id } });
    if (!agent2) {
      agent2 = await prisma.supportAgent.create({
        data: {
          adminUserId: adminUser2.id,
          displayName: 'وكيل الدعم الثاني',
          online: true,
          status: 'ONLINE',
          maxConcurrentChats: 5,
          currentActiveChats: 0,
        },
      });
    }
    try {
      await SupportService.claimConversation(customerConv.conversationId, adminUser2.id);
    } catch (e: any) {
      if (e.statusCode === 409) {
        duplicateClaimBlocked = true;
      }
    }
    assert(duplicateClaimBlocked, 'Multi-agent race condition prevented: Second agent claim blocked with 409 Conflict');

    // Agent capacity update check
    const updatedAgent = await prisma.supportAgent.findUnique({ where: { id: agent.id } });
    assert((updatedAgent?.currentActiveChats ?? 0) >= 1, `Agent active chats counter incremented (${updatedAgent?.currentActiveChats})`);

    console.log('\n4. Transfer between departments / agents');
    const transferred = await SupportService.transferConversation(
      customerConv.conversationId,
      adminUser.id,
      undefined,
      department?.id,
      'تحويل للقسم المختص بمتابعة الشحنات اللوجستية'
    );
    assert(transferred != null, 'Conversation transferred');
    const transferLog = await prisma.supportConversationTransfer.findFirst({
      where: { conversationId: customerConv.id },
    });
    assert(transferLog != null, 'Audit log created for conversation transfer');

    console.log('\n5. Escalation');
    const escalated = await SupportService.escalateConversation(
      customerConv.conversationId,
      adminUser.id,
      'طلب العميل التحدث مع المشرف المسؤول مباشرة'
    );
    assert(escalated.status === SupportConversationStatus.ESCALATED, 'Conversation status escalated');
    assert(escalated.escalatedAt != null, 'Escalated timestamp recorded');

    console.log('\n6. Messaging & Internal Notes Privacy Isolation');
    // Agent sends customer-visible message
    const publicMsg = await SupportService.sendMessage(
      customerConv.conversationId,
      adminUser.id,
      'ADMIN',
      'أهلاً بك، نحن نتابع الشحنة مع شركة التوصيل الآن.',
      undefined,
      'text',
      undefined,
      false
    );
    assert(publicMsg != null && !publicMsg.isInternal, 'Public agent message created');

    // Agent posts private internal note
    const noteMsg = await SupportService.sendMessage(
      customerConv.conversationId,
      adminUser.id,
      'ADMIN',
      'ملاحظة داخلية للمشرفين: العميل عميل مميز وله أكثر من 20 طلب سابق.',
      undefined,
      'text',
      undefined,
      true
    );
    assert(noteMsg != null && noteMsg.isInternal, 'Internal note created with isInternal=true');

    // Customer message fetch must strictly hide internal notes
    const customerVisibleMessages = await SupportService.getMessages(
      customerConv.conversationId,
      customerUser.id
    );
    const containsInternal = customerVisibleMessages.some((m: any) => m.isInternal);
    assert(!containsInternal, 'Customer CANNOT view internal staff notes (Security & Isolation enforced)');

    // Admin message fetch shows all notes
    const adminVisibleMessages = await SupportService.getMessages(
      customerConv.conversationId,
      adminUser.id
    );
    const adminHasNotes = adminVisibleMessages.some((m: any) => m.isInternal);
    assert(adminHasNotes, 'Authorized admin CAN view internal notes in workspace');

    console.log('\n7. Resolution & Support Rating');
    const resolved = await SupportService.resolveConversation(customerConv.conversationId, adminUser.id);
    assert(resolved.status === SupportConversationStatus.RESOLVED, 'Conversation marked as RESOLVED');

    // Customer rates the experience (1-5 stars)
    const rating = await SupportService.rateConversation(
      customerConv.conversationId,
      customerUser.id,
      5,
      'خدمة سريعة وممتازة شكراً لكم!'
    );
    assert(rating != null && rating.rating === 5, 'Customer 5-star rating recorded');

    console.log('\n8. Closing & Reopening');
    const closed = await SupportService.closeConversation(customerConv.conversationId, adminUser.id);
    assert(closed.status === SupportConversationStatus.CLOSED, 'Conversation closed');

    const reopened = await SupportService.reopenConversation(customerConv.conversationId, customerUser.id);
    assert(reopened.status === SupportConversationStatus.OPEN || reopened.status === SupportConversationStatus.QUEUED, 'Conversation reopened');

    console.log('\n9. Analytics & Queue Counters');
    const analytics = await SupportService.getQueueAnalytics();
    assert(analytics != null && typeof analytics.totalOpen === 'number', 'Queue analytics calculated from live database');
    assert(analytics.averageRating >= 1.0, `Average satisfaction rating computed (${analytics.averageRating.toFixed(2)})`);

    console.log('\n====================================================');
    console.log(`🎉 TEST SUITE SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('====================================================');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('💥 Unhandled error in test suite:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runSupportTestSuite();
