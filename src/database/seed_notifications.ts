import { prisma } from './prisma';
import { notificationTemplateService } from '../modules/notifications/services/notification-template.service';
import { AppType, NotificationCategory, NotificationPriority } from '../modules/notifications/notification.types';

export async function seedNotificationData() {
  console.log('🔔 Seeding Souqnaa Notification Platform data...');

  // 1. Seed all bilingual notification templates
  await notificationTemplateService.seedDefaultTemplates();

  // 2. Fetch seed users
  const adminUser = await prisma.user.findFirst({ where: { email: 'admin@souqnaa.online' } });
  const sellerUser = await prisma.user.findFirst({ where: { email: 'seller@souqnaa.online' } });
  const customerUser = await prisma.user.findFirst({ where: { email: 'customer@souqnaa.online' } });

  // 3. Seed user notification preferences
  const usersToSeed = [
    { user: adminUser, appType: AppType.ADMIN },
    { user: sellerUser, appType: AppType.SELLER },
    { user: customerUser, appType: AppType.CUSTOMER },
  ];

  for (const { user } of usersToSeed) {
    if (!user) continue;

    await prisma.notificationPreference.upsert({
      where: {
        userId_category: {
          userId: user.id,
          category: 'ALL',
        },
      },
      update: {
        pushEnabled: true,
        inAppEnabled: true,
        emailEnabled: true,
        smsEnabled: true,
        quietHoursEnabled: false,
        timezone: 'Asia/Riyadh',
      },
      create: {
        userId: user.id,
        category: 'ALL',
        pushEnabled: true,
        inAppEnabled: true,
        emailEnabled: true,
        smsEnabled: true,
        quietHoursEnabled: false,
        timezone: 'Asia/Riyadh',
      },
    });
  }

  // 4. Seed initial notifications for customer if none exist
  if (customerUser) {
    const existingCustomerNotif = await prisma.notification.findFirst({
      where: { userId: customerUser.id },
    });

    if (!existingCustomerNotif) {
      await prisma.notification.createMany({
        data: [
          {
            userId: customerUser.id,
            recipientType: AppType.CUSTOMER,
            category: NotificationCategory.ORDER,
            priority: NotificationPriority.HIGH,
            type: 'ORDER_STATUS',
            titleAr: 'مرحباً بك في سوقناا 🎉',
            titleEn: 'Welcome to SOUQNAA 🎉',
            bodyAr: 'استمتع بتجربة تسوق فريدة مع آلاف المنتجات والعروض الحصرية.',
            bodyEn: 'Enjoy a unique shopping experience with thousands of products and exclusive deals.',
            deepLink: 'souqnaa://home',
            channels: JSON.stringify(['PUSH', 'IN_APP']),
            status: 'DELIVERED',
            isRead: false,
          },
          {
            userId: customerUser.id,
            recipientType: AppType.CUSTOMER,
            category: NotificationCategory.REWARDS,
            priority: NotificationPriority.NORMAL,
            type: 'PROMOTION',
            titleAr: 'هدية التسجيل: 100 عملة سوقناا 🪙',
            titleEn: 'Signup Gift: 100 SOUQNAA Coins 🪙',
            bodyAr: 'تمت إضافة 100 عملة إلى محفظة مكافآتك! يمكنك استخدامها للحصول على خصم على مشترياتك.',
            bodyEn: '100 coins have been credited to your rewards wallet! Use them for discounts.',
            deepLink: 'souqnaa://rewards',
            channels: JSON.stringify(['PUSH', 'IN_APP']),
            status: 'DELIVERED',
            isRead: false,
          },
          {
            userId: customerUser.id,
            recipientType: AppType.CUSTOMER,
            category: NotificationCategory.FLASH_SALE,
            priority: NotificationPriority.NORMAL,
            type: 'PROMOTION',
            titleAr: 'انطلقت عروض الفلاش سيل الأسبوعية! ⚡',
            titleEn: 'Weekly Flash Sale is live! ⚡',
            bodyAr: 'خصومات تصل إلى 60% على أفضل المنتجات التقنية والأزياء لفترة محدودة.',
            bodyEn: 'Up to 60% off on top tech and fashion items for a limited time.',
            deepLink: 'souqnaa://flash-sales',
            channels: JSON.stringify(['PUSH', 'IN_APP']),
            status: 'DELIVERED',
            isRead: true,
          },
        ],
      });
    }
  }

  // 5. Seed initial notifications for seller if none exist
  if (sellerUser) {
    const existingSellerNotif = await prisma.notification.findFirst({
      where: { userId: sellerUser.id },
    });

    if (!existingSellerNotif) {
      await prisma.notification.createMany({
        data: [
          {
            userId: sellerUser.id,
            recipientType: AppType.SELLER,
            category: NotificationCategory.SYSTEM,
            priority: NotificationPriority.HIGH,
            type: 'SYSTEM',
            titleAr: 'مرحباً بك كشريك تاجر في سوقناا 🛍️',
            titleEn: 'Welcome as a Partner Seller on SOUQNAA 🛍️',
            bodyAr: 'متجرك جاهز لاستقبال الطلبات وإدارة المنتجات والمبيعات بكل سهولة.',
            bodyEn: 'Your store is ready to receive orders and manage inventory seamlessly.',
            deepLink: 'souqnaa://seller/dashboard',
            channels: JSON.stringify(['PUSH', 'IN_APP']),
            status: 'DELIVERED',
            isRead: false,
          },
          {
            userId: sellerUser.id,
            recipientType: AppType.SELLER,
            category: NotificationCategory.MEGA_CAMPAIGN,
            priority: NotificationPriority.NORMAL,
            type: 'PROMOTION',
            titleAr: 'فرصة للمشاركة في الحملة الموسمية الكبرى 🎪',
            titleEn: 'Opportunity to join the Mega Campaign 🎪',
            bodyAr: 'قدّم منتجاتك الآن للمشاركة في الحملة الترويجية القادمة لزيادة مبيعاتك بنسبة 200%.',
            bodyEn: 'Submit your products now to join the upcoming mega promotional campaign.',
            deepLink: 'souqnaa://seller/campaigns',
            channels: JSON.stringify(['PUSH', 'IN_APP']),
            status: 'DELIVERED',
            isRead: false,
          },
        ],
      });
    }
  }

  // 6. Seed initial notifications for admin if none exist
  if (adminUser) {
    const existingAdminNotif = await prisma.notification.findFirst({
      where: { userId: adminUser.id },
    });

    if (!existingAdminNotif) {
      await prisma.notification.createMany({
        data: [
          {
            userId: adminUser.id,
            recipientType: AppType.ADMIN,
            category: NotificationCategory.ADMIN,
            priority: NotificationPriority.HIGH,
            type: 'SYSTEM',
            titleAr: 'منصة إشعارات سوقناا جاهزة للعمل 🚀',
            titleEn: 'SOUQNAA Notification Platform is Live 🚀',
            bodyAr: 'تم تفعيل جميع قنوات الإرسال: الإشعارات الفورية، داخل التطبيق، البريد والرسائل النصية.',
            bodyEn: 'All delivery channels active: Push, In-App, Real-Time Socket, Email & SMS.',
            deepLink: 'souqnaa://admin/notifications',
            channels: JSON.stringify(['IN_APP', 'WEBSOCKET']),
            status: 'DELIVERED',
            isRead: false,
          },
        ],
      });
    }
  }

  console.log('✅ Souqnaa Notification Platform data seeded successfully.');
}
