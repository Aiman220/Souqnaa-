import { randomUUID } from 'crypto';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
  AppType,
} from '../notification.types';

export class NotificationEventFactory {
  // ── Orders ────────────────────────────────────────────────────────────────
  static orderEvent(params: {
    eventType:
      | 'ORDER_CREATED'
      | 'ORDER_ACCEPTED'
      | 'ORDER_CONFIRMED'
      | 'ORDER_PROCESSING'
      | 'ORDER_READY_TO_SHIP'
      | 'ORDER_SHIPPED'
      | 'ORDER_OUT_FOR_DELIVERY'
      | 'ORDER_DELIVERED'
      | 'ORDER_CANCELLED';
    recipientId: string;
    orderId: string;
    orderNumber: string;
    customerName?: string;
    sellerName?: string;
    totalAmount?: number;
    carrierName?: string;
    trackingNumber?: string;
    cancelReason?: string;
    isSeller?: boolean;
  }): DomainNotificationEvent {
    const isUrgent = params.eventType === 'ORDER_CANCELLED';
    const isHigh =
      params.eventType === 'ORDER_SHIPPED' ||
      params.eventType === 'ORDER_OUT_FOR_DELIVERY' ||
      params.eventType === 'ORDER_DELIVERED';

    return {
      eventId: randomUUID(),
      idempotencyKey: `order_${params.orderId}_${params.eventType}`,
      eventType: params.eventType,
      category: NotificationCategory.ORDER,
      priority: isUrgent
        ? NotificationPriority.URGENT
        : isHigh
        ? NotificationPriority.HIGH
        : NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: params.isSeller ? AppType.SELLER : AppType.CUSTOMER,
      entityType: 'order',
      entityId: params.orderId,
      data: {
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        customerName: params.customerName,
        sellerName: params.sellerName,
        totalAmount: params.totalAmount,
        carrierName: params.carrierName,
        trackingNumber: params.trackingNumber,
        cancelReason: params.cancelReason,
      },
      bypassQuietHours: isUrgent || isHigh,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Seller Orders ──────────────────────────────────────────────────────────
  static sellerOrderEvent(params: {
    eventType: 'SELLER_NEW_ORDER' | 'SELLER_PAYMENT_RECEIVED' | 'SELLER_REFUND_REQUEST';
    recipientId: string;
    orderId: string;
    orderNumber: string;
    totalAmount?: number;
    sellerOrderId?: string;
    refundId?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `seller_order_${params.orderId}_${params.recipientId}_${params.eventType}`,
      eventType: params.eventType,
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.HIGH,
      recipientId: params.recipientId,
      recipientType: AppType.SELLER,
      entityType: 'order',
      entityId: params.orderId,
      data: {
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        totalAmount: params.totalAmount,
        sellerOrderId: params.sellerOrderId,
        refundId: params.refundId,
      },
      bypassQuietHours: false,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  static paymentEvent(params: {
    eventType:
      | 'PAYMENT_PENDING'
      | 'PAYMENT_SUCCESS'
      | 'PAYMENT_FAILED'
      | 'PAYMENT_EXPIRED';
    recipientId: string;
    orderId: string;
    orderNumber: string;
    amount: number;
    currency?: string;
    paymentMethod?: string;
    errorMessage?: string;
  }): DomainNotificationEvent {
    const isUrgent = params.eventType === 'PAYMENT_FAILED';

    return {
      eventId: randomUUID(),
      idempotencyKey: `payment_${params.orderId}_${params.eventType}`,
      eventType: params.eventType,
      category: NotificationCategory.PAYMENT,
      priority: isUrgent ? NotificationPriority.URGENT : NotificationPriority.HIGH,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'payment',
      entityId: params.orderId,
      data: {
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        amount: params.amount,
        currency: params.currency || 'YER',
        paymentMethod: params.paymentMethod,
        errorMessage: params.errorMessage,
      },
      bypassQuietHours: true,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Refunds ───────────────────────────────────────────────────────────────
  static refundEvent(params: {
    eventType:
      | 'REFUND_REQUESTED'
      | 'REFUND_ACCEPTED'
      | 'REFUND_REJECTED'
      | 'REFUND_ESCALATED'
      | 'REFUND_COMPLETED';
    recipientId: string;
    refundId: string;
    refundNumber: string;
    orderId?: string;
    orderNumber?: string;
    amount?: number;
    currency?: string;
    reason?: string;
    isSeller?: boolean;
    isAdmin?: boolean;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `refund_${params.refundId}_${params.eventType}`,
      eventType: params.eventType,
      category: NotificationCategory.REFUND,
      priority: NotificationPriority.HIGH,
      recipientId: params.recipientId,
      recipientType: params.isAdmin
        ? AppType.ADMIN
        : params.isSeller
        ? AppType.SELLER
        : AppType.CUSTOMER,
      entityType: 'refund',
      entityId: params.refundId,
      data: {
        refundId: params.refundId,
        refundNumber: params.refundNumber,
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        amount: params.amount,
        currency: params.currency || 'YER',
        reason: params.reason,
      },
      bypassQuietHours: true,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Wallet ────────────────────────────────────────────────────────────────
  static walletEvent(params: {
    eventType:
      | 'WALLET_CREDITED'
      | 'WALLET_DEBITED'
      | 'WALLET_TRANSFER_COMPLETED'
      | 'WALLET_TRANSFER_FAILED'
      | 'WITHDRAWAL_COMPLETED'
      | 'WITHDRAWAL_REJECTED'
      | 'WALLET_TOPUP_APPROVED'
      | 'WALLET_TOPUP_REJECTED';
    recipientId: string;
    amount: number;
    currency?: string;
    newBalance?: number;
    referenceId?: string;
    description?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `wallet_${params.recipientId}_${params.eventType}_${Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.WALLET,
      priority: NotificationPriority.HIGH,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'wallet',
      entityId: params.referenceId || params.recipientId,
      data: {
        amount: params.amount,
        currency: params.currency || 'YER',
        newBalance: params.newBalance,
        description: params.description,
      },
      bypassQuietHours: true,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Coins & Rewards ───────────────────────────────────────────────────────
  static rewardEvent(params: {
    eventType:
      | 'COINS_EARNED'
      | 'COINS_REDEEMED'
      | 'COINS_EXPIRING'
      | 'COINS_EXPIRED'
      | 'REWARD_COMPLETED';
    recipientId: string;
    coinsAmount: number;
    missionTitle?: string;
    expiryDays?: number;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `reward_${params.recipientId}_${params.eventType}_${Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.REWARDS,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'rewards',
      entityId: 'coins',
      data: {
        coinsAmount: params.coinsAmount,
        missionTitle: params.missionTitle,
        expiryDays: params.expiryDays,
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }

  // ── Coupons ───────────────────────────────────────────────────────────────
  static couponEvent(params: {
    eventType:
      | 'COUPON_AVAILABLE'
      | 'COUPON_EXPIRING'
      | 'COUPON_USED';
    recipientId: string;
    couponId: string;
    couponCode: string;
    discountValue: string;
    storeName?: string;
    expiryDate?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `coupon_${params.couponId}_${params.recipientId}_${params.eventType}`,
      eventType: params.eventType,
      category: NotificationCategory.COUPON,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'coupon',
      entityId: params.couponId,
      data: {
        couponId: params.couponId,
        couponCode: params.couponCode,
        discountValue: params.discountValue,
        storeName: params.storeName,
        expiryDate: params.expiryDate,
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }

  // ── Flash Sales & Mega Campaigns ──────────────────────────────────────────
  static campaignEvent(params: {
    eventType:
      | 'FLASH_SALE_STARTED'
      | 'FLASH_SALE_ENDING'
      | 'FLASH_SALE_ENDED'
      | 'FLASH_SALE_STOCK_LOW'
      | 'FLASH_SALE_SUBMISSION_APPROVED'
      | 'FLASH_SALE_SUBMISSION_REJECTED'
      | 'CAMPAIGN_STARTED'
      | 'CAMPAIGN_ENDING'
      | 'MEGA_CAMPAIGN_STARTED';
    recipientId: string;
    campaignId: string;
    campaignTitleAr: string;
    campaignTitleEn?: string;
    recipientType?: AppType;
    discountPercentage?: number;
    bannerUrl?: string;
    data?: Record<string, any>;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `camp_${params.campaignId}_${params.recipientId}_${params.eventType}_${Date.now()}`,
      eventType: params.eventType,
      category:
        params.eventType.includes('FLASH_SALE')
          ? NotificationCategory.FLASH_SALE
          : NotificationCategory.MEGA_CAMPAIGN,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: params.recipientType || AppType.CUSTOMER,
      entityType: 'campaign',
      entityId: params.campaignId,
      data: {
        campaignId: params.campaignId,
        campaignTitleAr: params.campaignTitleAr,
        campaignTitleEn: params.campaignTitleEn,
        discountPercentage: params.discountPercentage,
        bannerUrl: params.bannerUrl,
        ...(params.data || {}),
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }

  // ── Price Alerts & Stock Alerts ───────────────────────────────────────────
  static alertEvent(params: {
    eventType: 'PRICE_DROPPED' | 'BACK_IN_STOCK' | 'LOW_STOCK';
    recipientId: string;
    productId: string;
    productNameAr: string;
    productNameEn?: string;
    oldPrice?: number;
    newPrice?: number;
    productImage?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `alert_${params.productId}_${params.recipientId}_${params.eventType}_${Math.floor(Date.now() / (3600 * 1000 * 6))}`, // 6h cooldown
      eventType: params.eventType,
      category:
        params.eventType === 'PRICE_DROPPED'
          ? NotificationCategory.PRICE_ALERT
          : NotificationCategory.STOCK_ALERT,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'product',
      entityId: params.productId,
      data: {
        productId: params.productId,
        productNameAr: params.productNameAr,
        productNameEn: params.productNameEn,
        oldPrice: params.oldPrice,
        newPrice: params.newPrice,
        imageUrl: params.productImage,
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  static chatEvent(params: {
    eventType:
      | 'CHAT_MESSAGE_RECEIVED'
      | 'CHAT_MENTION'
      | 'CHAT_ORDER_SHARED'
      | 'CHAT_PRODUCT_SHARED';
    recipientId: string;
    conversationId: string;
    senderId: string;
    senderName: string;
    messageText?: string;
    messageType?: string;
    productName?: string;
    orderNumber?: string;
    recipientType?: AppType;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `chat_${params.conversationId}_${params.recipientId}_${Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.CHAT,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: params.recipientType || AppType.CUSTOMER,
      entityType: 'chat',
      entityId: params.conversationId,
      data: {
        conversationId: params.conversationId,
        senderId: params.senderId,
        senderName: params.senderName,
        messageText: params.messageText,
        messageType: params.messageType || 'text',
        productName: params.productName,
        orderNumber: params.orderNumber,
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }

  // ── Security & System Alerts ──────────────────────────────────────────────
  static securityEvent(params: {
    eventType:
      | 'NEW_LOGIN'
      | 'NEW_DEVICE'
      | 'PASSWORD_CHANGED'
      | 'EMAIL_CHANGED'
      | 'PHONE_CHANGED'
      | 'SUSPICIOUS_LOGIN'
      | 'TWO_FACTOR_EVENT';
    recipientId: string;
    ipAddress?: string;
    deviceInfo?: string;
    location?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `sec_${params.recipientId}_${params.eventType}_${Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.SECURITY,
      priority: NotificationPriority.URGENT,
      recipientId: params.recipientId,
      recipientType: AppType.CUSTOMER,
      entityType: 'security',
      entityId: params.recipientId,
      data: {
        ipAddress: params.ipAddress,
        deviceInfo: params.deviceInfo,
        location: params.location,
      },
      bypassQuietHours: true,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Admin Alerts ──────────────────────────────────────────────────────────
  static adminAlertEvent(params: {
    eventType:
      | 'ADMIN_ALERT'
      | 'NEW_SELLER_REGISTRATION'
      | 'REFUND_DISPUTE'
      | 'HIGH_ERROR_RATE'
      | 'FRAUD_ALERT';
    recipientId: string;
    titleAr: string;
    titleEn: string;
    messageAr: string;
    messageEn: string;
    referenceId?: string;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `admin_${params.recipientId}_${params.eventType}_${Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.ADMIN,
      priority: NotificationPriority.HIGH,
      recipientId: params.recipientId,
      recipientType: AppType.ADMIN,
      entityType: 'admin',
      entityId: params.referenceId,
      data: {
        titleAr: params.titleAr,
        titleEn: params.titleEn,
        messageAr: params.messageAr,
        messageEn: params.messageEn,
        referenceId: params.referenceId,
      },
      bypassQuietHours: true,
      bypassRateLimit: true,
      createdAt: new Date(),
    };
  }

  // ── Reviews ───────────────────────────────────────────────────────────────
  static reviewEvent(params: {
    eventType: 'NEW_REVIEW_RECEIVED' | 'SELLER_RESPONDED_TO_REVIEW';
    recipientId: string;
    recipientType: AppType;
    productId: string;
    productNameAr: string;
    productNameEn?: string;
    reviewId?: string;
    rating?: number;
  }): DomainNotificationEvent {
    return {
      eventId: randomUUID(),
      idempotencyKey: `review_${params.productId}_${params.recipientId}_${params.eventType}_${params.reviewId || Date.now()}`,
      eventType: params.eventType,
      category: NotificationCategory.REVIEW,
      priority: NotificationPriority.NORMAL,
      recipientId: params.recipientId,
      recipientType: params.recipientType,
      entityType: 'review',
      entityId: params.productId,
      data: {
        productId: params.productId,
        productName: params.productNameAr,
        productNameAr: params.productNameAr,
        productNameEn: params.productNameEn || params.productNameAr,
        reviewId: params.reviewId,
        rating: params.rating,
      },
      bypassQuietHours: false,
      bypassRateLimit: false,
      createdAt: new Date(),
    };
  }
}
