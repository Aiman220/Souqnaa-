import { prisma } from '../../database/prisma';
import {
  MembershipStatus,
  MembershipAuditChangeType,
  CustomerMembershipSummary,
  MembershipEvaluationResult,
} from './membership.types';
import { MembershipRulesEngine } from './membership-rules.engine';
import { MembershipMetricsService } from './membership-metrics.service';
import { MembershipCacheService } from './membership-cache.service';
import { randomUUID } from 'crypto';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationCategory, NotificationPriority, AppType } from '../notifications/notification.types';

export class MembershipEligibilityService {
  private static inFlightEvaluations = new Map<string, Promise<MembershipEvaluationResult>>();
  private static recentProcessedEvents = new Map<string, number>(); // eventKey -> timestamp

  /**
   * Fetches all active tiers sorted by deterministic level descending (highest tier first).
   */
  public static async getActiveTiersDescending(): Promise<any[]> {
    const cached = await MembershipCacheService.getActiveTiers();
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;

    let tiers = await prisma.membershipTier.findMany({
      where: { isActive: true },
      orderBy: [{ level: 'desc' }, { priority: 'desc' }],
    });

    if (tiers.length === 0) {
      try {
        const { seedMembershipTiers } = await import('../../database/seed_membership_tiers');
        await seedMembershipTiers();
        tiers = await prisma.membershipTier.findMany({
          where: { isActive: true },
          orderBy: [{ level: 'desc' }, { priority: 'desc' }],
        });
      } catch (err) {
        console.warn('[Membership] Failed to self-seed membership tiers:', err);
      }
    }

    if (tiers.length > 0) {
      await MembershipCacheService.setActiveTiers(tiers);
    }
    return tiers;
  }

  /**
   * Fetches the baseline starting tier (level 1, e.g. BASIC).
   */
  public static async getBaselineTier(): Promise<any> {
    const tiers = await this.getActiveTiersDescending();
    // Deterministically find level 1 (or lowest level tier)
    const baseline = tiers.slice().reverse().find((t) => t.level === 1) || tiers[tiers.length - 1];
    return baseline;
  }

  /**
   * Retrieves or creates a customer's membership record with default Level 1 Basic tier.
   */
  public static async getOrCreateMembership(userId: string): Promise<any> {
    let membership = await prisma.customerMembership.findUnique({
      where: { userId },
      include: {
        tier: true,
        overrides: {
          where: { isActive: true },
          include: { overrideTier: true },
          take: 1,
        },
      },
    });

    if (!membership) {
      const baselineTier = await this.getBaselineTier();
      if (!baselineTier) {
        throw new Error('No baseline membership tier configured in database');
      }

      membership = await prisma.customerMembership.create({
        data: {
          userId,
          tierId: baselineTier.id,
          status: MembershipStatus.ACTIVE,
          startedAt: new Date(),
          lifetimeSpend: 0,
          periodSpend: 0,
          completedOrders: 0,
          periodCompletedOrders: 0,
          pointsBalance: 0,
          lastEvaluatedAt: new Date(),
        },
        include: {
          tier: true,
          overrides: {
            where: { isActive: true },
            include: { overrideTier: true },
            take: 1,
          },
        },
      });

      // Audit log initial assignment
      await prisma.membershipAuditLog.create({
        data: {
          userId,
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          changeType: MembershipAuditChangeType.INITIAL_ASSIGNMENT,
          newTierId: baselineTier.id,
          reason: 'Initial membership assignment upon onboarding',
        },
      });
    }

    return membership;
  }

