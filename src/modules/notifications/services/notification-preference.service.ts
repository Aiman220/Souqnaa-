import { prisma } from '../../../database/prisma';
import {
  NotificationCategory,
  NotificationChannel,
  DomainNotificationEvent,
} from '../notification.types';

export interface UserPreferencesMap {
  [category: string]: {
    pushEnabled: boolean;
    emailEnabled: boolean;
    smsEnabled: boolean;
    inAppEnabled: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    timezone?: string;
  };
}

export class NotificationPreferenceService {
  private static instance: NotificationPreferenceService;

  static get(): NotificationPreferenceService {
    if (!NotificationPreferenceService.instance) {
      NotificationPreferenceService.instance = new NotificationPreferenceService();
    }
    return NotificationPreferenceService.instance;
  }

  /**
   * Non-modifiable categories where policy forbids user from opting out.
   */
  private mandatoryCategories: Set<string> = new Set([
    NotificationCategory.SECURITY,
    NotificationCategory.SYSTEM,
  ]);

  /**
   * Get all preferences for a user, filling in defaults for any missing category.
   */
  async getUserPreferences(userId: string): Promise<UserPreferencesMap> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const userRole = user?.role || 'CUSTOMER';

    const records = await prisma.notificationPreference.findMany({
      where: { userId },
    });

    const map: UserPreferencesMap = {};
    for (const r of records) {
      if (userRole === 'CUSTOMER' && (r.category === NotificationCategory.ADMIN || r.category === NotificationCategory.SELLER)) {
        continue;
      }
      if (userRole === 'SELLER' && r.category === NotificationCategory.ADMIN) {
        continue;
      }

      map[r.category] = {
        pushEnabled: r.pushEnabled,
        emailEnabled: r.emailEnabled,
        smsEnabled: r.smsEnabled,
        inAppEnabled: r.inAppEnabled,
        quietHoursEnabled: r.quietHoursEnabled,
        quietHoursStart: r.quietHoursStart || '22:00',
        quietHoursEnd: r.quietHoursEnd || '08:00',
        timezone: r.timezone || 'Asia/Riyadh',
      };
    }

    // Default for categories not yet saved
    const allCategories = Object.values(NotificationCategory);
    for (const cat of allCategories) {
      if (userRole === 'CUSTOMER' && (cat === NotificationCategory.ADMIN || cat === NotificationCategory.SELLER)) {
        continue;
      }
      if (userRole === 'SELLER' && cat === NotificationCategory.ADMIN) {
        continue;
      }

      if (!map[cat]) {
        const isMarketing =
          cat === NotificationCategory.PROMOTION ||
          cat === NotificationCategory.FLASH_SALE ||
          cat === NotificationCategory.MEGA_CAMPAIGN ||
          cat === NotificationCategory.CART_ABANDONMENT;

        map[cat] = {
          pushEnabled: true,
          emailEnabled: !isMarketing, // Email off by default for high-volume marketing
          smsEnabled: false, // SMS off by default to conserve cost
          inAppEnabled: true,
          quietHoursEnabled: isMarketing, // Marketing respects quiet hours by default
          quietHoursStart: '22:00',
          quietHoursEnd: '08:00',
          timezone: 'Asia/Riyadh',
        };
      }
    }

