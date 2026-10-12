export enum NotificationCategory {
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
  WALLET = 'WALLET',
  CHAT = 'CHAT',
  COUPON = 'COUPON',
  PROMOTION = 'PROMOTION',
  FLASH_SALE = 'FLASH_SALE',
  MEGA_CAMPAIGN = 'MEGA_CAMPAIGN',
  REWARDS = 'REWARDS',
  PRICE_ALERT = 'PRICE_ALERT',
  STOCK_ALERT = 'STOCK_ALERT',
  SELLER = 'SELLER',
  SECURITY = 'SECURITY',
  SYSTEM = 'SYSTEM',
  ADMIN = 'ADMIN',
  DELIVERY = 'DELIVERY',
  ACCOUNT = 'ACCOUNT',
  REVIEW = 'REVIEW',
  CART_ABANDONMENT = 'CART_ABANDONMENT',
}

export enum NotificationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum NotificationChannel {
  PUSH = 'PUSH',
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  REAL_TIME = 'REAL_TIME',
  WEB_PUSH = 'WEB_PUSH',
  DESKTOP = 'DESKTOP',
}

export enum NotificationDeliveryStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  OPENED = 'OPENED',
  CLICKED = 'CLICKED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum AppType {
  CUSTOMER = 'CUSTOMER',
  SELLER = 'SELLER',
  ADMIN = 'ADMIN',
}

export enum DevicePlatform {
  ANDROID = 'ANDROID',
  IOS = 'IOS',
  WEB = 'WEB',
  WINDOWS = 'WINDOWS',
  MACOS = 'MACOS',
  LINUX = 'LINUX',
}

export interface DomainNotificationEvent {
  eventId: string;
  idempotencyKey?: string;
  eventType: string; // e.g. ORDER_SHIPPED, PAYMENT_SUCCESS
  category: NotificationCategory;
  priority: NotificationPriority;
  recipientId: string;
  recipientType: AppType;
  recipientEmail?: string;
  recipientPhone?: string;
  entityType?: string; // e.g. 'order', 'product', 'chat', 'wallet'
  entityId?: string;
  data?: Record<string, any>;
  channelsOverride?: NotificationChannel[];
  bypassQuietHours?: boolean;
  bypassRateLimit?: boolean;
  createdAt: Date;
}

export interface RenderedNotificationContent {
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  imageUrl?: string;
  deepLink?: string;
  actionTitleAr?: string;
  actionTitleEn?: string;
}

export interface DispatchResult {
  notificationId?: string;
  status: 'DELIVERED' | 'SUPPRESSED' | 'QUEUED' | 'FAILED';
  channelsSent: NotificationChannel[];
  channelsSuppressed: NotificationChannel[];
  reason?: string;
  deliveries: Array<{
    channel: NotificationChannel;
    provider: string;
    success: boolean;
    error?: string;
  }>;
}
