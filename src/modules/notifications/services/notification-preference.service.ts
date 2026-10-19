import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import {
  NotificationCategory,
  NotificationChannel,
  DomainNotificationEvent,
  AdminNotificationPreferences,
  normalizePriority,
  AppType,
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
   * Default preferences tailored specifically for System Administrators (§3, §4)
   */
  public static readonly DEFAULT_ADMIN_PREFERENCES: AdminNotificationPreferences = {
    p0PushEnabled: true,
    p0SoundEnabled: true,
    p0VibrationEnabled: true,
    p1PushEnabled: true,
    p1SoundEnabled: false, // Silent push by default to prevent fatigue
    p2DigestEnabled: true, // Aggregated 30-min summary by default
    p2DigestIntervalMinutes: 30,
    p2InstantPush: false,
    p3NotificationCenterOnly: true,
    p3PushEnabled: false,
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    timezone: 'Asia/Riyadh',
    mutedUntil: null,
    subscribedCategories: [
      'FINANCE',
      'SECURITY',
      'ORDERS',
      'SELLERS',
      'SYSTEM',
      'REFUND',
      'DISPUTE',
      'PAYMENT',
      'ADMIN',
    ],
  };

  /**
   * Fetch admin notification preferences (cached in Redis, backed by database).
   */
  async getAdminPreferences(userId: string): Promise<AdminNotificationPreferences> {
    const redisKey = `admin:pref:${userId}`;
    try {
      const cached = await redis.get(redisKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (_) {}

    // Fallback to database record for category ADMIN
    const dbRecord = await prisma.notificationPreference.findUnique({
      where: {
        userId_category: {
          userId,
          category: NotificationCategory.ADMIN,
        },
      },
    });

    const prefs: AdminNotificationPreferences = {
      ...NotificationPreferenceService.DEFAULT_ADMIN_PREFERENCES,
      ...(dbRecord
        ? {
            quietHoursEnabled: dbRecord.quietHoursEnabled,
            quietHoursStart: dbRecord.quietHoursStart || '22:00',
            quietHoursEnd: dbRecord.quietHoursEnd || '08:00',
            timezone: dbRecord.timezone || 'Asia/Riyadh',
            p1PushEnabled: dbRecord.pushEnabled,
          }
        : {}),
    };

    // Cache in Redis for fast repeated access (1 hour TTL)
    try {
      await redis.set(redisKey, JSON.stringify(prefs), 3600);
    } catch (_) {}

    return prefs;
  }

  /**
   * Update admin notification preferences with multi-device sync and audit logging.
   */
  async updateAdminPreferences(
    userId: string,
    data: Partial<AdminNotificationPreferences>
  ): Promise<AdminNotificationPreferences> {
    const current = await this.getAdminPreferences(userId);
    const updated: AdminNotificationPreferences = {
      ...current,
      ...data,
      // P0 critical alerts push cannot be disabled by policy
      p0PushEnabled: true,
    };

    // 1. Update in Redis cache
    const redisKey = `admin:pref:${userId}`;
    try {
      await redis.set(redisKey, JSON.stringify(updated), 3600);
    } catch (_) {}

    // 2. Persist in database
    try {
      await prisma.notificationPreference.upsert({
        where: {
          userId_category: {
            userId,
            category: NotificationCategory.ADMIN,
          },
        },
        update: {
          pushEnabled: updated.p1PushEnabled,
          quietHoursEnabled: updated.quietHoursEnabled,
          quietHoursStart: updated.quietHoursStart,
          quietHoursEnd: updated.quietHoursEnd,
          timezone: updated.timezone,
        },
        create: {
          userId,
          category: NotificationCategory.ADMIN,
          pushEnabled: updated.p1PushEnabled,
          emailEnabled: true,
          smsEnabled: false,
          inAppEnabled: true,
          quietHoursEnabled: updated.quietHoursEnabled,
          quietHoursStart: updated.quietHoursStart,
          quietHoursEnd: updated.quietHoursEnd,
          timezone: updated.timezone,
        },
      });
    } catch (_) {}

    // 3. Write immutable audit log
    try {
      await prisma.notificationAuditLog.create({
        data: {
          adminId: userId,
          action: 'PREFERENCE_CHANGED',
          targetType: 'USER',
          targetId: userId,
          details: JSON.stringify(data),
        },
      });
    } catch (_) {}

    return updated;
  }

  /**
   * Temporarily mute admin notifications for N hours (P0 critical incidents bypass).
   */
  async muteAdminNotifications(userId: string, hours: number): Promise<{ mutedUntil: string | null }> {
    const mutedUntil = hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null;
    await this.updateAdminPreferences(userId, { mutedUntil });
    return { mutedUntil };
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
    const allowedChannels: NotificationChannel[] = [];
    const suppressedChannels: NotificationChannel[] = [];

    // In-App & Realtime are always allowed so events remain visible in Notification Center
    allowedChannels.push(NotificationChannel.IN_APP);
    allowedChannels.push(NotificationChannel.REAL_TIME);

    // If event explicitly specifies channel overrides, respect them
    if (event.channelsOverride && event.channelsOverride.length > 0) {
      return {
        allowedChannels: event.channelsOverride,
        suppressedChannels: [],
        isQuietHoursSuppressed: false,
      };
    }

    // =========================================================================
    // A. ADMIN NOTIFICATION PRIORITY ROUTING & FATIGUE MITIGATION
    // =========================================================================
    if (event.recipientType === AppType.ADMIN) {
      const adminPrefs = await this.getAdminPreferences(event.recipientId);
      const priority = normalizePriority(event.priority);

      // Check temporary muting
      const isMuted = Boolean(
        adminPrefs.mutedUntil && new Date(adminPrefs.mutedUntil) > new Date()
      );

      // Check quiet hours
      const isQuiet =
        !event.bypassQuietHours &&
        priority !== 'P0' &&
        this.isQuietHoursActive(adminPrefs);

      // ── P0: Critical Incidents ──────────────────────────────────────────────
      if (priority === 'P0') {
        // Critical alerts ALWAYS deliver immediate push; sound/vibration subject to explicit pref
        allowedChannels.push(NotificationChannel.PUSH);
        return {
          allowedChannels,
          suppressedChannels,
          isQuietHoursSuppressed: false,
        };
      }

      // If temporarily muted, suppress push for non-P0 alerts
      if (isMuted) {
        suppressedChannels.push(NotificationChannel.PUSH);
        return {
          allowedChannels,
          suppressedChannels,
          isQuietHoursSuppressed: false,
        };
      }

      // ── P1: High-Priority Operational Alerts ─────────────────────────────────
      if (priority === 'P1') {
        if (isQuiet) {
          suppressedChannels.push(NotificationChannel.PUSH);
          return {
            allowedChannels,
            suppressedChannels,
            isQuietHoursSuppressed: true,
          };
        }
        if (adminPrefs.p1PushEnabled) {
          allowedChannels.push(NotificationChannel.PUSH);
        } else {
          suppressedChannels.push(NotificationChannel.PUSH);
        }
        return {
          allowedChannels,
          suppressedChannels,
          isQuietHoursSuppressed: false,
        };
      }

      // ── P2: Routine Business Notifications ──────────────────────────────────
      if (priority === 'P2') {
        if (isQuiet) {
          suppressedChannels.push(NotificationChannel.PUSH);
          return {
            allowedChannels,
            suppressedChannels,
            isQuietHoursSuppressed: true,
          };
        }
        // If admin opted for instant push, send push; otherwise defer to 30-min digest summary
        if (adminPrefs.p2InstantPush) {
          allowedChannels.push(NotificationChannel.PUSH);
        } else {
          // Defer push to digest worker to prevent notification fatigue (§3, §6)
          suppressedChannels.push(NotificationChannel.PUSH);
        }
        return {
          allowedChannels,
          suppressedChannels,
          isQuietHoursSuppressed: false,
        };
      }

      // ── P3: Informational Notifications ─────────────────────────────────────
      if (priority === 'P3') {
        if (!isQuiet && adminPrefs.p3PushEnabled && !adminPrefs.p3NotificationCenterOnly) {
          allowedChannels.push(NotificationChannel.PUSH);
        } else {
          suppressedChannels.push(NotificationChannel.PUSH);
        }
        return {
          allowedChannels,
          suppressedChannels,
          isQuietHoursSuppressed: isQuiet,
        };
      }
    }

    // =========================================================================
    // B. CUSTOMER & SELLER NOTIFICATION PREFERENCES (PRESERVED)
    // =========================================================================
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