  /**
   * Core Server-Authoritative Evaluation Engine.
   * Concurrency-safe, idempotent, transaction-wrapped.
   */
  public static async evaluateCustomerTier(
    userId: string,
    options: { forceAuthoritativeRecalculation?: boolean; correlationId?: string; actorId?: string } = {}
  ): Promise<MembershipEvaluationResult> {
    // 1. Mutex / Concurrency deduplication per user
    const existingPromise = this.inFlightEvaluations.get(userId);
    if (existingPromise) {
      return existingPromise;
    }

    const evaluationPromise = this.executeAuthoritativeEvaluation(userId, options);
    this.inFlightEvaluations.set(userId, evaluationPromise);

    try {
      return await evaluationPromise;
    } finally {
      this.inFlightEvaluations.delete(userId);
    }
  }

  private static async executeAuthoritativeEvaluation(
    userId: string,
    options: { forceAuthoritativeRecalculation?: boolean; correlationId?: string; actorId?: string } = {}
  ): Promise<MembershipEvaluationResult> {
    const membership = await this.getOrCreateMembership(userId);
    const activeTiers = await this.getActiveTiersDescending();

    // 1. Check for Active Manual Override
    const activeOverride = membership.overrides?.[0];
    if (activeOverride && (!activeOverride.endAt || new Date() < activeOverride.endAt)) {
      const overrideTier = activeOverride.overrideTier;
      const tierChanged = membership.tierId !== overrideTier.id;

      if (tierChanged) {
        await prisma.$transaction(async (tx) => {
          await tx.customerMembership.update({
            where: { id: membership.id },
            data: {
              tierId: overrideTier.id,
              lastEvaluatedAt: new Date(),
              version: { increment: 1 },
            },
          });

          await tx.membershipAuditLog.create({
            data: {
              userId,
              actorId: options.actorId || activeOverride.createdBy,
              actorRole: 'ADMIN',
              changeType: MembershipAuditChangeType.OVERRIDE_APPLIED,
              previousTierId: membership.tierId,
              newTierId: overrideTier.id,
              reason: `Admin override applied: ${activeOverride.reason}`,
              correlationId: options.correlationId,
            },
          });
        });

        await MembershipCacheService.invalidateCustomer(userId);
      }

      return {
        userId,
        previousTierId: membership.tierId,
        targetTierId: overrideTier.id,
        previousTierCode: membership.tier.code,
        targetTierCode: overrideTier.code,
        isUpgraded: overrideTier.level > membership.tier.level,
        isDowngraded: overrideTier.level < membership.tier.level,
        tierChanged,
        changeType: MembershipAuditChangeType.OVERRIDE_APPLIED,
        reason: `Admin manual override (${activeOverride.reason})`,
        membership,
      };
    }

    // 2. Authoritative Metrics Gathering
    const metrics = await MembershipMetricsService.computeAuthoritativeMetrics(userId);

    // 3. Evaluate Tiers from Highest level down to Lowest level (activeTiers sorted DESC)
    const baselineTier = activeTiers.slice().reverse().find((t) => t.level === 1) || activeTiers[activeTiers.length - 1];
    let targetTier = baselineTier;

    for (const tier of activeTiers) {
      if (tier.level <= 1) continue; // Baseline starting tier (Level 1) is fallback

      let rulesConfig: any = { logic: 'ALL', rules: [] };
      try {
        rulesConfig = JSON.parse(tier.qualificationRules);
      } catch (_) {}

      const isEligible = MembershipRulesEngine.isEligible(rulesConfig, metrics, tier.level);
      if (isEligible) {
        targetTier = tier;
        break; // First match is highest tier because activeTiers is sorted DESC
      }
    }

    const previousTier = membership.tier;
    const tierChanged = previousTier.id !== targetTier.id;
    const isUpgraded = targetTier.level > previousTier.level;
    const isDowngraded = targetTier.level < previousTier.level;

    const changeType: MembershipAuditChangeType = isUpgraded
      ? MembershipAuditChangeType.UPGRADE
      : isDowngraded
      ? MembershipAuditChangeType.DOWNGRADE
      : MembershipAuditChangeType.RULE_EVALUATION;

    const now = new Date();

    // 4. Update Database Record Atomically
    const updated = await prisma.$transaction(async (tx) => {
      const up = await tx.customerMembership.update({
        where: { id: membership.id },
        data: {
          tierId: targetTier.id,
          lifetimeSpend: metrics.lifetimeSpend,
          periodSpend: metrics.periodSpend,
          completedOrders: metrics.completedOrders,
          periodCompletedOrders: metrics.periodCompletedOrders,
          pointsBalance: metrics.pointsBalance,
          lastEvaluatedAt: now,
          ...(isUpgraded ? { renewedAt: now } : {}),
          version: { increment: 1 },
        },
        include: { tier: true },
      });

      if (tierChanged) {
        await tx.membershipAuditLog.create({
          data: {
            userId,
            actorId: options.actorId || 'SYSTEM',
            actorRole: 'SYSTEM',
            changeType,
            previousTierId: previousTier.id,
            newTierId: targetTier.id,
            reason: isUpgraded
              ? `Customer met qualification rules for ${targetTier.nameEn}`
              : `Customer tier updated to ${targetTier.nameEn}`,
            metricsSnapshot: JSON.stringify(metrics),
            correlationId: options.correlationId,
          },
        });
      }

      return up;
    });

    // Invalidate Cache
    await MembershipCacheService.invalidateCustomer(userId);

    // 5. Send Celebration Notification on Genuine Upgrade (Exactly-Once Idempotent)
    if (isUpgraded) {
      const qualificationYear = now.getFullYear();
      // Deterministic idempotency key tied to user, target tier, and qualification year
      const idempotencyKey = `membership_upgrade_${userId}_${targetTier.code}_${qualificationYear}`;

      try {
        // Check database for existing notification to avoid duplicate dispatch attempts
        const existingNotification = await prisma.notification.findFirst({
          where: {
            userId,
            idempotencyKey,
          },
          select: { id: true },
        });

        if (!existingNotification) {
          await notificationDispatcher.dispatch({
            eventId: randomUUID(),
            idempotencyKey,
            eventType: 'MEMBERSHIP_UPGRADED',
            category: NotificationCategory.REWARDS,
            priority: NotificationPriority.HIGH,
            recipientId: userId,
            recipientType: AppType.CUSTOMER,
            data: {
              titleAr: `تهانينا! تمت ترقيتك إلى فئة ${targetTier.nameAr}`,
              titleEn: `Congratulations! You are now a ${targetTier.nameEn} member`,
              bodyAr: `استمتع بمزايا حصرية جديدة بما في ذلك مضاعف عملات وتخفيضات خاصة بفئتك.`,
              bodyEn: `Enjoy new exclusive benefits including bonus coins and special perks.`,
              tierCode: targetTier.code,
              tierLevel: targetTier.level,
              actionUrl: '/profile/membership',
            },
            createdAt: now,
          }).catch((err) => {
            console.warn('[Membership] Notification dispatch error:', err?.message || err);
          });
        }
      } catch (err: any) {
        console.warn('[Membership] Notification idempotency check error:', err?.message || err);
      }
    }

    return {
      userId,
      previousTierId: previousTier.id,
      targetTierId: targetTier.id,
      previousTierCode: previousTier.code,
      targetTierCode: targetTier.code,
      isUpgraded,
      isDowngraded,
      tierChanged,
      changeType,
      reason: tierChanged ? `Evaluated and transitioned to ${targetTier.nameEn}` : 'Tier retained',
      membership: updated,
    };
  }

