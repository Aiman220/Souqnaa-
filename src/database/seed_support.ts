import { prisma } from './prisma';
import { SupportPriority, SupportAgentStatus } from '@prisma/client';

export async function seedSupportData() {
  console.log('Seeding Support Center configuration...');

  // 1. Departments
  const departmentsData = [
    {
      name: 'GENERAL_SUPPORT',
      nameAr: 'الدعم العام',
      nameEn: 'General Support',
      description: 'استفسارات عامة ومساعدة فورية لكافة المستخدمين',
      priority: 1,
      workingHours: '24/7',
      autoAssignmentEnabled: true,
    },
    {
      name: 'ORDERS',
      nameAr: 'الطلبات والتوصيل',
      nameEn: 'Orders & Delivery',
      description: 'متابعة شحن وتوصيل الطلبات وتأخير الشحنات',
      priority: 2,
      workingHours: '08:00 - 00:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'PAYMENTS',
      nameAr: 'المدفوعات والمحفظة',
      nameEn: 'Payments & Wallet',
      description: 'عمليات الدفع الإلكتروني، المحافظ والشحن',
      priority: 2,
      workingHours: '08:00 - 23:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'REFUNDS',
      nameAr: 'المرتجعات والنزاعات',
      nameEn: 'Refunds & Disputes',
      description: 'متابعة طلبات الإرجاع، الاستبدال والنزاعات',
      priority: 3,
      workingHours: '09:00 - 22:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'SELLER_SUPPORT',
      nameAr: 'دعم التجار والمتاجر',
      nameEn: 'Seller Support',
      description: 'مساعدة التجار في إدارة المتاجر، المنتجات والمبيعات',
      priority: 2,
      workingHours: '08:00 - 22:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'TECHNICAL_SUPPORT',
      nameAr: 'الدعم التقني والفني',
      nameEn: 'Technical Support',
      description: 'حل المشاكل الفنية والأعطال البرمجية في التطبيقات',
      priority: 2,
      workingHours: '09:00 - 23:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'FINANCE',
      nameAr: 'المالية والتسويات',
      nameEn: 'Finance & Settlements',
      description: 'تسويات مستحقات التجار، الفواتير والضرائب',
      priority: 3,
      workingHours: '09:00 - 18:00',
      autoAssignmentEnabled: true,
    },
    {
      name: 'ESCALATIONS',
      nameAr: 'فريق التصعيد والشكاوى',
      nameEn: 'Escalations Team',
      description: 'فريق إدارة الشكاوى المعقدة والحالات الحرجة',
      priority: 4,
      workingHours: '24/7',
      autoAssignmentEnabled: true,
    },
  ];

  const deptMap = new Map<string, string>();
  for (const d of departmentsData) {
    const upserted = await prisma.supportDepartment.upsert({
      where: { name: d.name },
      update: {
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        description: d.description,
        priority: d.priority,
        workingHours: d.workingHours,
        autoAssignmentEnabled: d.autoAssignmentEnabled,
        active: true,
      },
      create: d,
    });
    deptMap.set(d.name, upserted.id);
  }
  console.log(`✓ Seeded ${departmentsData.length} departments`);

  // 2. SLA Policies
  const slaPoliciesData = [
    {
      priority: SupportPriority.URGENT,
      firstResponseMinutes: 2,
      resolutionMinutes: 30,
      isActive: true,
    },
    {
      priority: SupportPriority.HIGH,
      firstResponseMinutes: 5,
      resolutionMinutes: 60,
      isActive: true,
    },
    {
      priority: SupportPriority.NORMAL,
      firstResponseMinutes: 15,
      resolutionMinutes: 120,
      isActive: true,
    },
    {
      priority: SupportPriority.LOW,
      firstResponseMinutes: 30,
      resolutionMinutes: 360,
      isActive: true,
    },
  ];

  for (const sla of slaPoliciesData) {
    await prisma.supportSlaPolicy.upsert({
      where: { priority: sla.priority },
      update: {
        firstResponseMinutes: sla.firstResponseMinutes,
        resolutionMinutes: sla.resolutionMinutes,
        isActive: sla.isActive,
      },
      create: sla,
    });
  }
  console.log(`✓ Seeded ${slaPoliciesData.length} SLA policies`);

  // 3. Categories
  const categoriesData = [
    // Customer categories
    {
      nameAr: 'مشكلة في طلب',
      nameEn: 'Order Issue',
      descriptionAr: 'استفسار أو مشكلة متعلقة بتفاصيل الطلب أو حالة الطلب',
      descriptionEn: 'Inquiry or issue related to order details or shipment status',
      requesterType: 'CUSTOMER',
      icon: 'shopping_bag',
      priority: SupportPriority.HIGH,
      deptName: 'ORDERS',
      sortOrder: 1,
    },
    {
      nameAr: 'المدفوعات والمحفظة',
      nameEn: 'Payment & Wallet',
      descriptionAr: 'مشاكل في الدفع، الخصم أو رصيد المحفظة',
      descriptionEn: 'Payment difficulties, charge issues or wallet balance questions',
      requesterType: 'CUSTOMER',
      icon: 'account_balance_wallet',
      priority: SupportPriority.HIGH,
      deptName: 'PAYMENTS',
      sortOrder: 2,
    },
    {
      nameAr: 'طلب استرجاع / استبدال',
      nameEn: 'Refund / Return',
      descriptionAr: 'إرجاع منتج، استبداله أو استرداد المبلغ',
      descriptionEn: 'Product return, exchange requests or refund processing',
      requesterType: 'CUSTOMER',
      icon: 'assignment_return',
      priority: SupportPriority.HIGH,
      deptName: 'REFUNDS',
      sortOrder: 3,
    },
    {
      nameAr: 'التوصيل والشحن',
      nameEn: 'Delivery',
      descriptionAr: 'تأخر التوصيل أو التواصل مع المندوب',
      descriptionEn: 'Delivery delays or courier contact issues',
      requesterType: 'CUSTOMER',
      icon: 'local_shipping',
      priority: SupportPriority.NORMAL,
      deptName: 'ORDERS',
      sortOrder: 4,
    },
    {
      nameAr: 'مشكلة في منتج',
      nameEn: 'Product Issue',
      descriptionAr: 'منتج تالف أو غير مطابق للوصف',
      descriptionEn: 'Damaged item or product not matching the description',
      requesterType: 'CUSTOMER',
      icon: 'inventory_2',
      priority: SupportPriority.NORMAL,
      deptName: 'ORDERS',
      sortOrder: 5,
    },
    {
      nameAr: 'شكوى بائع',
      nameEn: 'Seller Issue',
      descriptionAr: 'شكوى تخص متجر معين أو بائع',
      descriptionEn: 'Complaints regarding a specific merchant or seller behavior',
      requesterType: 'CUSTOMER',
      icon: 'storefront',
      priority: SupportPriority.NORMAL,
      deptName: 'GENERAL_SUPPORT',
      sortOrder: 6,
    },
    {
      nameAr: 'الحساب والملف الشخصي',
      nameEn: 'Account',
      descriptionAr: 'تعديل البيانات، رقم الهاتف أو مشاكل الدخول',
      descriptionEn: 'Profile updates, phone number changes or sign-in difficulties',
      requesterType: 'CUSTOMER',
      icon: 'person',
      priority: SupportPriority.LOW,
      deptName: 'GENERAL_SUPPORT',
      sortOrder: 7,
    },
    {
      nameAr: 'الكوبونات والعروض',
      nameEn: 'Coupons & Offers',
      descriptionAr: 'قسائم الخصم وعروض التخفيضات',
      descriptionEn: 'Voucher codes, promotion terms and discount campaigns',
      requesterType: 'CUSTOMER',
      icon: 'local_offer',
      priority: SupportPriority.LOW,
      deptName: 'GENERAL_SUPPORT',
      sortOrder: 8,
    },
    {
      nameAr: 'مشكلة فنية في التطبيق',
      nameEn: 'Technical Problem',
      descriptionAr: 'خلل برمجي، بطء أو خطأ غير متوقع في التطبيق',
      descriptionEn: 'App crashes, unexpected errors or technical glitches',
      requesterType: 'BOTH',
      icon: 'bug_report',
      priority: SupportPriority.NORMAL,
      deptName: 'TECHNICAL_SUPPORT',
      sortOrder: 9,
    },
    {
      nameAr: 'أخرى / استفسار عام',
      nameEn: 'Other',
      descriptionAr: 'استفسارات أخرى غير مدرجة',
      descriptionEn: 'General inquiries and unlisted questions',
      requesterType: 'BOTH',
      icon: 'help_outline',
      priority: SupportPriority.LOW,
      deptName: 'GENERAL_SUPPORT',
      sortOrder: 10,
    },

    // Seller categories
    {
      nameAr: 'حساب المتجر والتوثيق',
      nameEn: 'Seller Account & Verification',
      descriptionAr: 'توثيق الحساب التجاري، السجل والوثائق',
      descriptionEn: 'Commercial verification, documents and store account settings',
      requesterType: 'SELLER',
      icon: 'verified',
      priority: SupportPriority.HIGH,
      deptName: 'SELLER_SUPPORT',
      sortOrder: 11,
    },
    {
      nameAr: 'إدارة المنتجات والمخزون',
      nameEn: 'Product Management',
      descriptionAr: 'إضافة منتجات، تعديل الأسعار، ومشاكل المخزون',
      descriptionEn: 'Product catalog, pricing, variants and stock issues',
      requesterType: 'SELLER',
      icon: 'add_business',
      priority: SupportPriority.NORMAL,
      deptName: 'SELLER_SUPPORT',
      sortOrder: 12,
    },
    {
      nameAr: 'طلبات البيع والتجهيز',
      nameEn: 'Seller Orders',
      descriptionAr: 'تأكيد الطلبات، استلام المندوب والتجهيز',
      descriptionEn: 'Order confirmation, courier handoff and packaging',
      requesterType: 'SELLER',
      icon: 'receipt_long',
      priority: SupportPriority.HIGH,
      deptName: 'ORDERS',
      sortOrder: 13,
    },
    {
      nameAr: 'المحفظة والسحب المالي',
      nameEn: 'Seller Wallet & Payouts',
      descriptionAr: 'طلب سحب الأرباح، رصيد المتجر والتحويلات البنكية',
      descriptionEn: 'Payout requests, earnings balance and bank transfers',
      requesterType: 'SELLER',
      icon: 'payments',
      priority: SupportPriority.HIGH,
      deptName: 'FINANCE',
      sortOrder: 14,
    },
    {
      nameAr: 'العمولات والرسوم',
      nameEn: 'Commissions & Fees',
      descriptionAr: 'نسبة العمولة ورسوم العمليات',
      descriptionEn: 'Marketplace commission rates and transaction fees',
      requesterType: 'SELLER',
      icon: 'percent',
      priority: SupportPriority.NORMAL,
      deptName: 'FINANCE',
      sortOrder: 15,
    },
    {
      nameAr: 'طلبات استرجاع العملاء',
      nameEn: 'Customer Returns & Disputes',
      descriptionAr: 'نزاعات الإرجاع مع العملاء والقرارات الإدارية',
      descriptionEn: 'Customer return disputes, inspections and admin arbitration',
      requesterType: 'SELLER',
      icon: 'swap_horiz',
      priority: SupportPriority.HIGH,
      deptName: 'REFUNDS',
      sortOrder: 16,
    },
  ];

  for (const cat of categoriesData) {
    const deptId = cat.deptName ? deptMap.get(cat.deptName) : null;
    const existing = await prisma.supportCategory.findFirst({
      where: { nameAr: cat.nameAr },
    });
    if (existing) {
      await prisma.supportCategory.update({
        where: { id: existing.id },
        data: {
          nameEn: cat.nameEn,
          descriptionAr: cat.descriptionAr,
          descriptionEn: cat.descriptionEn,
          requesterType: cat.requesterType,
          icon: cat.icon,
          priority: cat.priority,
          departmentId: deptId || undefined,
          sortOrder: cat.sortOrder,
          active: true,
        },
      });
    } else {
      await prisma.supportCategory.create({
        data: {
          nameAr: cat.nameAr,
          nameEn: cat.nameEn,
          descriptionAr: cat.descriptionAr,
          descriptionEn: cat.descriptionEn,
          requesterType: cat.requesterType,
          icon: cat.icon,
          priority: cat.priority,
          departmentId: deptId || undefined,
          sortOrder: cat.sortOrder,
          active: true,
        },
      });
    }
  }
  console.log(`✓ Seeded ${categoriesData.length} support categories`);

  // 4. Quick Replies
  const quickRepliesData = [
    {
      title: 'Instant Welcome',
      titleAr: 'ترحيب فوري',
      message: 'Welcome to Souqnaa! I am here to help you, how can I assist you today?',
      messageAr: 'مرحباً بك في سوقناا! أنا هنا لمساعدتك، كيف يمكنني خدمتك اليوم؟',
    },
    {
      title: 'Checking Order Details',
      titleAr: 'مراجعة بيانات الطلب',
      message: 'We are reviewing your order details with the team, please give us a moment...',
      messageAr: 'جاري فحص تفاصيل طلبك مع الفريق المختص، يرجى الانتظار لحظات...',
    },
    {
      title: 'Request Images / Evidence',
      titleAr: 'طلب صور أو إثبات',
      message: 'Could you please share a photo or video showing the issue so we can help faster?',
      messageAr: 'هل يمكنك تزويدنا بصورة أو فيديو يوضح المشكلة حتى نتمكن من مساعدتك بأسرع شكل؟',
    },
    {
      title: 'Transfer to Refunds Team',
      titleAr: 'تحويل لقسم المرتجعات',
      message: 'Your inquiry has been transferred to our Refunds & Disputes department for follow-up.',
      messageAr: 'تم تحويل استفسارك لقسم المرتجعات والنزاعات لمتابعته بدقة، وسنرد عليك في أقرب وقت.',
    },
    {
      title: 'Resolved Successfully',
      titleAr: 'إغلاق وحل بنجاح',
      message: 'We are delighted that your issue is resolved! Feel free to reach out anytime. Happy shopping!',
      messageAr: 'يسعدنا أن المشكلة تم حلها بنجاح! إذا كان لديك أي استفسار آخر لا تتردد بالتواصل معنا. نتمنى لك تجربة تسوق ممتعة!',
    },
  ];

  const generalDeptId = deptMap.get('GENERAL_SUPPORT');
  for (const qr of quickRepliesData) {
    const existing = await prisma.supportQuickReply.findFirst({
      where: {
        OR: [{ title: qr.title }, { titleAr: qr.titleAr }],
      },
    });
    if (!existing) {
      await prisma.supportQuickReply.create({
        data: {
          departmentId: generalDeptId || undefined,
          title: qr.title,
          titleAr: qr.titleAr,
          message: qr.message,
          messageAr: qr.messageAr,
          active: true,
        },
      });
    } else {
      await prisma.supportQuickReply.update({
        where: { id: existing.id },
        data: {
          departmentId: generalDeptId || undefined,
          title: qr.title,
          titleAr: qr.titleAr,
          message: qr.message,
          messageAr: qr.messageAr,
          active: true,
        },
      });
    }
  }
  console.log(`✓ Seeded ${quickRepliesData.length} quick replies`);

  // 5. Check for Admin Users and create / update Support Agent profiles
  const adminUsers = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    take: 5,
  });

  const allDeptIds = Array.from(deptMap.values());
  for (const admin of adminUsers) {
    let agent = await prisma.supportAgent.findUnique({
      where: { adminUserId: admin.id },
    });

    const displayName = `${admin.firstName} ${admin.lastName}`.trim() || 'مدير الدعم';

    if (!agent) {
      agent = await prisma.supportAgent.create({
        data: {
          adminUserId: admin.id,
          displayName,
          avatar: admin.avatar,
          active: true,
          online: true,
          status: SupportAgentStatus.ONLINE,
          maxConcurrentChats: 10,
          currentActiveChats: 0,
        },
      });
      console.log(`✓ Created Support Agent for Admin: ${agent.displayName} (${agent.id})`);
    } else {
      agent = await prisma.supportAgent.update({
        where: { id: agent.id },
        data: {
          displayName,
          active: true,
          online: true,
          status: SupportAgentStatus.ONLINE,
        },
      });
    }

    // Attach to departments
    for (const dId of allDeptIds) {
      await prisma.supportAgentDepartment.upsert({
        where: { agentId_departmentId: { agentId: agent.id, departmentId: dId } },
        update: {},
        create: { agentId: agent.id, departmentId: dId },
      });
    }
  }

  // 6. Seed Comprehensive FAQs across multiple categories
  const faqDataByCat = [
    {
      categoryNameAr: 'طلب استرجاع / استبدال',
      faqs: [
        {
          questionAr: 'كم يستغرق إرجاع المبلغ بعد الموافقة على الاسترجاع؟',
          questionEn: 'How long does refund take after approval?',
          answerAr: 'يتم إيداع المبلغ في محفظتك الإلكترونية على الفور، أو خلال 3-5 أيام عمل عند الإرجاع للبطاقة البنكية.',
          answerEn: 'Refund is processed immediately to your wallet, or within 3-5 business days to card.',
        },
        {
          questionAr: 'ما هي شروط قبول إرجاع المنتج؟',
          questionEn: 'What are the return conditions?',
          answerAr: 'يجب أن يكون المنتج بحالته الأصلية، غير مستخدم، وبكامل ملحقاته وتغليفه الأصلي خلال 14 يوماً من الاستلام.',
          answerEn: 'Product must be in its original unused condition with all accessories within 14 days.',
        },
      ],
    },
    {
      categoryNameAr: 'مشكلة في طلب',
      faqs: [
        {
          questionAr: 'كيف يمكنني تعديل عنوان التوصيل بعد إتمام الطلب؟',
          questionEn: 'How can I change the delivery address after ordering?',
          answerAr: 'إذا كان الطلب قيد المراجعة يمكنك تعديله من صفحة تفاصيل الطلب، أو التواصل مع الدعم الفني مباشرة قبل خروج الشحنة.',
          answerEn: 'If the order is under review, you can modify it from the order details screen or contact support before dispatch.',
        },
        {
          questionAr: 'كيف أقوم بإلغاء طلبي؟',
          questionEn: 'How do I cancel my order?',
          answerAr: 'يمكنك طلب الإلغاء مباشرة من تطبيق العميل طالما لم يتم شحن الطلب بعد من قبل التاجر.',
          answerEn: 'You can request cancellation directly from the app as long as the merchant has not dispatched it yet.',
        },
      ],
    },
    {
      categoryNameAr: 'التوصيل والشحن',
      faqs: [
        {
          questionAr: 'ما هي المدة المتوقعة لتوصيل الطلب؟',
          questionEn: 'What is the estimated delivery time?',
          answerAr: 'التوصيل داخل نفس المدينة يستغرق من 24 إلى 48 ساعة، وللمدن الأخرى من 2 إلى 4 أيام عمل.',
          answerEn: 'Same-city delivery takes 24-48 hours, while other cities take 2-4 business days.',
        },
      ],
    },
    {
      categoryNameAr: 'المحفظة والسحب المالي',
      faqs: [
        {
          questionAr: 'متى يتم تحويل مستحقات مبيعات المتجر؟',
          questionEn: 'When are store sales earnings transferred?',
          answerAr: 'تتم التسويات المالية أسبوعياً أو عند طلب سحب الرصيد المتاح لحسابك البنكي المعتمد خلال 48 ساعة عمل.',
          answerEn: 'Financial settlements occur weekly or within 48 business hours upon submitting a payout request.',
        },
      ],
    },
  ];

  for (const group of faqDataByCat) {
    const category = await prisma.supportCategory.findFirst({
      where: { nameAr: group.categoryNameAr },
    });
    if (category) {
      for (const f of group.faqs) {
        const ex = await prisma.supportFaq.findFirst({
          where: { questionAr: f.questionAr },
        });
        if (!ex) {
          await prisma.supportFaq.create({
            data: {
              categoryId: category.id,
              questionAr: f.questionAr,
              questionEn: f.questionEn,
              answerAr: f.answerAr,
              answerEn: f.answerEn,
              active: true,
            },
          });
        } else {
          await prisma.supportFaq.update({
            where: { id: ex.id },
            data: {
              categoryId: category.id,
              questionAr: f.questionAr,
              questionEn: f.questionEn,
              answerAr: f.answerAr,
              answerEn: f.answerEn,
              active: true,
            },
          });
        }
      }
    }
  }

  console.log('Support Center seeding completed successfully!');
}

if (require.main === module) {
  seedSupportData()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
