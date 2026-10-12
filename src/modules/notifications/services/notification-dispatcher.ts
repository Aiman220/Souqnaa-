import { prisma } from '../../../database/prisma';
import { NotificationType } from '@prisma/client';
import {
  DomainNotificationEvent,
  DispatchResult,
} from '../notification.types';
import { notificationEventBus } from './event-bus';
import { notificationTemplateService } from './notification-template.service';
import { notificationPreferenceService } from './notification-preference.service';
import { notificationDeduplicationService } from './notification-deduplication.service';
import { notificationRateLimiterService } from './notification-rate-limiter.service';
import { notificationDeliveryService } from './notification-delivery.service';

export class NotificationDispatcher {
  private static instance: NotificationDispatcher;
  private isEmergencyKillSwitchActive = false;

  private constructor() {
    // Automatically wire dispatcher to event bus
    notificationEventBus.subscribe((event) => {
      this.dispatch(event).catch((err) => {
        console.error('[NotificationDispatcher] Background event dispatch error:', err);
      });
    });
  }

  static get(): NotificationDispatcher {
    if (!NotificationDispatcher.instance) {
      NotificationDispatcher.instance = new NotificationDispatcher();
    }
    return NotificationDispatcher.instance;
  }

  /**
   * Emergency Kill Switch controls (Admin RBAC only)
   */
  setEmergencyKillSwitch(active: boolean) {
    this.isEmergencyKillSwitchActive = active;
    console.warn(`[NotificationDispatcher] Emergency kill switch set to: ${active}`);
  }

  getEmergencyKillSwitch(): boolean {
    return this.isEmergencyKillSwitchActive;
  }

  /**
   * Main Dispatch Pipeline
   */
  async dispatch(event: DomainNotificationEvent): Promise<DispatchResult> {
    // 1. Emergency Kill Switch check (Critical security notifications always bypass)
    if (this.isEmergencyKillSwitchActive && event.category !== 'SECURITY') {
      return {
        status: 'SUPPRESSED',
        channelsSent: [],
        channelsSuppressed: [],
        reason: 'Emergency kill switch active',
        deliveries: [],
      };
    }

    // 2. Deduplication Check
    const isDuplicate = await notificationDeduplicationService.isDuplicate(event);
    if (isDuplicate) {
      return {
        status: 'SUPPRESSED',
        channelsSent: [],
        channelsSuppressed: [],
        reason: 'Duplicate notification suppressed by idempotency policy',
        deliveries: [],
      };
    }

    // 3. Rate Limit Check
    const isRateLimited = await notificationRateLimiterService.isRateLimited(event);
    if (isRateLimited) {
      return {
        status: 'SUPPRESSED',
        channelsSent: [],
        channelsSuppressed: [],
        reason: 'Recipient exceeded hourly rate limit for category',
        deliveries: [],
      };
    }

    // 4. Render Template Content (Bilingual + Deep Links)
    const content = await notificationTemplateService.render(event);

    // 5. User Preferences & Quiet Hours Evaluation
    const { allowedChannels, suppressedChannels, isQuietHoursSuppressed } =
      await notificationPreferenceService.evaluateAllowedChannels(event);

    if (allowedChannels.length === 0) {
      return {
        status: 'SUPPRESSED',
        channelsSent: [],
        channelsSuppressed: suppressedChannels,
        reason: isQuietHoursSuppressed
          ? 'Quiet hours active for non-critical notification'
          : 'User opted out of all channels for this category',
        deliveries: [],
      };
    }

    // 6. Map to Prisma NotificationType enum for legacy compatibility
    let prismaType: NotificationType = NotificationType.SYSTEM;
    if (event.category === 'ORDER') prismaType = NotificationType.ORDER_STATUS;
    else if (event.category === 'PAYMENT') prismaType = NotificationType.PAYMENT;
    else if (event.category === 'CHAT') prismaType = NotificationType.CHAT_MESSAGE;
    else if (event.category === 'PROMOTION' || event.category === 'FLASH_SALE' || event.category === 'MEGA_CAMPAIGN') prismaType = NotificationType.PROMOTION;
    else if (event.category === 'PRICE_ALERT') prismaType = NotificationType.WISHLIST_PRICE_DROP;
    else if (event.category === 'STOCK_ALERT') prismaType = NotificationType.WISHLIST_BACK_IN_STOCK;
    else if (event.category === 'REWARDS') prismaType = NotificationType.REWARD_COINS_EARNED;
    else if (event.category === 'REFUND') prismaType = NotificationType.REFUND_REQUESTED;

    // 7. Persist Canonical Notification in Database
    let savedNotificationId: string | undefined = undefined;
    try {
      const saved = await prisma.notification.create({
        data: {
          userId: event.recipientId,
          recipientType: event.recipientType,
          category: event.category,
          priority: event.priority,
          titleAr: content.titleAr,
          titleEn: content.titleEn,
          bodyAr: content.bodyAr,
          bodyEn: content.bodyEn,
          type: prismaType,
          imageUrl: content.imageUrl,
          data: event.data ? JSON.stringify(event.data) : null,
          deepLink: content.deepLink,
          entityType: event.entityType,
          entityId: event.entityId,
          channels: JSON.stringify(allowedChannels),
          status: 'SENT',
          isRead: false,
          eventId: event.eventId,
          idempotencyKey: event.idempotencyKey,
        },
      });
      savedNotificationId = saved.id;
    } catch (err: any) {
      console.error('[NotificationDispatcher] Failed to persist canonical notification:', err);
    }

    // 8. Deliver across Allowed Channels
    const deliveries = await notificationDeliveryService.deliverChannels({
      notificationId: savedNotificationId,
      recipientId: event.recipientId,
      channels: allowedChannels,
      content,
      category: event.category,
      priority: event.priority,
      entityType: event.entityType,
      data: {
        ...(event.data || {}),
        eventType: event.eventType,
        category: event.category,
        recipientType: event.recipientType,
      },
    });

    return {
      notificationId: savedNotificationId,
      status: 'DELIVERED',
      channelsSent: allowedChannels,
      channelsSuppressed: suppressedChannels,
      deliveries,
    };
  }
}

export const notificationDispatcher = NotificationDispatcher.get();
