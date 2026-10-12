import { prisma } from '../../../database/prisma';

export class NotificationAnalyticsService {
  private static instance: NotificationAnalyticsService;

  static get(): NotificationAnalyticsService {
    if (!NotificationAnalyticsService.instance) {
      NotificationAnalyticsService.instance = new NotificationAnalyticsService();
    }
    return NotificationAnalyticsService.instance;
  }

  /**
   * High-level overview statistics for Admin Notification Dashboard.
   */
  async getOverviewStats() {
    const [
      totalNotifications,
      totalUnread,
      totalDeliveries,
      failedDeliveries,
      activeDevices,
      totalCampaigns,
    ] = await Promise.all([
      prisma.notification.count(),
      prisma.notification.count({ where: { isRead: false } }),
      prisma.notificationDelivery.count(),
      prisma.notificationDelivery.count({ where: { status: 'FAILED' } }),
      prisma.notificationDevice.count({ where: { isActive: true } }),
      prisma.broadcastCampaign.count(),
    ]);

    // Active devices by platform breakdown
    const devicesByPlatform = await prisma.notificationDevice.groupBy({
      by: ['platform'],
      where: { isActive: true },
      _count: { id: true },
    });

    // Deliveries by channel breakdown
    const deliveriesByChannel = await prisma.notificationDelivery.groupBy({
      by: ['channel'],
      _count: { id: true },
    });

    const deliverySuccessRate =
      totalDeliveries > 0
        ? Math.round(((totalDeliveries - failedDeliveries) / totalDeliveries) * 100)
        : 100;

    return {
      totalNotifications,
      totalUnread,
      totalDeliveries,
      failedDeliveries,
      deliverySuccessRate,
      activeDevices,
      totalCampaigns,
      devicesByPlatform: devicesByPlatform.map((d) => ({
        platform: d.platform,
        count: d._count.id,
      })),
      deliveriesByChannel: deliveriesByChannel.map((c) => ({
        channel: c.channel,
        count: c._count.id,
      })),
    };
  }

  /**
   * Audience Preview before sending broadcast:
   * Shows estimated recipients, Push, Email, SMS enabled counts.
   */
  async getAudiencePreview(target: string) {
    let roleFilter: any = {};
    if (target === 'CUSTOMERS') roleFilter = { role: 'CUSTOMER' };
    if (target === 'SELLERS') roleFilter = { role: 'SELLER' };

    const [totalUsers, pushDevices, activeSellers, activeCustomers] = await Promise.all([
      prisma.user.count({ where: roleFilter }),
      prisma.notificationDevice.count({
        where: {
          isActive: true,
          user: roleFilter,
        },
      }),
      prisma.user.count({ where: { role: 'SELLER' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
    ]);

    return {
      estimatedRecipients: totalUsers,
      pushEnabledUsers: pushDevices,
      emailEnabledUsers: totalUsers,
      smsEnabledUsers: Math.min(totalUsers, 100), // SMS policy cap
      breakdown: {
        customers: activeCustomers,
        sellers: activeSellers,
      },
    };
  }

  /**
   * DLQ / Failed notifications inspector
   */
  async getFailedDeliveries(limit = 50) {
    return prisma.notificationDelivery.findMany({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        notification: {
          select: {
            titleAr: true,
            titleEn: true,
            category: true,
            createdAt: true,
          },
        },
      },
    });
  }

  /**
   * Delivery logs
   */
  async getDeliveryLogs(limit = 100) {
    return prisma.notificationDelivery.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        notification: {
          select: {
            titleAr: true,
            titleEn: true,
            category: true,
          },
        },
      },
    });
  }
}

export const notificationAnalyticsService = NotificationAnalyticsService.get();
