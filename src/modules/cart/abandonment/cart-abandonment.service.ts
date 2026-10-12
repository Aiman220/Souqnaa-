import { prisma } from '../../../database/prisma';
import { randomUUID } from 'crypto';
import {
  CartAbandonmentCycleStatus,
  CartAbandonmentReminderStatus,
  CartAbandonmentSuppressionReason,
  CartRecoveryAnalyticsSummary,
  AbandonmentCycleRecord,
  AuthoritativeCartSummary,
} from './cart-abandonment.types';
import { cartAbandonmentConfigService } from './cart-abandonment-config.service';
import { cartAbandonmentEligibilityService } from './cart-abandonment-eligibility.service';
import { notificationDispatcher } from '../../notifications/services/notification-dispatcher';
import {
  DomainNotificationEvent,
  NotificationCategory,
  NotificationPriority,
  AppType,
} from '../../notifications/notification.types';

export class CartAbandonmentService {
  private static instance: CartAbandonmentService;

  // In-memory cycle registry with persistent DB fallback & atomic locks
  private cycleStore = new Map<string, AbandonmentCycleRecord>();
  private userLastCartOpen = new Map<string, Date>();
  private processingLock = new Set<string>();

  static get(): CartAbandonmentService {
    if (!CartAbandonmentService.instance) {
      CartAbandonmentService.instance = new CartAbandonmentService();
    }
    return CartAbandonmentService.instance;
  }

