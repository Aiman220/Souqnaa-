export enum CustomerActionType {
  VERIFY_PHONE = 'VERIFY_PHONE',
  VERIFY_EMAIL = 'VERIFY_EMAIL',
  SECURITY_ACTION = 'SECURITY_ACTION',
  COMPLETE_PROFILE = 'COMPLETE_PROFILE',
  ENABLE_NOTIFICATION_PERMISSION = 'ENABLE_NOTIFICATION_PERMISSION',
  ENABLE_LOCATION_PERMISSION = 'ENABLE_LOCATION_PERMISSION',
  ENABLE_CAMERA_PERMISSION = 'ENABLE_CAMERA_PERMISSION',
  ENABLE_PHOTOS_PERMISSION = 'ENABLE_PHOTOS_PERMISSION',
  WELCOME_GIFT = 'WELCOME_GIFT',
  CLAIM_REWARD = 'CLAIM_REWARD',
  CLAIM_COUPON = 'CLAIM_COUPON',
  MEMBERSHIP_ACTION = 'MEMBERSHIP_ACTION',
  MEMBERSHIP_PROGRESS = 'MEMBERSHIP_PROGRESS',
  ORDER_ACTION = 'ORDER_ACTION',
  PAYMENT_ACTION = 'PAYMENT_ACTION',
  DELIVERY_ACTION = 'DELIVERY_ACTION',
  REFUND_ACTION = 'REFUND_ACTION',
  ADDRESS_ACTION = 'ADDRESS_ACTION',
  WALLET_ACTION = 'WALLET_ACTION',
  APP_UPDATE = 'APP_UPDATE',
  PLATFORM_ANNOUNCEMENT = 'PLATFORM_ANNOUNCEMENT',
  CUSTOM = 'CUSTOM',
}

export enum CustomerActionCategory {
  SECURITY = 'SECURITY',
  ACCOUNT = 'ACCOUNT',
  PERMISSION = 'PERMISSION',
  REWARD = 'REWARD',
  MEMBERSHIP = 'MEMBERSHIP',
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  DELIVERY = 'DELIVERY',
  PROMOTION = 'PROMOTION',
  PLATFORM = 'PLATFORM',
  PROFILE = 'PROFILE',
  CUSTOM = 'CUSTOM',
}

export enum CustomerActionPriority {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export enum CustomerActionStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  DISMISSED = 'DISMISSED',
}

export interface CustomerAction {
  id: string;
  type: CustomerActionType | string;
  category: CustomerActionCategory | string;
  priority: CustomerActionPriority;
  status: CustomerActionStatus;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  icon: string;
  image?: string | null;
  ctaLabelAr?: string | null;
  ctaLabelEn?: string | null;
  deepLink: string;
  expiresAt?: string | null;
  dismissible: boolean;
  snoozable: boolean;
  requiresAction: boolean;
  deduplicationKey: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string | null;
}

export interface CustomerActionCenterResponse {
  items: CustomerAction[];
  totalCount: number;
  hasMore: boolean;
  configVersion: string;
}

export interface ActionCenterFilterOptions {
  platform?: string;
  appVersion?: string;
  limit?: number;
  locale?: 'ar' | 'en';
}

export interface DismissActionPayload {
  actionId: string;
  deduplicationKey?: string;
  reason?: string;
}

export interface SnoozeActionPayload {
  actionId: string;
  deduplicationKey?: string;
  snoozeHours?: number;
}

export interface ClaimActionPayload {
  actionId: string;
  claimType?: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
}
