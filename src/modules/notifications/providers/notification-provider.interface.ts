import {
  NotificationChannel,
  RenderedNotificationContent,
} from '../notification.types';

export interface ProviderSendParams {
  recipientId: string;
  deviceTokens?: string[];
  recipientEmail?: string;
  recipientPhone?: string;
  content: RenderedNotificationContent;
  category?: string;
  priority?: string;
  notificationId?: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ProviderSendResult {
  success: boolean;
  provider: string;
  channel: NotificationChannel;
  messageId?: string;
  invalidTokens?: string[];
  error?: string;
}

export interface NotificationProvider {
  channel: NotificationChannel;
  providerName: string;
  send(params: ProviderSendParams): Promise<ProviderSendResult>;
}
