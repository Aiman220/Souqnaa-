import { prisma } from '../../database/prisma';
import {
  MembershipStatus,
  MembershipAuditChangeType,
  CustomerMembershipSummary,
  MembershipEvaluationResult,
  MembershipTierSummary,
} from './membership.types';
import { MembershipRulesEngine } from './membership-rules.engine';
import { MembershipMetricsService } from './membership-metrics.service';
import { MembershipCacheService } from './membership-cache.service';
import { randomUUID } from 'crypto';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationCategory, NotificationPriority, AppType } from '../notifications/notification.types';

export class MembershipEligibilityService {
  /**
   * Fetches all active tiers sorted by deterministic level descending (highest tier first).
   */
  public static async getActiveTiersDescending(): Promise<any[]> {
    const cached = await MembershipCacheService.getActiveTiers();
    if (cached) return cached;

    const tiers = await prisma.membershipTier.findMany({
      where: { isActive: true },
      orderBy: [{ level: 'desc' }, { priority: 'desc' }],
    });

    await MembershipCacheService.setActiveTiers(tiers);
    return tiers;
  }

  /**
   * Fetches the baseline starting tier (level 0, e.g. REGULAR).
   */
  public static async getBaselineTier(): Promise<any> {
    const tiers = await this.getActiveTiersDescending();
    const baseline = tiers.slice().reverse().find((t) => t.level === 0) || tiers[tiers.length - 1];
    return baseline;
  }

  /**
   * Retrieves or creates a customer's membership record.
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
   * Evaluates rules against customer metrics and applies target tier.
   */
  public static async evaluateCustomerTier(
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

    // 3. Evaluate Tiers from Highest level down to Lowest level
    let targetTier = activeTiers[activeTiers.length - 1]; // fallback baseline
    for (const tier of activeTiers) {
      let rulesConfig: any = { logic: 'ALL', rules: [] };
      try {
        rulesConfig = JSON.parse(tier.qualificationRules);
      } catch (_) {}

      const isEligible = MembershipRulesEngine.isEligible(rulesConfig, metrics);
      if (isEligible) {
        targetTier = tier;
        break; // First match is the highest level tier because activeTiers is sorted DESC
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

    // 5. Send Celebration Notification on Upgrade
    if (isUpgraded) {
      try {
        notificationDispatcher.dispatch({
          eventId: randomUUID(),
          idempotencyKey: `membership_upgrade_${userId}_${targetTier.code}_${Date.now()}`,
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
          createdAt: new Date(),
        }).catch(() => {});
      } catch (_) {}
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
   */
  public static async getCustomerSummary(userId: string): Promise<CustomerMembershipSummary> {
    const cached = await MembershipCacheService.getCustomerSummary(userId);
    if (cached) return cached;

    const membership = await this.getOrCreateMembership(userId);
    const activeTiers = await this.getActiveTiersDescending();
    const currentTier = membership.tier;

    // Find next tier if one exists
    // activeTiers is sorted DESC (4, 3, 2, 1, 0)
    // Next tier is the one with level === currentTier.level + 1
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

    const activeOverride = membership.overrides?.[0];

    const summary: CustomerMembershipSummary = {
      tierId: currentTier.id,
      tierCode: currentTier.code,
      tierNameAr: currentTier.nameAr,
      tierNameEn: currentTier.nameEn,
      level: currentTier.level,
      status: membership.status,
      startedAt: membership.startedAt.toISOString(),
      expiresAt: membership.expiresAt ? membership.expiresAt.toISOString() : null,
      renewedAt: membership.renewedAt ? membership.renewedAt.toISOString() : null,
      gracePeriodEnd: membership.gracePeriodEnd ? membership.gracePeriodEnd.toISOString() : null,
      isGracePeriod: membership.gracePeriodEnd ? new Date() < membership.gracePeriodEnd : false,
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
      progress: nextTier
        ? {
            nextTierCode: nextTier.code,
            nextTierNameAr: nextTier.nameAr,
            nextTierNameEn: nextTier.nameEn,
            nextTierLevel: nextTier.level,
            metric: progressResult!.metric,
            current: progressResult!.current,
            target: progressResult!.target,
            remaining: progressResult!.remaining,
            percentage: progressResult!.percentage,
            spendProgress: progressResult!.spendProgress,
            orderProgress: progressResult!.orderProgress,
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
   * Event hook: Triggered upon successful Order Delivery.
   */
  public static async onOrderDelivered(params: {
    userId: string;
    orderId: string;
    subtotal: any;
  }): Promise<void> {
    const { userId, orderId } = params;
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

    // Validate tier
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
