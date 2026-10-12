import { prisma } from '../../../database/prisma';
import { DevicePlatform, AppType } from '../notification.types';

export class NotificationTokenService {
  private static instance: NotificationTokenService;

  static get(): NotificationTokenService {
    if (!NotificationTokenService.instance) {
      NotificationTokenService.instance = new NotificationTokenService();
    }
    return NotificationTokenService.instance;
  }

  /**
   * Registers or refreshes a device token.
   */
  async registerDevice(params: {
    userId: string;
    deviceId: string;
    deviceToken: string;
    platform: DevicePlatform | string;
    appType?: AppType | string;
    pushProvider?: string;
    browserInfo?: string;
    appVersion?: string;
    locale?: string;
    timezone?: string;
    permissionStatus?: string;
  }) {
    const {
      userId,
      deviceId,
      deviceToken,
      platform,
      appType = AppType.CUSTOMER,
      pushProvider = 'FCM',
      browserInfo,
      appVersion,
      locale = 'ar',
      timezone = 'Asia/Riyadh',
      permissionStatus = 'GRANTED',
    } = params;

    // 1. Upsert canonical NotificationDevice
    const device = await prisma.notificationDevice.upsert({
      where: {
        userId_deviceId_appType: {
          userId,
          deviceId,
          appType,
        },
      },
      update: {
        deviceToken,
        platform,
        pushProvider,
        browserInfo,
        appVersion,
        locale,
        timezone,
        permissionStatus,
        lastSeenAt: new Date(),
        lastTokenRefreshAt: new Date(),
        isActive: true,
      },
      create: {
        userId,
        deviceId,
        deviceToken,
        platform,
        appType,
        pushProvider,
        browserInfo,
        appVersion,
        locale,
        timezone,
        permissionStatus,
        lastSeenAt: new Date(),
        lastTokenRefreshAt: new Date(),
        isActive: true,
      },
    });

    // 2. Synchronize legacy NotificationToken table for backward compatibility
    try {
      await prisma.notificationToken.upsert({
        where: { fcmToken: deviceToken },
        update: {
          userId,
          device: platform.toLowerCase(),
        },
        create: {
          userId,
          fcmToken: deviceToken,
          device: platform.toLowerCase(),
        },
      });
    } catch (_) {}

    return device;
  }

  /**
   * Get all active devices for a user.
   */
  async getActiveDevices(userId: string, appType?: AppType | string) {
    const where: any = {
      userId,
      isActive: true,
    };
    if (appType) {
      where.appType = appType;
    }

    return prisma.notificationDevice.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Heartbeat to keep device active & update last seen.
   */
  async touchDevice(userId: string, deviceId: string) {
    try {
      await prisma.notificationDevice.updateMany({
        where: { userId, deviceId },
        data: { lastSeenAt: new Date(), isActive: true },
      });
    } catch (_) {}
  }

  /**
   * Mark token as invalid when push transport reports NOT_REGISTERED or UNREGISTERED.
   */
  async markTokenInactive(deviceToken: string) {
    try {
      await prisma.notificationDevice.updateMany({
        where: { deviceToken },
        data: { isActive: false },
      });
      await prisma.notificationToken.deleteMany({
        where: { fcmToken: deviceToken },
      });
    } catch (_) {}
  }

  /**
   * Deactivate device upon user logout.
   */
  async deactivateDevice(userId: string, deviceId: string) {
    try {
      await prisma.notificationDevice.updateMany({
        where: { userId, deviceId },
        data: { isActive: false },
      });
    } catch (_) {}
  }
}

export const notificationTokenService = NotificationTokenService.get();
