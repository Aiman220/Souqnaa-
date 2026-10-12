/**
 * SOUQNA Cart Abandonment Reminder Engine
 * Types, Configurations, Suppression Enums, and State Models
 */

export enum CartAbandonmentCycleStatus {
  ACTIVE = 'ACTIVE',
  RECOVERED = 'RECOVERED',
  SUPPRESSED = 'SUPPRESSED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum CartAbandonmentReminderStatus {
  SCHEDULED = 'SCHEDULED',
  SENT = 'SENT',
  SUPPRESSED = 'SUPPRESSED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum CartAbandonmentSuppressionReason {
  CART_NOT_FOUND = 'CART_NOT_FOUND',
  CART_EMPTY = 'CART_EMPTY',
  INSUFFICIENT_INACTIVITY = 'INSUFFICIENT_INACTIVITY',
  ALL_ITEMS_UNAVAILABLE = 'ALL_ITEMS_UNAVAILABLE',
  NO_PURCHASABLE_ITEMS = 'NO_PURCHASABLE_ITEMS',
  ALL_SELLERS_INACTIVE = 'ALL_SELLERS_INACTIVE',
  ORDER_ALREADY_COMPLETED = 'ORDER_ALREADY_COMPLETED',
  RECENT_CHECKOUT_ATTEMPT = 'RECENT_CHECKOUT_ATTEMPT',
  RECENT_CART_OPENED = 'RECENT_CART_OPENED',
  SAME_PRODUCT_RECENTLY_PURCHASED = 'SAME_PRODUCT_RECENTLY_PURCHASED',
  USER_OPTED_OUT = 'USER_OPTED_OUT',
  NO_PUSH_PERMISSION = 'NO_PUSH_PERMISSION',
  DAILY_FREQUENCY_LIMIT_REACHED = 'DAILY_FREQUENCY_LIMIT_REACHED',
  WEEKLY_FREQUENCY_LIMIT_REACHED = 'WEEKLY_FREQUENCY_LIMIT_REACHED',
  MAX_REMINDERS_EXCEEDED = 'MAX_REMINDERS_EXCEEDED',
  STAGE_COOLDOWN_NOT_MET = 'STAGE_COOLDOWN_NOT_MET',
  CART_EXPIRED = 'CART_EXPIRED',
  BELOW_MIN_ITEMS = 'BELOW_MIN_ITEMS',
  BELOW_MIN_VALUE = 'BELOW_MIN_VALUE',
  QUIET_HOURS_DEFERRED = 'QUIET_HOURS_DEFERRED',
  FEATURE_FLAG_DISABLED = 'FEATURE_FLAG_DISABLED',
  IDEMPOTENCY_ALREADY_SENT = 'IDEMPOTENCY_ALREADY_SENT',
  CUSTOMER_RESTRICTED = 'CUSTOMER_RESTRICTED',
}

export interface CartAbandonmentConfig {
  cart_abandonment_reminders_enabled: boolean;
  cart_abandonment_first_delay_minutes: number;
  cart_abandonment_second_delay_minutes: number;
  cart_abandonment_max_reminders: number;
  cart_abandonment_customer_daily_limit: number;
  cart_abandonment_customer_weekly_limit: number;
  cart_abandonment_min_items: number;
  cart_abandonment_min_cart_value: number;
  cart_abandonment_require_push_permission: boolean;
  cart_abandonment_quiet_hours_enabled: boolean;
  cart_abandonment_quiet_hours: {
    start: string; // e.g. "22:00"
    end: string;   // e.g. "08:00"
  };
  cart_abandonment_personalization_enabled: boolean;
  cart_abandonment_cart_expiration_days: number;
  cart_abandonment_cart_open_cooldown_minutes: number;
  cart_abandonment_recent_order_cooldown_hours: number;
  cart_abandonment_attribution_window_hours: number;
}

export interface ValidatedCartItem {
  cartItemId: string;
  productId: string;
  variantId: string | null;
  productNameAr: string;
  productNameEn: string;
  sellerId: string;
  storeId: string;
  storeName: string;
  isStoreActive: boolean;
  requestedQuantity: number;
  authoritativeStock: number;
  isAvailable: boolean;
  unavailabilityReason?: string;
  originalUnitPrice: number;
  authoritativeUnitPrice: number;
  priceChanged: boolean;
  priceDifference: number;
  itemTotal: number;
  isFlashSale: boolean;
  isFlashSaleValid: boolean;
  imageUrl?: string;
}

export interface AuthoritativeCartSummary {
  cartId: string;
  userId: string;
  totalItemsCount: number;
  eligibleItemsCount: number;
  unavailableItemsCount: number;
  uniqueSellersCount: number;
  isMultiSeller: boolean;
  storeNames: string[];
  items: ValidatedCartItem[];
  eligibleItems: ValidatedCartItem[];
  subtotal: number;
  hasPriceChanges: boolean;
  cartUpdatedAt: Date;
}

export interface CartEligibilityResult {
  isEligible: boolean;
  cartId: string;
  userId: string;
  stage: number;
  suppressionReason?: CartAbandonmentSuppressionReason;
  suppressionDetails?: string;
  deferUntil?: Date;
  cartSummary?: AuthoritativeCartSummary;
  idempotencyKey?: string;
}

export interface AbandonmentCycleRecord {
  id: string;
  cartId: string;
  userId: string;
  cartUpdatedAt: Date;
  stage: number;
  status: CartAbandonmentCycleStatus;
  suppressionReason?: string;
  firstReminderSentAt?: Date;
  secondReminderSentAt?: Date;
  recoveredAt?: Date;
  lastNotificationId?: string;
  attributedOrderId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartAbandonmentReminderLog {
  id: string;
  cycleId: string;
  cartId: string;
  userId: string;
  stage: number;
  idempotencyKey: string;
  scheduledAt: Date;
  sentAt?: Date;
  status: CartAbandonmentReminderStatus;
  suppressionReason?: string;
  notificationId?: string;
  openedAt?: Date;
  convertedAt?: Date;
  createdAt: Date;
}

export interface CartRecoveryAnalyticsSummary {
  period: string;
  startDate?: string;
  endDate?: string;
  abandonedCartCycles: number;
  activeCycles: number;
  remindersSentTotal: number;
  remindersSentStage1: number;
  remindersSentStage2: number;
  remindersOpened: number;
  openRate: number;
  cartsReopened: number;
  conversions: number;
  conversionRate: number;
  attributedRevenue: number;
  currency: string;
  suppressionCount: number;
  suppressionRate: number;
  suppressionBreakdown: Record<string, number>;
  notificationOptOutRate: number;
}