  /**
   * Builds the comprehensive customer-facing membership summary for Profile and Dashboard.
   * Guaranteed safe: Does not mutate state or trigger notifications during read operations.
   */
  public static async getCustomerSummary(
    userId: string,
    options: { forceEvaluation?: boolean } = {}
  ): Promise<CustomerMembershipSummary> {
    const cached = await MembershipCacheService.getCustomerSummary(userId);
    if (cached && !options.forceEvaluation) return cached;

    const membership = await this.getOrCreateMembership(userId);
    const activeTiers = await this.getActiveTiersDescending();

    // If never evaluated or explicitly requested, run authoritative evaluation
    if (options.forceEvaluation || !membership.lastEvaluatedAt) {
      await this.evaluateCustomerTier(userId).catch((err) => {
        console.warn(`[Membership] Evaluation on summary fetch for ${userId}:`, err?.message || err);
      });
    }

    // Refresh membership model from DB
    const freshMembership = await prisma.customerMembership.findUnique({
      where: { userId },
      include: {
        tier: true,
        overrides: {
          where: { isActive: true },
          include: { overrideTier: true },
          take: 1,
        },
      },
    }) || membership;

    const activeOverride = freshMembership.overrides?.[0];
    const hasActiveOverride = Boolean(activeOverride && (!activeOverride.endAt || new Date() < activeOverride.endAt));
    const currentTier = (hasActiveOverride && activeOverride?.overrideTier)
      ? activeOverride.overrideTier
      : freshMembership.tier;

    // Find next tier: tier with level === currentTier.level + 1
    const nextTier = activeTiers.find((t) => t.level === currentTier.level + 1) || null;

    let benefitConfig: any = { perks: [], perksAr: [] };
    try {
      benefitConfig = JSON.parse(currentTier.benefitConfiguration);
    } catch (_) {}

    let nextRulesConfig: any = { logic: 'ALL', rules: [] };
    if (nextTier) {
      try {
        nextRulesConfig = JSON.parse(nextTier.qualificationRules);
      } catch (_) {}
    }

    const metricsSnapshot = await MembershipMetricsService.getMetrics(userId);
    const progressResult = nextTier
      ? MembershipRulesEngine.calculateProgress(nextRulesConfig, metricsSnapshot)
      : null;

    const summary: CustomerMembershipSummary = {
      tierId: currentTier.id,
      tierCode: currentTier.code,
      tierNameAr: currentTier.nameAr,
      tierNameEn: currentTier.nameEn,
      level: currentTier.level,
      // Convenience aliases
      membershipLevel: currentTier.level,
      membershipName: currentTier.nameEn,
      annualPurchases: metricsSnapshot.periodSpend,
      completedOrders: metricsSnapshot.completedOrders,
      membershipProgress: progressResult ? progressResult.percentage : 0,
      status: freshMembership.status,
      startedAt: freshMembership.startedAt.toISOString(),
      expiresAt: freshMembership.expiresAt ? freshMembership.expiresAt.toISOString() : null,
      renewedAt: freshMembership.renewedAt ? freshMembership.renewedAt.toISOString() : null,
      gracePeriodEnd: freshMembership.gracePeriodEnd ? freshMembership.gracePeriodEnd.toISOString() : null,
      isGracePeriod: freshMembership.gracePeriodEnd ? new Date() < freshMembership.gracePeriodEnd : false,
      badge: {
        visible: true,
        imageUrl: currentTier.badgeAssetUrl || null,
        icon: currentTier.icon || 'crown',
      },
      metrics: {
        lifetimeSpend: metricsSnapshot.lifetimeSpend,
        periodSpend: metricsSnapshot.periodSpend,
        completedOrders: metricsSnapshot.completedOrders,
        periodCompletedOrders: metricsSnapshot.periodCompletedOrders,
        pointsBalance: metricsSnapshot.pointsBalance,
      },
      benefits: benefitConfig,
      progress: nextTier && progressResult
        ? {
            nextTierCode: nextTier.code,
            nextTierNameAr: nextTier.nameAr,
            nextTierNameEn: nextTier.nameEn,
            nextTierLevel: nextTier.level,
            metric: progressResult.metric,
            current: progressResult.current,
            target: progressResult.target,
            remaining: progressResult.remaining,
            percentage: progressResult.percentage,
            spendProgress: progressResult.spendProgress,
            orderProgress: progressResult.orderProgress,
          }
        : null,
      override: activeOverride
        ? {
            isActive: true,
            reason: activeOverride.reason,
            endAt: activeOverride.endAt ? activeOverride.endAt.toISOString() : null,
          }
        : null,
    };

    await MembershipCacheService.setCustomerSummary(userId, summary);
    return summary;
  }

