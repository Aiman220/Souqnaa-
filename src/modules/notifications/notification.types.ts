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
  P0_CRITICAL = 'P0',
  P1_HIGH = 'P1',
  P2_ROUTINE = 'P2',
  P3_INFO = 'P3',
}

export type PriorityLevel = 'P0' | 'P1' | 'P2' | 'P3';

export function normalizePriority(priority: string | NotificationPriority | undefined | null): PriorityLevel {
  if (!priority) return 'P2';
  const p = priority.toString().toUpperCase().trim();
  if (p === 'P0' || p === 'P0_CRITICAL' || p === 'URGENT' || p === 'CRITICAL') return 'P0';
  if (p === 'P1' || p === 'P1_HIGH' || p === 'HIGH') return 'P1';
  if (p === 'P2' || p === 'P2_ROUTINE' || p === 'NORMAL') return 'P2';
  if (p === 'P3' || p === 'P3_INFO' || p === 'LOW' || p === 'INFO') return 'P3';
  return 'P2';
}

export interface AdminNotificationPreferences {
  // P0 - Critical
  p0PushEnabled: boolean;
  p0SoundEnabled: boolean;
  p0VibrationEnabled: boolean;

  // P1 - High Priority
  p1PushEnabled: boolean;
  p1SoundEnabled: boolean;

  // P2 - Routine Business
  p2DigestEnabled: boolean;
  p2DigestIntervalMinutes: number;
  p2InstantPush: boolean;

  // P3 - Informational
  p3NotificationCenterOnly: boolean;
  p3PushEnabled: boolean;

  // Quiet Hours & Timezone
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;

  // Temporary Mute
  mutedUntil: string | null;

  // Subscribed Categories
  subscribedCategories: string[];
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
  priority: NotificationPriority | string;
  recipientId: string;
  recipientType: AppType;
  recipientEmail?: string;
  recipientPhone?: string;
  entityType?: string; // e.g. 'order', 'product', 'chat', 'wallet', 'incident'
  entityId?: string;
  incidentId?: string;
  isResolved?: boolean;
  digestGroupKey?: string;
  requiredPermission?: string;
  requiredRole?: string;
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
