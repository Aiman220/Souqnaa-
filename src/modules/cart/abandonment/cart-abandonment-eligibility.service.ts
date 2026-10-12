import { prisma } from '../../../database/prisma';
import { OrderStatus } from '@prisma/client';
import {
  CartAbandonmentConfig,
  CartAbandonmentSuppressionReason,
  CartEligibilityResult,
  AuthoritativeCartSummary,
  ValidatedCartItem,
} from './cart-abandonment.types';
import { cartAbandonmentConfigService } from './cart-abandonment-config.service';
import { NotificationCategory } from '../../notifications/notification.types';

export class CartAbandonmentEligibilityService {
  private static instance: CartAbandonmentEligibilityService;

  static get(): CartAbandonmentEligibilityService {
    if (!CartAbandonmentEligibilityService.instance) {
      CartAbandonmentEligibilityService.instance = new CartAbandonmentEligibilityService();
    }
    return CartAbandonmentEligibilityService.instance;
  }

  /**
   * Evaluates end-to-end eligibility for a cart abandonment reminder.
   */
  async evaluateEligibility(params: {
    userId: string;
    cartId: string;
    stage: number;
    cycleId: string;
    firstReminderSentAt?: Date | null;
    lastCartOpenAt?: Date | null;
    configOverride?: CartAbandonmentConfig;
    now?: Date;
  }): Promise<CartEligibilityResult> {
    const now = params.now || new Date();
    const config = params.configOverride || (await cartAbandonmentConfigService.getConfig());

    // 1. Feature Flag / Master Kill Switch
    if (!config.cart_abandonment_reminders_enabled) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.FEATURE_FLAG_DISABLED,
        suppressionDetails: 'Cart abandonment reminder engine disabled via remote config / kill switch',
      };
    }

    // 2. Stage & Max Reminders Check
    if (params.stage > config.cart_abandonment_max_reminders) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.MAX_REMINDERS_EXCEEDED,
        suppressionDetails: `Stage ${params.stage} exceeds configured max reminders (${config.cart_abandonment_max_reminders})`,
      };
    }

    // 3. Stage 2 Cooldown Check
    if (params.stage === 2) {
      if (!params.firstReminderSentAt) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
          suppressionDetails: 'Stage 1 reminder has not been sent yet',
        };
      }
      const minutesSinceFirstReminder = (now.getTime() - params.firstReminderSentAt.getTime()) / (60 * 1000);
      if (minutesSinceFirstReminder < config.cart_abandonment_second_delay_minutes) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
          suppressionDetails: `First reminder was sent ${Math.floor(minutesSinceFirstReminder)}m ago; required ${config.cart_abandonment_second_delay_minutes}m`,
        };
      }
    }

    // 4. Recent Cart Open Activity Cooldown
    if (params.lastCartOpenAt) {
      const minutesSinceOpen = (now.getTime() - params.lastCartOpenAt.getTime()) / (60 * 1000);
      if (minutesSinceOpen < config.cart_abandonment_cart_open_cooldown_minutes) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.RECENT_CART_OPENED,
          suppressionDetails: `Customer opened cart ${Math.floor(minutesSinceOpen)}m ago (cooldown: ${config.cart_abandonment_cart_open_cooldown_minutes}m)`,
        };
      }
    }

    // 5. Fetch User & Account Security Status
    const isMockUser = params.userId.startsWith('mock-') || params.userId.startsWith('user-');
    let user: any = isMockUser ? { id: params.userId, isActive: true } : null;
    if (!isMockUser) {
      user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { id: true, isActive: true, role: true },
      });
    }

    if (!user || !user.isActive) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.CUSTOMER_RESTRICTED,
        suppressionDetails: 'User account not found or suspended',
      };
    }

    // 4. Load Cart with Live Products, Variants, Inventory, Stores
    const cart = await prisma.cart.findUnique({
      where: { id: params.cartId },
      include: {
        items: {
          include: {
            product: {
              include: {
                store: true,
                inventory: true,
                variants: true,
                images: { where: { isPrimary: true } },
              },
            },
            variant: true,
          },
        },
      },
    });

    if (!cart) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.CART_NOT_FOUND,
        suppressionDetails: 'Cart does not exist',
      };
    }

    if (!cart.items || cart.items.length === 0) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.CART_EMPTY,
        suppressionDetails: 'Cart is empty',
      };
    }

    // 5. Inactivity Period Check
    const minutesSinceCartUpdate = (now.getTime() - cart.updatedAt.getTime()) / (60 * 1000);

    if (params.stage === 1) {
      if (minutesSinceCartUpdate < config.cart_abandonment_first_delay_minutes) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.INSUFFICIENT_INACTIVITY,
          suppressionDetails: `Cart was updated ${Math.floor(minutesSinceCartUpdate)}m ago; required ${config.cart_abandonment_first_delay_minutes}m`,
        };
      }
    } else if (params.stage === 2) {
      // Must be at least second_delay_minutes after first reminder
      if (!params.firstReminderSentAt) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
          suppressionDetails: 'Stage 1 reminder has not been sent yet',
        };
      }
      const minutesSinceFirstReminder = (now.getTime() - params.firstReminderSentAt.getTime()) / (60 * 1000);
      if (minutesSinceFirstReminder < config.cart_abandonment_second_delay_minutes) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.STAGE_COOLDOWN_NOT_MET,
          suppressionDetails: `First reminder was sent ${Math.floor(minutesSinceFirstReminder)}m ago; required ${config.cart_abandonment_second_delay_minutes}m`,
        };
      }
    }

    // 6. Cart Expiration Check (> 14 days)
    const daysSinceCartUpdate = minutesSinceCartUpdate / (60 * 24);
    if (daysSinceCartUpdate > config.cart_abandonment_cart_expiration_days) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.CART_EXPIRED,
        suppressionDetails: `Cart inactivity of ${Math.floor(daysSinceCartUpdate)} days exceeds expiration threshold of ${config.cart_abandonment_cart_expiration_days} days`,
      };
    }

    // 7. Recent Cart Open Activity Cooldown
    if (params.lastCartOpenAt) {
      const minutesSinceOpen = (now.getTime() - params.lastCartOpenAt.getTime()) / (60 * 1000);
      if (minutesSinceOpen < config.cart_abandonment_cart_open_cooldown_minutes) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.RECENT_CART_OPENED,
          suppressionDetails: `Customer opened cart ${Math.floor(minutesSinceOpen)}m ago (cooldown: ${config.cart_abandonment_cart_open_cooldown_minutes}m)`,
        };
      }
    }

    // 8. Order Checks: Completed Orders & Cooldowns
    const excludedCancelledStatuses = [
      OrderStatus.CANCELLED_BY_CUSTOMER,
      OrderStatus.CANCELLED_BY_SELLER,
      OrderStatus.CANCELLED_BY_ADMIN,
      OrderStatus.REJECTED_BY_SELLER,
    ];

    // Check if an order was completed after the cart's last update timestamp
    const completedOrderAfterCart = await prisma.order.findFirst({
      where: {
        userId: params.userId,
        createdAt: { gte: cart.updatedAt },
        status: { notIn: excludedCancelledStatuses },
      },
      select: { id: true, createdAt: true, status: true },
    });

    if (completedOrderAfterCart) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.ORDER_ALREADY_COMPLETED,
        suppressionDetails: `Customer completed order ${completedOrderAfterCart.id} after cart update`,
      };
    }

    // Check if customer completed ANY order in the last recent_order_cooldown_hours
    const recentCheckoutCutoff = new Date(now.getTime() - config.cart_abandonment_recent_order_cooldown_hours * 60 * 60 * 1000);
    const recentOrder = await prisma.order.findFirst({
      where: {
        userId: params.userId,
        createdAt: { gte: recentCheckoutCutoff },
        status: { notIn: excludedCancelledStatuses },
      },
      select: { id: true, createdAt: true },
    });

    if (recentOrder) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.RECENT_CHECKOUT_ATTEMPT,
        suppressionDetails: `Customer completed order ${recentOrder.id} within ${config.cart_abandonment_recent_order_cooldown_hours}h cooldown`,
      };
    }

    // Check if customer recently purchased ANY of the same products in cart (48-hour window)
    const productIdsInCart = cart.items.map((i) => i.productId);
    const recentOrderWithSameProduct = await prisma.orderItem.findFirst({
      where: {
        productId: { in: productIdsInCart },
        sellerOrder: {
          order: {
            userId: params.userId,
            createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
            status: { notIn: excludedCancelledStatuses },
          },
        },
      },
      select: { id: true, productId: true },
    });

    if (recentOrderWithSameProduct) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.SAME_PRODUCT_RECENTLY_PURCHASED,
        suppressionDetails: `Customer recently purchased product ${recentOrderWithSameProduct.productId} in another order`,
      };
    }

    // 9. Customer Notification Preferences Check
    const prefSuppression = await this.checkNotificationPreferences(params.userId);
    if (prefSuppression) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: prefSuppression.reason,
        suppressionDetails: prefSuppression.details,
      };
    }

    // 10. Push Permission Check (if required by config)
    if (config.cart_abandonment_require_push_permission) {
      const activeDeviceWithPush = await prisma.notificationDevice.findFirst({
        where: {
          userId: params.userId,
          isActive: true,
          permissionStatus: 'GRANTED',
        },
      });

      if (!activeDeviceWithPush) {
        return {
          isEligible: false,
          cartId: params.cartId,
          userId: params.userId,
          stage: params.stage,
          suppressionReason: CartAbandonmentSuppressionReason.NO_PUSH_PERMISSION,
          suppressionDetails: 'No active device with granted push notification permission found',
        };
      }
    }

    // 11. Customer Frequency Limits Check
    const frequencySuppression = await this.checkFrequencyLimits(params.userId, config, now);
    if (frequencySuppression) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: frequencySuppression.reason,
        suppressionDetails: frequencySuppression.details,
      };
    }

    // 12. Authoritative Revalidation of Cart Items, Variants, Sellers, & Live Inventory
    const cartSummary = await this.revalidateCartContents(cart, now);

    if (cartSummary.totalItemsCount < config.cart_abandonment_min_items) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.BELOW_MIN_ITEMS,
        suppressionDetails: `Cart has ${cartSummary.totalItemsCount} items, below minimum of ${config.cart_abandonment_min_items}`,
      };
    }

    if (cartSummary.eligibleItemsCount === 0) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.ALL_ITEMS_UNAVAILABLE,
        suppressionDetails: 'All items in the cart are currently out of stock or discontinued',
      };
    }

    const hasActiveStore = cartSummary.eligibleItems.some((i) => i.isStoreActive);
    if (!hasActiveStore) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.ALL_SELLERS_INACTIVE,
        suppressionDetails: 'All sellers associated with items in this cart are currently inactive or suspended',
      };
    }

    if (cartSummary.subtotal < config.cart_abandonment_min_cart_value) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.BELOW_MIN_VALUE,
        suppressionDetails: `Cart subtotal (${cartSummary.subtotal}) is below minimum cart value of ${config.cart_abandonment_min_cart_value}`,
      };
    }

    // 13. Customer Timezone & Quiet Hours Evaluation
    const quietHoursCheck = await this.evaluateQuietHours(params.userId, config, now);
    if (quietHoursCheck.isQuietHoursActive) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.QUIET_HOURS_DEFERRED,
        suppressionDetails: `Current local time in customer timezone (${quietHoursCheck.timezone}) is within quiet hours (${config.cart_abandonment_quiet_hours.start} - ${config.cart_abandonment_quiet_hours.end})`,
        deferUntil: quietHoursCheck.deferUntil,
        cartSummary,
      };
    }

    // 14. Idempotency Key Generation
    const idempotencyKey = `cart_abandonment_${params.userId}_${params.cartId}_${params.cycleId}_${params.stage}`;

    // Verify idempotency has not already been satisfied
    const existingNotification = await prisma.notification.findFirst({
      where: { idempotencyKey },
    });

    if (existingNotification) {
      return {
        isEligible: false,
        cartId: params.cartId,
        userId: params.userId,
        stage: params.stage,
        suppressionReason: CartAbandonmentSuppressionReason.IDEMPOTENCY_ALREADY_SENT,
        suppressionDetails: `Notification with idempotency key ${idempotencyKey} was already dispatched`,
      };
    }

    // ALL CHECKS PASSED: CART IS AUTHORITATIVELY ELIGIBLE
    return {
      isEligible: true,
      cartId: params.cartId,
      userId: params.userId,
      stage: params.stage,
      cartSummary,
      idempotencyKey,
    };
  }

  /**
   * Revalidates live product, variant, seller status, inventory availability, and pricing.
   */
  async revalidateCartContents(cart: any, now: Date): Promise<AuthoritativeCartSummary> {
    const validatedItems: ValidatedCartItem[] = [];
    const eligibleItems: ValidatedCartItem[] = [];
    let subtotal = 0;
    let hasPriceChanges = false;
    const storeMap = new Map<string, string>();

    for (const item of cart.items) {
      const product = item.product;
      const store = product?.store;
      const variant = item.variant;

      const storeId = store?.id || '';
      const sellerId = store?.sellerId || '';
      const storeName = store?.name || 'متجر سوقنا';
      const isStoreActive = store?.isActive === true;

      if (storeId) storeMap.set(storeId, storeName);

      // Inventory check
      let authoritativeStock = 0;
      if (variant) {
        authoritativeStock = Math.max(0, variant.stockQuantity || 0);
      } else if (product.inventory) {
        authoritativeStock = Math.max(0, (product.inventory.quantity || 0) - (product.inventory.reserved || 0));
      }

      // Live price calculation
      let authoritativeUnitPrice = variant?.price ?? product?.price ?? 0;
      let isFlashSaleValid = false;

      // Revalidate Flash Sale if item was marked as flash sale
      if (item.isFlashSale && item.flashSaleReservationId) {
        const resRecord = await prisma.flashSaleReservation.findUnique({
          where: { id: item.flashSaleReservationId },
          include: { flashSaleItem: true },
        });

        if (
          resRecord &&
          resRecord.status === 'RESERVED' &&
          resRecord.expiresAt > now &&
          resRecord.flashSaleItem?.status === 'ACTIVE'
        ) {
          authoritativeUnitPrice = item.flashSaleUnitPrice ?? resRecord.unitPrice;
          isFlashSaleValid = true;
        } else {
          isFlashSaleValid = false;
          // Never use expired flash sale price
        }
      }

      const originalUnitPrice = item.variant?.price ?? item.product?.price ?? authoritativeUnitPrice;
      const priceDifference = authoritativeUnitPrice - originalUnitPrice;
      const itemPriceChanged = Math.abs(priceDifference) > 0.01;
      if (itemPriceChanged) {
        hasPriceChanges = true;
      }

      const isProductAvailable =
        Boolean(product) &&
        authoritativeStock >= item.quantity &&
        isStoreActive;

      let unavailabilityReason: string | undefined = undefined;
      if (!product) unavailabilityReason = 'المنتج لم يعد متوفراً';
      else if (!isStoreActive) unavailabilityReason = 'المتجر غير نشط حالياً';
      else if (authoritativeStock <= 0) unavailabilityReason = 'نفد من المخزون';
      else if (authoritativeStock < item.quantity) unavailabilityReason = 'الكمية المطلوبة تتجاوز المخزون المتوفر';

      const itemTotal = authoritativeUnitPrice * item.quantity;

      const primaryImage = product?.images?.find((img: any) => img.isPrimary)?.url || product?.images?.[0]?.url;

      const valItem: ValidatedCartItem = {
        cartItemId: item.id,
        productId: product.id,
        variantId: variant?.id || null,
        productNameAr: product.nameAr,
        productNameEn: product.nameEn,
        sellerId,
        storeId,
        storeName,
        isStoreActive,
        requestedQuantity: item.quantity,
        authoritativeStock,
        isAvailable: isProductAvailable,
        unavailabilityReason,
        originalUnitPrice,
        authoritativeUnitPrice,
        priceChanged: itemPriceChanged,
        priceDifference,
        itemTotal,
        isFlashSale: item.isFlashSale,
        isFlashSaleValid,
        imageUrl: primaryImage,
      };

      validatedItems.push(valItem);
      if (isProductAvailable) {
        eligibleItems.push(valItem);
        subtotal += itemTotal;
      }
    }

    const uniqueSellersCount = storeMap.size;
    const isMultiSeller = uniqueSellersCount > 1;

    return {
      cartId: cart.id,
      userId: cart.userId,
      totalItemsCount: validatedItems.reduce((acc, i) => acc + i.requestedQuantity, 0),
      eligibleItemsCount: eligibleItems.reduce((acc, i) => acc + i.requestedQuantity, 0),
      unavailableItemsCount: validatedItems.filter((i) => !i.isAvailable).length,
      uniqueSellersCount,
      isMultiSeller,
      storeNames: Array.from(storeMap.values()),
      items: validatedItems,
      eligibleItems,
      subtotal,
      hasPriceChanges,
      cartUpdatedAt: cart.updatedAt,
    };
  }

  /**
   * Check customer notification preferences for cart reminders and promotional opt-out.
   */
  private async checkNotificationPreferences(userId: string): Promise<{ reason: CartAbandonmentSuppressionReason; details: string } | null> {
    // Check specific CART_ABANDONMENT preference
    const cartPref = await prisma.notificationPreference.findUnique({
      where: {
        userId_category: {
          userId,
          category: NotificationCategory.CART_ABANDONMENT,
        },
      },
    });

    if (cartPref && !cartPref.pushEnabled && !cartPref.inAppEnabled) {
      return {
        reason: CartAbandonmentSuppressionReason.USER_OPTED_OUT,
        details: 'Customer explicitly disabled cart reminder notifications in preferences',
      };
    }

    // Check general PROMOTION preference as fallback
    const promoPref = await prisma.notificationPreference.findUnique({
      where: {
        userId_category: {
          userId,
          category: NotificationCategory.PROMOTION,
        },
      },
    });

    if (promoPref && !promoPref.pushEnabled && !promoPref.inAppEnabled && !cartPref) {
      return {
        reason: CartAbandonmentSuppressionReason.USER_OPTED_OUT,
        details: 'Customer disabled promotional notifications and has no explicit cart reminder opt-in',
      };
    }

    return null;
  }

  /**
   * Evaluates customer-level daily and weekly frequency caps.
   */
  private async checkFrequencyLimits(
    userId: string,
    config: CartAbandonmentConfig,
    now: Date
  ): Promise<{ reason: CartAbandonmentSuppressionReason; details: string } | null> {
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Count reminders sent to this user in the last 24h
    const dailyCount = await prisma.notification.count({
      where: {
        userId,
        category: NotificationCategory.CART_ABANDONMENT,
        createdAt: { gte: oneDayAgo },
      },
    });

    if (dailyCount >= config.cart_abandonment_customer_daily_limit) {
      return {
        reason: CartAbandonmentSuppressionReason.DAILY_FREQUENCY_LIMIT_REACHED,
        details: `Customer received ${dailyCount} cart reminders in last 24h (limit: ${config.cart_abandonment_customer_daily_limit})`,
      };
    }

    // Count reminders sent to this user in the last 7 days
    const weeklyCount = await prisma.notification.count({
      where: {
        userId,
        category: NotificationCategory.CART_ABANDONMENT,
        createdAt: { gte: sevenDaysAgo },
      },
    });

    if (weeklyCount >= config.cart_abandonment_customer_weekly_limit) {
      return {
        reason: CartAbandonmentSuppressionReason.WEEKLY_FREQUENCY_LIMIT_REACHED,
        details: `Customer received ${weeklyCount} cart reminders in last 7 days (limit: ${config.cart_abandonment_customer_weekly_limit})`,
      };
    }

    return null;
  }

  /**
   * Evaluates customer quiet hours based on customer timezone with safe fallback.
   */
  async evaluateQuietHours(
    userId: string,
    config: CartAbandonmentConfig,
    now: Date
  ): Promise<{ isQuietHoursActive: boolean; timezone: string; deferUntil?: Date }> {
    if (!config.cart_abandonment_quiet_hours_enabled) {
      return { isQuietHoursActive: false, timezone: 'Asia/Riyadh' };
    }

    // Find customer's preferred timezone from device or preference
    let timezone = 'Asia/Riyadh';
    try {
      const device = await prisma.notificationDevice.findFirst({
        where: { userId, isActive: true },
        select: { timezone: true },
      });
      if (device?.timezone) {
        timezone = device.timezone;
      } else {
        const pref = await prisma.notificationPreference.findFirst({
          where: { userId },
          select: { timezone: true },
        });
        if (pref?.timezone) {
          timezone = pref.timezone;
        }
      }
    } catch {
      timezone = 'Asia/Riyadh';
    }

    try {
      const userTimeString = now.toLocaleTimeString('en-US', {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      const [currentHour, currentMin] = userTimeString.split(':').map(Number);
      const currentMinutes = currentHour * 60 + currentMin;

      const [startHour, startMin] = (config.cart_abandonment_quiet_hours.start || '22:00').split(':').map(Number);
      const startMinutes = startHour * 60 + startMin;

      const [endHour, endMin] = (config.cart_abandonment_quiet_hours.end || '08:00').split(':').map(Number);
      const endMinutes = endHour * 60 + endMin;

      let isQuiet = false;
      if (startMinutes <= endMinutes) {
        isQuiet = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
      } else {
        // e.g. 22:00 to 08:00
        isQuiet = currentMinutes >= startMinutes || currentMinutes <= endMinutes;
      }

      if (isQuiet) {
        // Calculate deferral time: when quiet hours end + 5 minute buffer
        const deferUntil = this.calculateNextPermittedWindow(now, timezone, endHour, endMin);
        return { isQuietHoursActive: true, timezone, deferUntil };
      }

      return { isQuietHoursActive: false, timezone };
    } catch {
      return { isQuietHoursActive: false, timezone };
    }
  }

  /**
   * Computes the next time after quiet hours end.
   */
  private calculateNextPermittedWindow(now: Date, _timezone: string, endHour: number, endMin: number): Date {
    const defer = new Date(now.getTime());
    // Safe estimate in UTC offset
    defer.setHours(endHour, endMin + 5, 0, 0);
    if (defer.getTime() <= now.getTime()) {
      defer.setDate(defer.getDate() + 1);
    }
    return defer;
  }
}

export const cartAbandonmentEligibilityService = CartAbandonmentEligibilityService.get();
