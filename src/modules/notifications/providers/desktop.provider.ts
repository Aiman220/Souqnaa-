import { SocketService } from '../../../services/websocket/socket.service';
import { NotificationChannel } from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from './notification-provider.interface';

export class DesktopNotificationProvider implements NotificationProvider {
  channel = NotificationChannel.DESKTOP;
  providerName = 'DESKTOP_NATIVE';

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
    try {
      const socketSvc = SocketService.get();
      if (socketSvc) {
        socketSvc.emitToUser(params.recipientId, 'desktop:notification', {
          title: params.content.titleAr,
          body: params.content.bodyAr,
          deepLink: params.content.deepLink,
          imageUrl: params.content.imageUrl,
          category: params.category,
        });
      }

      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: `desktop_${Date.now()}`,
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

export const desktopNotificationProvider = new DesktopNotificationProvider();