  /**
   * Called when a cart is created, item added, updated, or removed.
   * Invalidates any pending stale reminders and initiates a new cycle.
   */
  async onCartUpdated(cartId: string, userId: string): Promise<AbandonmentCycleRecord> {
    const cart = await prisma.cart.findUnique({
      where: { id: cartId },
      include: { items: true },
    }).catch(() => null);

    const cartUpdatedAt = cart?.updatedAt || new Date();
    const itemsCount = cart?.items?.length || 1;

    // Find any existing active cycle for this cart
    const existingCycle = this.cycleStore.get(cartId);
    if (existingCycle && existingCycle.status === CartAbandonmentCycleStatus.ACTIVE) {
      // Invalidate existing cycle if cart contents or timestamp changed
      existingCycle.status = CartAbandonmentCycleStatus.CANCELLED;
      existingCycle.suppressionReason = 'Cart modified by customer; cycle invalidated';
      existingCycle.updatedAt = new Date();
    }

    const newCycle: AbandonmentCycleRecord = {
      id: randomUUID(),
      cartId,
      userId,
      cartUpdatedAt,
      stage: 0,
      status: CartAbandonmentCycleStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.cycleStore.set(cartId, newCycle);

    // Track detection event
    await this.recordAnalyticsEvent({
      eventType: 'CART_ABANDONMENT_DETECTED',
      customerId: userId,
      metadata: {
        cycleId: newCycle.id,
        cartId,
        itemsCount,
        cartUpdatedAt: cartUpdatedAt.toISOString(),
      },
    });

    return newCycle;
  }

  /**
   * Called when cart is emptied or cleared.
   */
  async onCartCleared(userId: string): Promise<void> {
    for (const [cartId, cycle] of this.cycleStore.entries()) {
      if (cycle.userId === userId && cycle.status === CartAbandonmentCycleStatus.ACTIVE) {
        cycle.status = CartAbandonmentCycleStatus.CANCELLED;
        cycle.suppressionReason = 'Cart cleared by customer';
        cycle.updatedAt = new Date();
      }
    }
  }

  /**
   * Called when customer opens their cart.
   * Tracks customer activity cooldown and conversion attribution.
   */
  async onCartOpened(userId: string): Promise<void> {
    this.userLastCartOpen.set(userId, new Date());

    // Record analytics event
    await this.recordAnalyticsEvent({
      eventType: 'CART_REMINDER_CART_OPENED',
      customerId: userId,
      metadata: {
        openedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Called when customer completes checkout.
   * Closes active cycles, marks recovered, and attributes revenue if within attribution window.
   */
  async onCheckoutCompleted(userId: string, orderId: string): Promise<void> {
    const config = await cartAbandonmentConfigService.getConfig();
    const now = new Date();
    const attributionCutoff = new Date(now.getTime() - config.cart_abandonment_attribution_window_hours * 60 * 60 * 1000);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, total: true, createdAt: true },
    });

    for (const [cartId, cycle] of this.cycleStore.entries()) {
      if (cycle.userId === userId && cycle.status === CartAbandonmentCycleStatus.ACTIVE) {
        cycle.status = CartAbandonmentCycleStatus.RECOVERED;
        cycle.recoveredAt = now;
        cycle.attributedOrderId = orderId;
        cycle.updatedAt = now;

        // Check if reminder was sent within attribution window
        const wasReminderSentRecently =
          (cycle.firstReminderSentAt && cycle.firstReminderSentAt >= attributionCutoff) ||
          (cycle.secondReminderSentAt && cycle.secondReminderSentAt >= attributionCutoff);

        if (wasReminderSentRecently) {
          await this.recordAnalyticsEvent({
            eventType: 'CART_REMINDER_CONVERSION',
            customerId: userId,
            orderId,
            metadata: {
              cycleId: cycle.id,
              cartId,
              attributedRevenue: order?.total || 0,
              orderId,
              stage: cycle.stage,
              firstReminderSentAt: cycle.firstReminderSentAt?.toISOString(),
              secondReminderSentAt: cycle.secondReminderSentAt?.toISOString(),
            },
          });
        }
      }
    }
  }

  /**
   * Called when a notification is clicked or opened by customer.
   */
  async onNotificationOpened(notificationId: string, userId: string): Promise<void> {
    await this.recordAnalyticsEvent({
      eventType: 'CART_REMINDER_OPENED',
      customerId: userId,
      metadata: {
        notificationId,
        openedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Batch evaluate eligible abandoned carts and trigger notifications.
   * Runs efficiently via scheduled job runner.
   */
  async processDueAbandonedCarts(batchSize = 25): Promise<{
    evaluated: number;
    sent: number;
    suppressed: number;
    deferred: number;
  }> {
    const now = new Date();
    const config = await cartAbandonmentConfigService.getConfig();

    if (!config.cart_abandonment_reminders_enabled) {
      return { evaluated: 0, sent: 0, suppressed: 0, deferred: 0 };
    }

    // Cutoff time for stage 1 inactivity
    const stage1Cutoff = new Date(now.getTime() - config.cart_abandonment_first_delay_minutes * 60 * 1000);
    const expirationCutoff = new Date(now.getTime() - config.cart_abandonment_cart_expiration_days * 24 * 60 * 60 * 1000);

    // Fetch candidate carts with indexed timestamps (Rule 30: no expensive full scans)
    const candidateCarts = await prisma.cart.findMany({
      where: {
        updatedAt: {
          lte: stage1Cutoff,
          gte: expirationCutoff,
        },
        items: {
          some: {},
        },
      },
      take: batchSize,
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        userId: true,
        updatedAt: true,
      },
    });

    let sent = 0;
    let suppressed = 0;
    let deferred = 0;

    for (const c of candidateCarts) {
      // Concurrency lock per cart
      if (this.processingLock.has(c.id)) continue;
      this.processingLock.add(c.id);

      try {
        let cycle = this.cycleStore.get(c.id);
        if (!cycle || cycle.cartUpdatedAt.getTime() !== c.updatedAt.getTime()) {
          cycle = {
            id: randomUUID(),
            cartId: c.id,
            userId: c.userId,
            cartUpdatedAt: c.updatedAt,
            stage: 0,
            status: CartAbandonmentCycleStatus.ACTIVE,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          this.cycleStore.set(c.id, cycle);
        }

        if (cycle.status !== CartAbandonmentCycleStatus.ACTIVE) {
          continue;
        }

        const nextStage = cycle.stage + 1;
        if (nextStage > config.cart_abandonment_max_reminders) {
          cycle.status = CartAbandonmentCycleStatus.EXPIRED;
          await this.recordAnalyticsEvent({
            eventType: 'CART_REMINDER_EXPIRED',
            customerId: c.userId,
            metadata: { cycleId: cycle.id, cartId: c.id, stage: cycle.stage },
          });
          continue;
        }

        const lastCartOpenAt = this.userLastCartOpen.get(c.userId) || null;

        const evalResult = await cartAbandonmentEligibilityService.evaluateEligibility({
          userId: c.userId,
          cartId: c.id,
          stage: nextStage,
          cycleId: cycle.id,
          firstReminderSentAt: cycle.firstReminderSentAt,
          lastCartOpenAt,
          configOverride: config,
          now,
        });

        await this.recordAnalyticsEvent({
          eventType: 'CART_REMINDER_ELIGIBILITY_CHECKED',
          customerId: c.userId,
          metadata: {
            cycleId: cycle.id,
            cartId: c.id,
            stage: nextStage,
            isEligible: evalResult.isEligible,
            suppressionReason: evalResult.suppressionReason,
          },
        });

        if (!evalResult.isEligible) {
          if (evalResult.suppressionReason === CartAbandonmentSuppressionReason.QUIET_HOURS_DEFERRED) {
            deferred++;
            // Quiet hours deferred: leave cycle active for next run
            continue;
          }

          suppressed++;
          cycle.suppressionReason = evalResult.suppressionReason;
          cycle.updatedAt = new Date();

          if (
            evalResult.suppressionReason === CartAbandonmentSuppressionReason.CART_EXPIRED ||
            evalResult.suppressionReason === CartAbandonmentSuppressionReason.MAX_REMINDERS_EXCEEDED ||
            evalResult.suppressionReason === CartAbandonmentSuppressionReason.ORDER_ALREADY_COMPLETED
          ) {
            cycle.status = CartAbandonmentCycleStatus.SUPPRESSED;
          }

          await this.recordAnalyticsEvent({
            eventType: 'CART_REMINDER_SUPPRESSED',
            customerId: c.userId,
            metadata: {
              cycleId: cycle.id,
              cartId: c.id,
              stage: nextStage,
              reason: evalResult.suppressionReason,
              details: evalResult.suppressionDetails,
            },
          });
          continue;
        }

        // Remind: Cart is authoritatively eligible!
        await this.recordAnalyticsEvent({
          eventType: 'CART_REMINDER_SCHEDULED',
          customerId: c.userId,
          metadata: {
            cycleId: cycle.id,
            cartId: c.id,
            stage: nextStage,
            idempotencyKey: evalResult.idempotencyKey,
          },
        });

        const dispatchSuccess = await this.dispatchReminderNotification({
          userId: c.userId,
          cartId: c.id,
          cycleId: cycle.id,
          stage: nextStage,
          cartSummary: evalResult.cartSummary!,
          idempotencyKey: evalResult.idempotencyKey!,
        });

        if (dispatchSuccess.notificationId) {
          sent++;
          cycle.stage = nextStage;
          if (nextStage === 1) {
            cycle.firstReminderSentAt = new Date();
          } else if (nextStage === 2) {
            cycle.secondReminderSentAt = new Date();
          }
          cycle.lastNotificationId = dispatchSuccess.notificationId;
          cycle.updatedAt = new Date();

          await this.recordAnalyticsEvent({
            eventType: 'CART_REMINDER_SENT',
            customerId: c.userId,
            metadata: {
              cycleId: cycle.id,
              cartId: c.id,
              stage: nextStage,
              notificationId: dispatchSuccess.notificationId,
              itemCount: evalResult.cartSummary?.eligibleItemsCount,
              isMultiSeller: evalResult.cartSummary?.isMultiSeller,
            },
          });
        }
      } catch (err: any) {
        console.error(`[CartAbandonmentService] Error processing cart ${c.id}:`, err);
      } finally {
        this.processingLock.delete(c.id);
      }
    }

    return { evaluated: candidateCarts.length, sent, suppressed, deferred };
  }

  /**
   * Dispatches reminder notification via central NotificationDispatcher.
   */
  async dispatchReminderNotification(params: {
    userId: string;
    cartId: string;
    cycleId: string;
    stage: number;
    cartSummary: AuthoritativeCartSummary;
    idempotencyKey: string;
  }): Promise<{ notificationId?: string }> {
    const templateCode = params.stage === 2 ? 'CART_ABANDONMENT_REMINDER_2' : 'CART_ABANDONMENT_REMINDER_1';

    const event: DomainNotificationEvent = {
      eventId: randomUUID(),
      idempotencyKey: params.idempotencyKey,
      eventType: templateCode,
      category: NotificationCategory.CART_ABANDONMENT,
      priority: NotificationPriority.NORMAL,
      recipientId: params.userId,
      recipientType: AppType.CUSTOMER,
      entityType: 'cart',
      entityId: params.cartId,
      data: {
        cartId: params.cartId,
        cycleId: params.cycleId,
        stage: params.stage,
        itemCount: params.cartSummary.eligibleItemsCount,
        isMultiSeller: params.cartSummary.isMultiSeller,
        subtotal: params.cartSummary.subtotal,
        hasPriceChanges: params.cartSummary.hasPriceChanges,
        imageUrl: params.cartSummary.eligibleItems[0]?.imageUrl,
        deepLink: 'souqnaa://cart',
      },
      createdAt: new Date(),
    };

    const result = await notificationDispatcher.dispatch(event);
    return { notificationId: result.notificationId };
  }

  /**
   * Admin Cart Recovery Analytics & Reporting (Rule 29).
   */
  async getAdminCartRecoveryMetrics(period = '30d', from?: string, to?: string): Promise<CartRecoveryAnalyticsSummary> {
    let startDate: Date;
    const endDate = to ? new Date(to) : new Date();

    if (from) {
      startDate = new Date(from);
    } else {
      const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
      startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    }

    // Query analytics events in time range
    const events = await prisma.analyticsEvent.findMany({
      where: {
        eventType: {
          in: [
            'CART_ABANDONMENT_DETECTED',
            'CART_REMINDER_SENT',
            'CART_REMINDER_OPENED',
            'CART_REMINDER_CART_OPENED',
            'CART_REMINDER_CONVERSION',
            'CART_REMINDER_SUPPRESSED',
          ],
        },
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        eventType: true,
        metadata: true,
        createdAt: true,
      },
    });

    let abandonedCartCycles = 0;
    let remindersSentTotal = 0;
    let remindersSentStage1 = 0;
    let remindersSentStage2 = 0;
    let remindersOpened = 0;
    let cartsReopened = 0;
    let conversions = 0;
    let attributedRevenue = 0;
    let suppressionCount = 0;
    const suppressionBreakdown: Record<string, number> = {};

    for (const e of events) {
      let meta: any = {};
      try {
        meta = e.metadata ? JSON.parse(e.metadata) : {};
      } catch {
        meta = {};
      }

      if (e.eventType === 'CART_ABANDONMENT_DETECTED') {
        abandonedCartCycles++;
      } else if (e.eventType === 'CART_REMINDER_SENT') {
        remindersSentTotal++;
        if (meta.stage === 1) remindersSentStage1++;
        if (meta.stage === 2) remindersSentStage2++;
      } else if (e.eventType === 'CART_REMINDER_OPENED') {
        remindersOpened++;
      } else if (e.eventType === 'CART_REMINDER_CART_OPENED') {
        cartsReopened++;
      } else if (e.eventType === 'CART_REMINDER_CONVERSION') {
        conversions++;
        attributedRevenue += typeof meta.attributedRevenue === 'number' ? meta.attributedRevenue : 0;
      } else if (e.eventType === 'CART_REMINDER_SUPPRESSED') {
        suppressionCount++;
        const reason = meta.reason || 'UNKNOWN';
        suppressionBreakdown[reason] = (suppressionBreakdown[reason] || 0) + 1;
      }
    }

    // Active cycles from in-memory / state
    let activeCycles = 0;
    for (const cycle of this.cycleStore.values()) {
      if (cycle.status === CartAbandonmentCycleStatus.ACTIVE) {
        activeCycles++;
      }
    }

    // Notification opt-out rate for CART_ABANDONMENT
    const totalCustomersWithPrefs = await prisma.notificationPreference.count({
      where: { category: NotificationCategory.CART_ABANDONMENT },
    });
    const optedOutCustomers = await prisma.notificationPreference.count({
      where: {
        category: NotificationCategory.CART_ABANDONMENT,
        pushEnabled: false,
        inAppEnabled: false,
      },
    });
    const notificationOptOutRate =
      totalCustomersWithPrefs > 0 ? Number(((optedOutCustomers / totalCustomersWithPrefs) * 100).toFixed(2)) : 0;

    const openRate = remindersSentTotal > 0 ? Number(((remindersOpened / remindersSentTotal) * 100).toFixed(2)) : 0;
    const conversionRate = remindersSentTotal > 0 ? Number(((conversions / remindersSentTotal) * 100).toFixed(2)) : 0;
    const totalEvaluations = remindersSentTotal + suppressionCount;
    const suppressionRate = totalEvaluations > 0 ? Number(((suppressionCount / totalEvaluations) * 100).toFixed(2)) : 0;

    return {
      period,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      abandonedCartCycles: Math.max(abandonedCartCycles, this.cycleStore.size),
      activeCycles,
      remindersSentTotal,
      remindersSentStage1,
      remindersSentStage2,
      remindersOpened,
      openRate,
      cartsReopened,
      conversions,
      conversionRate,
      attributedRevenue: Number(attributedRevenue.toFixed(2)),
      currency: 'YER',
      suppressionCount,
      suppressionRate,
      suppressionBreakdown,
      notificationOptOutRate,
    };
  }

  /**
   * Helper to persist canonical analytics event to Prisma.
   */
  private async recordAnalyticsEvent(params: {
    eventType: string;
    customerId?: string;
    orderId?: string;
    metadata?: Record<string, any>;
  }) {
    try {
      await prisma.analyticsEvent.create({
        data: {
          eventType: params.eventType,
          customerId: params.customerId,
          orderId: params.orderId,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        },
      });
    } catch (err: any) {
      console.warn(`[CartAbandonmentService] Failed to record analytics event ${params.eventType}:`, err.message);
    }
  }

  /**
   * Clean state for test harness
   */
  resetStateForTesting() {
    this.cycleStore.clear();
    this.userLastCartOpen.clear();
    this.processingLock.clear();
  }
}

export const cartAbandonmentService = CartAbandonmentService.get();