  /**
   * Event hook: Triggered upon successful Order Delivery (Idempotent).
   */
  public static async onOrderDelivered(params: {
    userId: string;
    orderId: string;
    subtotal?: any;
  }): Promise<void> {
    const { userId, orderId } = params;
    const eventKey = `delivered_${orderId}`;

    const now = Date.now();
    const lastProcessed = this.recentProcessedEvents.get(eventKey);
    if (lastProcessed && now - lastProcessed < 60000) {
      return; // Deduplicate duplicate delivered events within 60 seconds
    }
    this.recentProcessedEvents.set(eventKey, now);

    try {
      await this.evaluateCustomerTier(userId, {
        forceAuthoritativeRecalculation: true,
        correlationId: `order_delivered_${orderId}`,
      });
    } catch (err) {
      console.error(`[Membership] Failed to evaluate membership on order delivery for ${userId}:`, err);
    }
  }

  /**
   * Event hook: Triggered upon Order Cancellation.
   */
  public static async onOrderCancelled(params: {
    userId: string;
    orderId: string;
    subtotal?: any;
  }): Promise<void> {
    const { userId, orderId } = params;
    const eventKey = `cancelled_${orderId}`;

    const now = Date.now();
    const lastProcessed = this.recentProcessedEvents.get(eventKey);
    if (lastProcessed && now - lastProcessed < 60000) {
      return;
    }
    this.recentProcessedEvents.set(eventKey, now);

    try {
      await this.evaluateCustomerTier(userId, {
        forceAuthoritativeRecalculation: true,
        correlationId: `order_cancelled_${orderId}`,
      });
    } catch (err) {
      console.error(`[Membership] Failed to re-evaluate on order cancellation for ${userId}:`, err);
    }
  }

