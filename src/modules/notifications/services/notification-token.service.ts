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

    // 2. Deactivate any previous records on this device token (ensures 1 active user per physical device/token)
    if (deviceToken && !deviceToken.startsWith('local_')) {
      try {
        await prisma.notificationDevice.updateMany({
          where: {
            deviceToken,
            appType,
            id: { not: device.id },
            isActive: true,
          },
          data: {
            isActive: false,
          },
        });
      } catch (_) {}
    }

    // 3. Synchronize legacy NotificationToken table for backward compatibility
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
   * Guarantees each physical device token is returned at most once.
   */
  async getActiveDevices(userId: string, appType?: AppType | string) {
    const where: any = {
      userId,
      isActive: true,
    };
    if (appType) {
      where.appType = appType;
    }

    const devices = await prisma.notificationDevice.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
    });

    const seenTokens = new Set<string>();
    const uniqueDevices: typeof devices = [];

    for (const d of devices) {
      const token = d.deviceToken;
      if (token && !seenTokens.has(token)) {
        seenTokens.add(token);
        uniqueDevices.push(d);
      }
    }

    return uniqueDevices;
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
