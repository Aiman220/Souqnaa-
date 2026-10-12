import { prisma } from '../../../database/prisma';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  RenderedNotificationContent,
} from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from '../providers/notification-provider.interface';
import { fcmPushProvider } from '../providers/push.provider';
import { realtimeWebSocketProvider } from '../providers/realtime.provider';
import { smtpEmailProvider } from '../providers/email.provider';
import { yemeniSmsProvider } from '../providers/sms.provider';
import { desktopNotificationProvider } from '../providers/desktop.provider';
import { notificationTokenService } from './notification-token.service';

export class NotificationDeliveryService {
  private static instance: NotificationDeliveryService;
  private providers = new Map<NotificationChannel, NotificationProvider>();

  private constructor() {
    this.providers.set(NotificationChannel.PUSH, fcmPushProvider);
    this.providers.set(NotificationChannel.REAL_TIME, realtimeWebSocketProvider);
    this.providers.set(NotificationChannel.EMAIL, smtpEmailProvider);
    this.providers.set(NotificationChannel.SMS, yemeniSmsProvider);
    this.providers.set(NotificationChannel.DESKTOP, desktopNotificationProvider);
  }

  static get(): NotificationDeliveryService {
    if (!NotificationDeliveryService.instance) {
      NotificationDeliveryService.instance = new NotificationDeliveryService();
    }
    return NotificationDeliveryService.instance;
  }

  /**
   * Dispatches delivery across the specified channels.
   */
  async deliverChannels(params: {
    notificationId?: string;
    recipientId: string;
    channels: NotificationChannel[];
    content: RenderedNotificationContent;
    category: string;
    priority: string;
    entityType?: string;
    entityId?: string;
    data?: Record<string, any>;
  }): Promise<Array<{ channel: NotificationChannel; provider: string; success: boolean; error?: string }>> {
    const results: Array<{ channel: NotificationChannel; provider: string; success: boolean; error?: string }> = [];

    // Fetch active device tokens once if push channel is requested
    let deviceTokens: string[] = [];
    if (params.channels.includes(NotificationChannel.PUSH)) {
      const devices = await notificationTokenService.getActiveDevices(params.recipientId);
      deviceTokens = devices.map((d) => d.deviceToken);
    }

    for (const channel of params.channels) {
      if (channel === NotificationChannel.IN_APP) {
        // IN_APP is represented by the persisted Notification record itself
        results.push({
          channel: NotificationChannel.IN_APP,
          provider: 'DATABASE',
          success: true,
        });
        continue;
      }

      const provider = this.providers.get(channel);
      if (!provider) continue;

      // 1. Create Delivery Record in DB
      let deliveryRecordId: string | undefined = undefined;
      try {
        const del = await prisma.notificationDelivery.create({
          data: {
            notificationId: params.notificationId,
            recipientId: params.recipientId,
            channel,
            provider: provider.providerName,
            status: NotificationDeliveryStatus.PROCESSING,
            attemptCount: 1,
          },
        });
        deliveryRecordId = del.id;
      } catch (_) {}

      // 2. Execute Provider Send with retry
      const sendParams: ProviderSendParams = {
        recipientId: params.recipientId,
        recipientEmail: params.data?.recipientEmail,
        recipientPhone: params.data?.recipientPhone,
        deviceTokens,
        content: params.content,
        category: params.category,
        priority: params.priority,
        notificationId: params.notificationId,
        entityType: params.entityType,
        entityId: params.entityId,
        data: params.data,
        metadata: params.data,
      };

      const sendResult = await this.executeWithRetry(provider, sendParams);

      // 3. Handle invalid tokens cleanup
      if (sendResult.invalidTokens && sendResult.invalidTokens.length > 0) {
        for (const token of sendResult.invalidTokens) {
          await notificationTokenService.markTokenInactive(token);
        }
      }

      // 4. Update Delivery Record
      if (deliveryRecordId) {
        try {
          await prisma.notificationDelivery.update({
            where: { id: deliveryRecordId },
            data: {
              status: sendResult.success
                ? NotificationDeliveryStatus.SENT
                : NotificationDeliveryStatus.FAILED,
              sentAt: sendResult.success ? new Date() : undefined,
              lastError: sendResult.error || undefined,
            },
          });
        } catch (_) {}
      }

      results.push({
        channel,
        provider: provider.providerName,
        success: sendResult.success,
        error: sendResult.error,
      });
    }

    return results;
  }

  /**
   * Executes provider send with 1 retry on failure with backoff.
   */
  private async executeWithRetry(
    provider: NotificationProvider,
    params: ProviderSendParams,
    maxAttempts = 2
  ): Promise<ProviderSendResult> {
    let lastError: string | undefined = undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await provider.send(params);
        if (res.success) return res;
        lastError = res.error;
      } catch (err: any) {
        lastError = err.message;
      }

      // Short delay before retry
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return {
      success: false,
      provider: provider.providerName,
      channel: provider.channel,
      error: lastError || 'Delivery failed after retries',
    };
  }
}

export const notificationDeliveryService = NotificationDeliveryService.get();