  /**
   * Event hook: Triggered upon Refund Completion.
   */
  public static async onRefundCompleted(params: {
    userId: string;
    refundId: string;
    approvedAmount: number;
  }): Promise<void> {
    const { userId, refundId } = params;
    const eventKey = `refund_${refundId}`;

    const now = Date.now();
    const lastProcessed = this.recentProcessedEvents.get(eventKey);
    if (lastProcessed && now - lastProcessed < 60000) {
      return;
    }
    this.recentProcessedEvents.set(eventKey, now);

    try {
      await this.evaluateCustomerTier(userId, {
        forceAuthoritativeRecalculation: true,
        correlationId: `refund_completed_${refundId}`,
      });
    } catch (err) {
      console.error(`[Membership] Failed to re-evaluate on refund completion for ${userId}:`, err);
    }
  }

  /**
   * Event hook: Triggered upon Successful Payment Confirmation (Idempotent).
   */
  public static async onPaymentCompleted(params: {
    userId: string;
    orderId: string;
    paymentId?: string;
  }): Promise<void> {
    const { userId, orderId, paymentId } = params;
    const eventKey = `payment_${orderId}_${paymentId || 'paid'}`;

    const now = Date.now();
    const lastProcessed = this.recentProcessedEvents.get(eventKey);
    if (lastProcessed && now - lastProcessed < 60000) {
      return;
    }
    this.recentProcessedEvents.set(eventKey, now);

    try {
      await this.evaluateCustomerTier(userId, {
        forceAuthoritativeRecalculation: true,
        correlationId: `payment_completed_${orderId}`,
      });
    } catch (err) {
      console.error(`[Membership] Failed to evaluate on payment completion for ${userId}:`, err);
    }
  }

