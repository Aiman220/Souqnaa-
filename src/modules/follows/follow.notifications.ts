import { randomUUID } from 'crypto';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationCategory, NotificationPriority, AppType } from '../notifications/notification.types';

const NOTIFICATION_BATCH_SIZE = 25; // Max followers per grouped notification
const PENDING_KEY_PREFIX = 'notif:pending:followers:';

/**
 * Flushes pending new-follower Redis sets into grouped Notification rows.
 * Called by the background job every 5 minutes.
 *
 * Groups up to NOTIFICATION_BATCH_SIZE followers per notification.
 * Example output: "Ahmed and 24 others started following your store."
 */
export async function flushFollowerNotifications(): Promise<void> {
  // Get all pending notification keys via in-memory fallback or pattern scan
  // Since RedisService doesn't expose SCAN, we track seller IDs via a meta-set
  const sellerIds = await redis.smembers('notif:pending:seller_ids');
  if (sellerIds.length === 0) return;

  for (const sellerId of sellerIds) {
    await flushSellerNotification(sellerId);
  }
}

/**
 * Flush pending follower notifications for a single seller.
 */
export async function flushSellerNotification(sellerId: string): Promise<void> {
  const pendingKey = `${NOTIFICATION_BATCH_SIZE}:${sellerId}`; // key with prefix
  const key = `${PENDING_KEY_PREFIX}${sellerId}`;
  const followerIds = await redis.smembers(key);

  if (followerIds.length === 0) {
    await redis.srem('notif:pending:seller_ids', sellerId);
    return;
  }

  // Get seller's store for display name
  const seller = await prisma.seller.findUnique({
    where: { userId: sellerId },
    select: {
      userId: true,
      stores: { select: { name: true }, take: 1 },
      user: { select: { firstName: true } },
    },
  });
  if (!seller) {
    await redis.del(key);
    await redis.srem('notif:pending:seller_ids', sellerId);
    return;
  }

  // Process in batches of NOTIFICATION_BATCH_SIZE
  const batches: string[][] = [];
  for (let i = 0; i < followerIds.length; i += NOTIFICATION_BATCH_SIZE) {
    batches.push(followerIds.slice(i, i + NOTIFICATION_BATCH_SIZE));
  }

  for (const batch of batches) {
    // Get first follower's display name for the notification body
    let firstFollowerName = 'مستخدم';
    if (batch.length > 0) {
      const firstUser = await prisma.user.findUnique({
        where: { id: batch[0] },
        select: { firstName: true, lastName: true },
      });
      if (firstUser) {
        firstFollowerName = `${firstUser.firstName} ${firstUser.lastName}`.trim();
      }
    }

    const storeName = seller.stores[0]?.name ?? 'متجرك';
    const count = batch.length;

    let titleAr: string;
    let bodyAr: string;
    let titleEn: string;
    let bodyEn: string;

    if (count === 1) {
      titleAr = 'متابع جديد';
      bodyAr = `${firstFollowerName} بدأ بمتابعة ${storeName}`;
      titleEn = 'New Follower';
      bodyEn = `${firstFollowerName} started following ${storeName}`;
    } else {
      titleAr = `${count} متابع جديد`;
      bodyAr = `${firstFollowerName} و${count - 1} آخرين يتابعون ${storeName} الآن`;
      titleEn = `${count} New Followers`;
      bodyEn = `${firstFollowerName} and ${count - 1} others are now following ${storeName}`;
    }

    await notificationDispatcher.dispatch({
      eventId: randomUUID(),
      idempotencyKey: `seller_follower_${sellerId}_${batch[0]}_${Date.now()}`,
      eventType: 'SELLER_NEW_FOLLOWER',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.NORMAL,
      recipientId: sellerId,
      recipientType: AppType.SELLER,
      entityType: 'seller',
      entityId: sellerId,
      data: {
        followerIds: batch,
        storeId: seller.stores[0]?.name,
        count,
        titleAr,
        titleEn,
        bodyAr,
        bodyEn,
      },
      bypassQuietHours: false,
      bypassRateLimit: true,
      createdAt: new Date(),
    });
  }

  // Clear the pending set and remove from tracking set
  await redis.del(key);
  await redis.srem('notif:pending:seller_ids', sellerId);
}

/**
 * Queue a new follower notification for a seller.
 * Adds the follower to a pending Redis set and registers the seller
 * in the tracking set so the flush job can find it.
 */
export async function queueFollowerNotification(
  followerUserId: string,
  sellerUserId: string
): Promise<void> {
  const key = `${PENDING_KEY_PREFIX}${sellerUserId}`;
  await Promise.all([
    redis.sadd(key, followerUserId),
    redis.expire(key, 7 * 60), // 7 minutes (job runs every 5 min)
    redis.sadd('notif:pending:seller_ids', sellerUserId),
  ]);
}
