import { prisma } from '../../../database/prisma';
import { SocketService } from '../../../services/websocket/socket.service';
import { NotificationChannel } from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from './notification-provider.interface';

export class RealtimeWebSocketProvider implements NotificationProvider {
  channel = NotificationChannel.REAL_TIME;
  providerName = 'WEBSOCKET';

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
    try {
      const socketSvc = SocketService.get();
      if (!socketSvc) {
        return { success: true, provider: this.providerName, channel: this.channel };
      }

      // Check if user is online
      const isOnline = socketSvc.isUserOnline(params.recipientId);

      const isEn = params.data?.locale === 'en' || (params as any).locale === 'en';
      const resolvedTitle = isEn && params.content.titleEn ? params.content.titleEn : (params.content.titleAr || params.content.titleEn || '');
      const resolvedBody = isEn && params.content.bodyEn ? params.content.bodyEn : (params.content.bodyAr || params.content.bodyEn || '');

      const payload = {
        id: params.notificationId,
        category: params.category,
        priority: params.priority,
        type: (params.data?.eventType as string) || (params.category === 'REFUND' ? 'REFUND_DISPUTED' : 'SYSTEM'),
        title: resolvedTitle,
        body: resolvedBody,
        titleAr: params.content.titleAr || resolvedTitle,
        titleEn: params.content.titleEn || resolvedTitle,
        bodyAr: params.content.bodyAr || resolvedBody,
        bodyEn: params.content.bodyEn || resolvedBody,
        deepLink: params.content.deepLink,
        imageUrl: params.content.imageUrl,
        entityType: params.entityType,
        entityId: params.entityId,
        data: params.data || {},
        createdAt: new Date().toISOString(),
      };

      // 1. Emit notification event to user room
      socketSvc.emitToUser(params.recipientId, 'notification:received', payload);

      // 2. Refresh unread count for user in real-time
      const unreadCount = await prisma.notification.count({
        where: { userId: params.recipientId, isRead: false },
      });

      socketSvc.emitToUser(params.recipientId, 'notification:unread_count', {
        unreadCount,
      });

      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: `ws_${Date.now()}`,
      };
    } catch (err: any) {
      return {
        success: false,
        provider: this.providerName,
        channel: this.channel,
        error: err.message,
      };
    }
  }
}

export const realtimeWebSocketProvider = new RealtimeWebSocketProvider();