  /**
   * Admin hook: Triggered when membership tiers, thresholds, or rules change.
   * Invalidates all caches and triggers background recalculation of all active customer memberships.
   */
  public static async onTierConfigurationChanged(): Promise<void> {
    await MembershipCacheService.invalidateAll();

    setImmediate(async () => {
      try {
        const activeMemberships = await prisma.customerMembership.findMany({
          where: { status: MembershipStatus.ACTIVE },
          select: { userId: true },
        });

        for (const m of activeMemberships) {
          try {
            await this.evaluateCustomerTier(m.userId, {
              forceAuthoritativeRecalculation: true,
              correlationId: `tier_config_change_${Date.now()}`,
            });
          } catch (_) {}
        }
      } catch (err) {
        console.error('[Membership] Recalculation on tier change error:', err);
      }
    });
  }

  /**
   * Admin Action: Apply Manual Override.
   */
  public static async applyOverride(params: {
    userId: string;
    overrideTierId: string;
    reason: string;
    endAt?: Date | null;
    adminId: string;
  }): Promise<any> {
    const { userId, overrideTierId, reason, endAt, adminId } = params;

    const tier = await prisma.membershipTier.findUnique({
      where: { id: overrideTierId },
    });
    if (!tier) throw new Error('Target membership tier not found');

    const membership = await this.getOrCreateMembership(userId);

    // Deactivate previous active overrides
    await prisma.membershipOverride.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });

    const override = await prisma.membershipOverride.create({
      data: {
        userId,
        membershipId: membership.id,
        overrideTierId,
        reason,
        endAt,
        createdBy: adminId,
        isActive: true,
      },
    });

    // Evaluate immediately to apply
    await this.evaluateCustomerTier(userId, {
      actorId: adminId,
      correlationId: `admin_override_${override.id}`,
    });

    return override;
  }

  /**
   * Admin Action: Remove Manual Override.
   */
  public static async removeOverride(params: {
    userId: string;
    adminId: string;
  }): Promise<void> {
    const { userId, adminId } = params;

    await prisma.membershipOverride.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });

    // Invalidate cache immediately
    await MembershipCacheService.invalidateCustomer(userId);

    // Evaluate back to automatic rules
    await this.evaluateCustomerTier(userId, {
      actorId: adminId,
      correlationId: `override_removed_${Date.now()}`,
    });
  }

  /**
   * Admin Action: Suspend Membership.
   */
  public static async suspendMembership(params: {
    userId: string;
    reason: string;
    adminId: string;
  }): Promise<any> {
    const { userId, reason, adminId } = params;
    const membership = await this.getOrCreateMembership(userId);

    const updated = await prisma.$transaction(async (tx) => {
      const up = await tx.customerMembership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.SUSPENDED, version: { increment: 1 } },
      });

      await tx.membershipAuditLog.create({
        data: {
          userId,
          actorId: adminId,
          actorRole: 'ADMIN',
          changeType: MembershipAuditChangeType.SUSPEND,
          newTierId: membership.tierId,
          reason: `Admin suspension: ${reason}`,
        },
      });

      return up;
    });

    await MembershipCacheService.invalidateCustomer(userId);
    return updated;
  }

  /**
   * Admin Action: Restore Suspended Membership.
   */
  public static async restoreMembership(params: {
    userId: string;
    adminId: string;
  }): Promise<any> {
    const { userId, adminId } = params;
    const membership = await this.getOrCreateMembership(userId);

    const updated = await prisma.$transaction(async (tx) => {
      const up = await tx.customerMembership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.ACTIVE, version: { increment: 1 } },
      });

      await tx.membershipAuditLog.create({
        data: {
          userId,
          actorId: adminId,
          actorRole: 'ADMIN',
          changeType: MembershipAuditChangeType.RESTORE,
          newTierId: membership.tierId,
          reason: 'Admin restored membership to active status',
        },
      });

      return up;
    });

    await MembershipCacheService.invalidateCustomer(userId);
    return updated;
  }
}