    return map;
  }

  /**
   * Update preferences for a user for a specific category.
   */
  async updateCategoryPreference(
    userId: string,
    category: NotificationCategory,
    data: {
      pushEnabled?: boolean;
      emailEnabled?: boolean;
      smsEnabled?: boolean;
      inAppEnabled?: boolean;
      quietHoursEnabled?: boolean;
      quietHoursStart?: string;
      quietHoursEnd?: string;
      timezone?: string;
    }
  ) {
    // If mandatory, push & in-app cannot be disabled
    if (this.mandatoryCategories.has(category)) {
      if (data.pushEnabled === false) data.pushEnabled = true;
      if (data.inAppEnabled === false) data.inAppEnabled = true;
    }

    return prisma.notificationPreference.upsert({
      where: {
        userId_category: {
          userId,
          category,
        },
      },
      update: {
        ...data,
      },
      create: {
        userId,
        category,
        pushEnabled: data.pushEnabled ?? true,
        emailEnabled: data.emailEnabled ?? true,
        smsEnabled: data.smsEnabled ?? false,
        inAppEnabled: data.inAppEnabled ?? true,
        quietHoursEnabled: data.quietHoursEnabled ?? false,
        quietHoursStart: data.quietHoursStart || '22:00',
        quietHoursEnd: data.quietHoursEnd || '08:00',
        timezone: data.timezone || 'Asia/Riyadh',
      },
    });
  }

  /**
   * Evaluates which channels are allowed for an event based on user preferences and quiet hours.
   */
  async evaluateAllowedChannels(
    event: DomainNotificationEvent
  ): Promise<{
    allowedChannels: NotificationChannel[];
    suppressedChannels: NotificationChannel[];
    isQuietHoursSuppressed: boolean;
  }> {
    const preferences = await this.getUserPreferences(event.recipientId);
    const catPref = preferences[event.category] || {
      pushEnabled: true,
      emailEnabled: true,
      smsEnabled: false,
      inAppEnabled: true,
      quietHoursEnabled: false,
    };

    const isMandatory = this.mandatoryCategories.has(event.category);
    const isQuiet = !event.bypassQuietHours && this.isQuietHoursActive(catPref);

    const allowedChannels: NotificationChannel[] = [];
    const suppressedChannels: NotificationChannel[] = [];

    // In-App is always recorded so user can see it in Notification Center
    allowedChannels.push(NotificationChannel.IN_APP);

    // Real-Time WebSocket
    allowedChannels.push(NotificationChannel.REAL_TIME);

    // Push Notification
    if (isMandatory || (catPref.pushEnabled && !isQuiet)) {
      allowedChannels.push(NotificationChannel.PUSH);
    } else {
      suppressedChannels.push(NotificationChannel.PUSH);
    }

    // Email
    if (isMandatory || (catPref.emailEnabled && !isQuiet)) {
      allowedChannels.push(NotificationChannel.EMAIL);
    } else {
      suppressedChannels.push(NotificationChannel.EMAIL);
    }

    // SMS (Strict policy: only if enabled and non-marketing, or explicit urgent event)
    if (catPref.smsEnabled && !isQuiet && event.priority === 'URGENT') {
      allowedChannels.push(NotificationChannel.SMS);
    } else {
      suppressedChannels.push(NotificationChannel.SMS);
    }

    // If event specifies channel overrides (e.g. admin test send), respect them
    if (event.channelsOverride && event.channelsOverride.length > 0) {
      return {
        allowedChannels: event.channelsOverride,
        suppressedChannels,
        isQuietHoursSuppressed: false,
      };
    }

    return {
      allowedChannels,
      suppressedChannels,
      isQuietHoursSuppressed: isQuiet,
    };
  }

  /**
   * Check if current time falls within user's quiet hours.
   */
  private isQuietHoursActive(pref: {
    quietHoursEnabled: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    timezone?: string;
  }): boolean {
    if (!pref.quietHoursEnabled) return false;

    try {
      const tz = pref.timezone || 'Asia/Riyadh';
      const now = new Date();
      const userTimeString = now.toLocaleTimeString('en-US', {
        timeZone: tz,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      const [currentHour, currentMin] = userTimeString.split(':').map(Number);
      const currentMinutes = currentHour * 60 + currentMin;

      const [startHour, startMin] = (pref.quietHoursStart || '22:00').split(':').map(Number);
      const startMinutes = startHour * 60 + startMin;

      const [endHour, endMin] = (pref.quietHoursEnd || '08:00').split(':').map(Number);
      const endMinutes = endHour * 60 + endMin;

      if (startMinutes <= endMinutes) {
        // e.g. 01:00 to 07:00
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
      } else {
        // e.g. 22:00 to 08:00 (spans midnight)
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
      }
    } catch (_) {
      return false;
    }
  }
}

export const notificationPreferenceService = NotificationPreferenceService.get();
