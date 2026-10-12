import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { FollowRelationshipType } from '@prisma/client';
import { reconcileCounters } from '../../modules/follows/follow.service';
import { flushFollowerNotifications } from '../../modules/follows/follow.notifications';

/**
 * Nightly counter reconciliation job.
 * Corrects follower/following counter drift for ALL users by running
 * SELECT COUNT(*) from SocialFollow and updating FollowCounter + StoreEnhancement.
 * Should be scheduled for 02:00 UTC.
 */
export async function runFollowCounterReconciliation(): Promise<void> {
  console.log('[follow-counter.job] Starting nightly counter reconciliation...');
  const startedAt = Date.now();

  try {
    // Get all unique user IDs that have any follow activity
    const [followers, followed] = await Promise.all([
      prisma.socialFollow.findMany({
        select: { followerUserId: true, relationshipType: true },
        distinct: ['followerUserId', 'relationshipType'],
      }),
      prisma.socialFollow.findMany({
        select: { followedUserId: true, relationshipType: true },
        distinct: ['followedUserId', 'relationshipType'],
      }),
    ]);

    // Build set of unique (userId, type) pairs
    const pairs = new Map<string, FollowRelationshipType>();
    for (const f of followers) {
      pairs.set(`${f.followerUserId}:${f.relationshipType}`, f.relationshipType);
    }
    for (const f of followed) {
      pairs.set(`${f.followedUserId}:${f.relationshipType}`, f.relationshipType);
    }

    console.log(`[follow-counter.job] Reconciling ${pairs.size} user-type pairs...`);

    let reconciled = 0;
    let errors = 0;

    for (const [key, type] of pairs) {
      const userId = key.split(':')[0];
      try {
        await reconcileCounters(userId, type);
        reconciled++;
      } catch (e) {
        errors++;
        console.error(`[follow-counter.job] Error reconciling ${key}:`, e);
      }
    }

    // Also update StoreEnhancement.newFollowersToday/Week/Month
    await updateStoreFollowerAnalytics();

    const elapsed = Date.now() - startedAt;
    console.log(
      `[follow-counter.job] Done. Reconciled: ${reconciled}, Errors: ${errors}, Elapsed: ${elapsed}ms`
    );
  } catch (e) {
    console.error('[follow-counter.job] Fatal error:', e);
  }
}

/**
 * Updates StoreEnhancement.newFollowersToday/Week/Month for all stores.
 * Called nightly as part of the reconciliation job.
 */
async function updateStoreFollowerAnalytics(): Promise<void> {
  const now = new Date();
  const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek  = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - 7);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Get all sellers with stores
  const sellers = await prisma.seller.findMany({
    select: { userId: true, stores: { select: { id: true }, take: 1 } },
    where: { stores: { some: {} } },
  });

  for (const seller of sellers) {
    if (!seller.stores[0]) continue;
    const storeId = seller.stores[0].id;
    const sellerUserId = seller.userId;

    const [today, week, month] = await Promise.all([
      prisma.socialFollow.count({
        where: {
          followedUserId: sellerUserId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
          createdAt: { gte: startOfDay },
        },
      }),
      prisma.socialFollow.count({
        where: {
          followedUserId: sellerUserId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
          createdAt: { gte: startOfWeek },
        },
      }),
      prisma.socialFollow.count({
        where: {
          followedUserId: sellerUserId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
          createdAt: { gte: startOfMonth },
        },
      }),
    ]);

    await prisma.storeEnhancement.upsert({
      where: { storeId },
      update: { newFollowersToday: today, newFollowersWeek: week, newFollowersMonth: month },
      create: { storeId, newFollowersToday: today, newFollowersWeek: week, newFollowersMonth: month },
    });
  }
}

/**
 * Every-5-minutes notification flush job.
 * Reads pending Redis sets and creates grouped Notification rows.
 */
export async function runFollowNotificationFlush(): Promise<void> {
  try {
    await flushFollowerNotifications();
  } catch (e) {
    console.error('[follow-notification.job] Error flushing notifications:', e);
  }
}

export class FollowScheduler {
  private static flushTimer: NodeJS.Timeout | null = null;
  private static reconcileTimer: NodeJS.Timeout | null = null;

  static start(flushIntervalMs = 5 * 60 * 1000, reconcileIntervalMs = 60 * 60 * 1000): void {
    if (this.flushTimer) return;

    console.log('[FollowScheduler] Starting background follow notification & counter scheduler...');

    // 1. Notification flush timer (default: every 5 minutes)
    this.flushTimer = setInterval(() => {
      runFollowNotificationFlush();
    }, flushIntervalMs);

    // 2. Reconciliation check timer (every hour, runs nightly reconciliation if 02:00 UTC)
    this.reconcileTimer = setInterval(() => {
      const currentHour = new Date().getUTCHours();
      if (currentHour === 2) {
        runFollowCounterReconciliation();
      }
    }, reconcileIntervalMs);
  }

  static stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    console.log('[FollowScheduler] Stopped background follow scheduler.');
  }
}

