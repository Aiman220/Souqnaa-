import { FollowPrivacy, FollowRelationshipType, FollowStatus, UserRoleType } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';

// ── Redis Key Helpers ──────────────────────────────────────────────────────────

const KEYS = {
  followStatus: (followerId: string, followedId: string, type: FollowRelationshipType) =>
    `follow:status:${followerId}:${followedId}:${type}`,
  storeFollowerCount: (storeUserId: string) => `store:${storeUserId}:followerCount`,
  userFollowerCount: (userId: string, type: FollowRelationshipType) =>
    `user:${userId}:${type}:followerCount`,
  userFollowingCount: (userId: string, type: FollowRelationshipType) =>
    `user:${userId}:${type}:followingCount`,
  pendingFollowerNotif: (sellerId: string) => `notif:pending:followers:${sellerId}`,
  storefrontCache: (slug: string) => `storefront:${slug}`,
} as const;

const FOLLOW_STATUS_TTL = 300;   // 5 minutes
const STOREFRONT_TTL    = 60;    // 1 minute

// ── Block check ────────────────────────────────────────────────────────────────

/** Returns true if target has blocked the actor. */
async function isBlockedBy(blockerId: string, blockedId: string): Promise<boolean> {
  const block = await prisma.userBlock.findFirst({
    where: { blockerUserId: blockerId, blockedUserId: blockedId },
    select: { id: true },
  });
  return block !== null;
}

/** Returns true if either user has blocked the other. */
async function isBlocked(userIdA: string, userIdB: string): Promise<boolean> {
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerUserId: userIdA, blockedUserId: userIdB },
        { blockerUserId: userIdB, blockedUserId: userIdA },
      ],
    },
    select: { id: true },
  });
  return block !== null;
}

// ── Privacy check ──────────────────────────────────────────────────────────────

/** Returns true if the target user allows the follower to follow them. */
async function canFollow(targetUserId: string): Promise<boolean> {
  const privacy = await prisma.userFollowPrivacy.findUnique({
    where: { userId: targetUserId },
    select: { whoCanFollow: true },
  });
  if (!privacy) return true; // default PUBLIC
  return privacy.whoCanFollow !== FollowPrivacy.NOBODY;
}

// ── Counter helpers ────────────────────────────────────────────────────────────

async function incrementCounters(
  followerUserId: string,
  followedUserId: string,
  type: FollowRelationshipType
): Promise<void> {
  await Promise.all([
    // Follower: followingCount++
    prisma.followCounter.upsert({
      where: { userId_relationshipType: { userId: followerUserId, relationshipType: type } },
      update: { followingCount: { increment: 1 } },
      create: { userId: followerUserId, relationshipType: type, followerCount: 0, followingCount: 1 },
    }),
    // Followed: followerCount++
    prisma.followCounter.upsert({
      where: { userId_relationshipType: { userId: followedUserId, relationshipType: type } },
      update: { followerCount: { increment: 1 } },
      create: { userId: followedUserId, relationshipType: type, followerCount: 1, followingCount: 0 },
    }),
    // Redis
    redis.incr(KEYS.userFollowingCount(followerUserId, type)),
    redis.incr(KEYS.userFollowerCount(followedUserId, type)),
  ]);
}

async function decrementCounters(
  followerUserId: string,
  followedUserId: string,
  type: FollowRelationshipType
): Promise<void> {
  await Promise.all([
    prisma.followCounter.updateMany({
      where: { userId: followerUserId, relationshipType: type },
      data: { followingCount: { decrement: 1 } },
    }),
    prisma.followCounter.updateMany({
      where: { userId: followedUserId, relationshipType: type },
      data: { followerCount: { decrement: 1 } },
    }),
    redis.decr(KEYS.userFollowingCount(followerUserId, type)),
    redis.decr(KEYS.userFollowerCount(followedUserId, type)),
  ]);
}

// ── Notification grouping ──────────────────────────────────────────────────────

/**
 * Queues a "new follower" notification for the seller/store owner.
 * Uses a Redis set to deduplicate and aggregate. The background job flushes
 * these into actual Notification rows grouped by 25.
 */
async function queueNewFollowerNotification(
  followerUserId: string,
  sellerUserId: string
): Promise<void> {
  const key = KEYS.pendingFollowerNotif(sellerUserId);
  await redis.sadd(key, followerUserId);
  await redis.expire(key, 6 * 60); // 6 minutes TTL (job runs every 5 min)
}

// ── Core Follow Operations ────────────────────────────────────────────────────

/**
 * Customer follows a store (CUSTOMER_TO_SELLER relationship).
 * - Validates customer role
 * - Checks block status
 * - Checks privacy settings
 * - Atomic DB + counter update
 * - Caches follow status in Redis
 * - Queues grouped notification
 */
export async function followStore(
  followerUserId: string,
  storeId: string
): Promise<{ success: boolean; isFollowing: boolean; followerCount: number }> {

  // 1. Validate actor is an active user
  const actor = await prisma.user.findUnique({
    where: { id: followerUserId },
    select: { role: true, isActive: true },
  });
  if (!actor || !actor.isActive) throw new AppError('المستخدم غير موجود أو تم تعطيل حسابه.', 404);

  // 2. Get store + seller user
  const store = await prisma.store.findFirst({
    where: {
      OR: [
        { id: storeId },
        { slug: storeId },
        { sellerId: storeId },
        { seller: { userId: storeId } },
      ],
    },
    select: {
      id: true,
      slug: true,
      isActive: true,
      seller: { select: { userId: true, status: true } },
      enhancement: { select: { followerCount: true } },
    },
  });
  if (!store || !store.isActive) throw new AppError('المتجر غير موجود أو غير نشط حالياً.', 404);
  if (store.seller?.status === 'SUSPENDED' || store.seller?.status === 'REJECTED') {
    throw new AppError('هذا المتجر غير متاح حالياً.', 403);
  }

  const realStoreId = store.id;
  const followedUserId = store.seller?.userId;
  if (!followedUserId) throw new AppError('لم يتم العثور على مالك المتجر.', 404);

  // 3. Prevent self-follow
  if (followerUserId === followedUserId) throw new AppError('لا يمكنك متابعة متجرك الخاص.', 400);

  // 4. Block check:
  // If the target (seller) blocked the follower (customer), reject follow with clear message.
  if (await isBlockedBy(followedUserId, followerUserId)) {
    throw new AppError('لا يمكنك متابعة هذا المتجر لأن البائع قام بحظر حسابك.', 403);
  }

  // If the follower previously blocked the target seller, remove that block automatically.
  await prisma.userBlock.deleteMany({
    where: { blockerUserId: followerUserId, blockedUserId: followedUserId },
  });

  // 5. Privacy check
  if (!(await canFollow(followedUserId))) {
    throw new AppError('هذا المتجر لا يستقبل متابعات جديدة حالياً.', 403);
  }

  // 6. Atomic: create follow + update DB counters
  const type = FollowRelationshipType.CUSTOMER_TO_SELLER;
  let isNew = false;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.socialFollow.findUnique({
      where: {
        followerUserId_followedUserId_relationshipType: {
          followerUserId,
          followedUserId,
          relationshipType: type,
        },
      },
      select: { id: true },
    });

    if (existing) return; // Already following — idempotent
    isNew = true;

    await tx.socialFollow.create({
      data: { followerUserId, followedUserId, relationshipType: type, status: FollowStatus.FOLLOWING },
    });

    // Update DB follower counters
    await tx.followCounter.upsert({
      where: { userId_relationshipType: { userId: followedUserId, relationshipType: type } },
      update: { followerCount: { increment: 1 } },
      create: { userId: followedUserId, relationshipType: type, followerCount: 1, followingCount: 0 },
    });
    await tx.followCounter.upsert({
      where: { userId_relationshipType: { userId: followerUserId, relationshipType: type } },
      update: { followingCount: { increment: 1 } },
      create: { userId: followerUserId, relationshipType: type, followerCount: 0, followingCount: 1 },
    });

    // Update StoreEnhancement counter
    await tx.storeEnhancement.upsert({
      where: { storeId: realStoreId },
      update: { followerCount: { increment: 1 } },
      create: { storeId: realStoreId, followerCount: 1 },
    });
  });

  // 7. Update Redis counters and cache follow status
  if (isNew) {
    await Promise.all([
      redis.incr(KEYS.userFollowerCount(followedUserId, type)),
      redis.incr(KEYS.userFollowingCount(followerUserId, type)),
      redis.set(KEYS.followStatus(followerUserId, realStoreId, type), 'FOLLOWING', FOLLOW_STATUS_TTL),
      redis.set(KEYS.followStatus(followerUserId, store.slug, type), 'FOLLOWING', FOLLOW_STATUS_TTL),
      // Invalidate storefront cache for all keys
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${realStoreId}`),
      redis.del(`storefront:${store.slug}:${followerUserId}`),
      redis.del(`storefront:${realStoreId}:${followerUserId}`),
      // Queue notification
      queueNewFollowerNotification(followerUserId, followedUserId),
    ]);
  }

  // Return updated follower count
  const counter = await prisma.followCounter.findUnique({
    where: { userId_relationshipType: { userId: followedUserId, relationshipType: type } },
    select: { followerCount: true },
  });

  return {
    success: true,
    isFollowing: true,
    followerCount: counter?.followerCount ?? 0,
  };
}


/**
 * Customer unfollows a store.
 */
export async function unfollowStore(
  followerUserId: string,
  storeId: string
): Promise<{ success: boolean; isFollowing: boolean; followerCount: number }> {

  const store = await prisma.store.findFirst({
    where: {
      OR: [
        { id: storeId },
        { slug: storeId },
        { sellerId: storeId },
        { seller: { userId: storeId } },
      ],
    },
    select: { id: true, slug: true, seller: { select: { userId: true } } },
  });

  let realStoreId = store?.id;
  let followedUserId = store?.seller?.userId;
  const type = FollowRelationshipType.CUSTOMER_TO_SELLER;

  if (!store) {
    // If not found by store, check if storeId is actually a seller userId with a direct social follow
    const directFollow = await prisma.socialFollow.findFirst({
      where: {
        followerUserId,
        followedUserId: storeId,
        relationshipType: type,
      },
    });
    if (directFollow) {
      followedUserId = storeId;
    } else {
      throw new AppError('Store not found.', 404);
    }
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.socialFollow.findUnique({
      where: {
        followerUserId_followedUserId_relationshipType: {
          followerUserId,
          followedUserId: followedUserId!,
          relationshipType: type,
        },
      },
      select: { id: true },
    });

    if (!existing) return; // Already not following — idempotent

    await tx.socialFollow.delete({ where: { id: existing.id } });

    await tx.followCounter.updateMany({
      where: { userId: followedUserId, relationshipType: type },
      data: { followerCount: { decrement: 1 } },
    });
    await tx.followCounter.updateMany({
      where: { userId: followerUserId, relationshipType: type },
      data: { followingCount: { decrement: 1 } },
    });
    if (realStoreId) {
      await tx.storeEnhancement.updateMany({
        where: { storeId: realStoreId },
        data: { followerCount: { decrement: 1 } },
      });
    }
  });

  const redisTasks: Promise<any>[] = [
    redis.decr(KEYS.userFollowerCount(followedUserId!, type)),
    redis.decr(KEYS.userFollowingCount(followerUserId, type)),
    redis.del(KEYS.followStatus(followerUserId, followedUserId!, type)),
  ];

  if (realStoreId) {
    redisTasks.push(
      redis.del(KEYS.followStatus(followerUserId, realStoreId, type)),
      redis.del(`storefront:${realStoreId}`),
      redis.del(`storefront:${realStoreId}:${followerUserId}`)
    );
  }
  if (store?.slug) {
    redisTasks.push(
      redis.del(KEYS.followStatus(followerUserId, store.slug, type)),
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.slug}:${followerUserId}`)
    );
  }

  await Promise.all(redisTasks);

  const targetFollowedId = followedUserId || store?.seller?.userId || '';
  const counter = targetFollowedId
    ? await prisma.followCounter.findUnique({
        where: { userId_relationshipType: { userId: targetFollowedId, relationshipType: type } },
        select: { followerCount: true },
      })
    : null;

  return {
    success: true,
    isFollowing: false,
    followerCount: Math.max(0, counter?.followerCount ?? 0),
  };
}


/**
 * Seller follows a customer (SELLER_TO_CUSTOMER relationship).
 */
export async function followCustomer(
  sellerUserId: string,
  customerId: string
): Promise<void> {
  // Verify actor is a seller or admin
  const actor = await prisma.user.findUnique({
    where: { id: sellerUserId },
    select: { role: true, isActive: true },
  });
  if (!actor || !actor.isActive) throw new AppError('User not found or inactive.', 404);
  if (actor.role !== UserRoleType.SELLER && actor.role !== UserRoleType.ADMIN) {
    throw new AppError('Only sellers may follow customers.', 403);
  }

  // Verify target is an active user (check User id or Customer id)
  let target = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) {
    const cust = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { user: { select: { id: true, role: true, isActive: true } } },
    });
    if (cust?.user) {
      target = cust.user;
    }
  }

  if (!target || !target.isActive) throw new AppError('User not found or inactive.', 404);

  const targetUserId = target.id;

  if (sellerUserId === targetUserId) throw new AppError('Cannot follow yourself.', 400);

  if (await isBlockedBy(targetUserId, sellerUserId)) {
    throw new AppError('Unable to follow this user.', 403);
  }

  // If the seller previously blocked the customer, remove that block automatically.
  await prisma.userBlock.deleteMany({
    where: { blockerUserId: sellerUserId, blockedUserId: targetUserId },
  });

  if (!(await canFollow(targetUserId))) {
    throw new AppError('This customer does not accept followers.', 403);
  }

  const type = FollowRelationshipType.SELLER_TO_CUSTOMER;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.socialFollow.findUnique({
      where: {
        followerUserId_followedUserId_relationshipType: {
          followerUserId: sellerUserId,
          followedUserId: targetUserId,
          relationshipType: type,
        },
      },
      select: { id: true },
    });

    if (existing) return;

    await tx.socialFollow.create({
      data: { followerUserId: sellerUserId, followedUserId: targetUserId, relationshipType: type, status: FollowStatus.FOLLOWING },
    });
    await tx.followCounter.upsert({
      where: { userId_relationshipType: { userId: targetUserId, relationshipType: type } },
      update: { followerCount: { increment: 1 } },
      create: { userId: targetUserId, relationshipType: type, followerCount: 1, followingCount: 0 },
    });
    await tx.followCounter.upsert({
      where: { userId_relationshipType: { userId: sellerUserId, relationshipType: type } },
      update: { followingCount: { increment: 1 } },
      create: { userId: sellerUserId, relationshipType: type, followerCount: 0, followingCount: 1 },
    });
  });

  await Promise.all([
    redis.incr(KEYS.userFollowerCount(targetUserId, type)),
    redis.incr(KEYS.userFollowingCount(sellerUserId, type)),
    redis.set(KEYS.followStatus(sellerUserId, targetUserId, type), 'FOLLOWING', FOLLOW_STATUS_TTL),
  ]);
}

/**
 * Seller unfollows a customer.
 */
export async function unfollowCustomer(
  sellerUserId: string,
  customerId: string
): Promise<void> {
  let targetUserId = customerId;
  const user = await prisma.user.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!user) {
    const cust = await prisma.customer.findUnique({ where: { id: customerId }, select: { userId: true } });
    if (cust) targetUserId = cust.userId;
  }

  const type = FollowRelationshipType.SELLER_TO_CUSTOMER;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.socialFollow.findUnique({
      where: {
        followerUserId_followedUserId_relationshipType: {
          followerUserId: sellerUserId,
          followedUserId: targetUserId,
          relationshipType: type,
        },
      },
      select: { id: true },
    });
    if (!existing) return;

    await tx.socialFollow.delete({ where: { id: existing.id } });
    await tx.followCounter.updateMany({
      where: { userId: targetUserId, relationshipType: type },
      data: { followerCount: { decrement: 1 } },
    });
    await tx.followCounter.updateMany({
      where: { userId: sellerUserId, relationshipType: type },
      data: { followingCount: { decrement: 1 } },
    });
  });

  await Promise.all([
    redis.decr(KEYS.userFollowerCount(targetUserId, type)),
    redis.decr(KEYS.userFollowingCount(sellerUserId, type)),
    redis.del(KEYS.followStatus(sellerUserId, targetUserId, type)),
  ]);
}

/**
 * Seller removes a customer from their store followers (CUSTOMER_TO_SELLER relationship).
 */
export async function removeStoreFollower(
  sellerUserId: string,
  customerId: string
): Promise<void> {
  let targetUserId = customerId;
  const user = await prisma.user.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!user) {
    const cust = await prisma.customer.findUnique({ where: { id: customerId }, select: { userId: true } });
    if (cust) targetUserId = cust.userId;
  }

  const type = FollowRelationshipType.CUSTOMER_TO_SELLER;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.socialFollow.findUnique({
      where: {
        followerUserId_followedUserId_relationshipType: {
          followerUserId: targetUserId,
          followedUserId: sellerUserId,
          relationshipType: type,
        },
      },
      select: { id: true },
    });
    if (!existing) return;

    await tx.socialFollow.delete({ where: { id: existing.id } });
    await tx.followCounter.updateMany({
      where: { userId: sellerUserId, relationshipType: type },
      data: { followerCount: { decrement: 1 } },
    });
    await tx.followCounter.updateMany({
      where: { userId: targetUserId, relationshipType: type },
      data: { followingCount: { decrement: 1 } },
    });
  });

  // Invalidate redis storefront cache for the seller's stores
  const stores = await prisma.store.findMany({
    where: { seller: { userId: sellerUserId } },
    select: { id: true, slug: true },
  });
  const delKeys: string[] = [
    KEYS.userFollowerCount(sellerUserId, type),
    KEYS.followStatus(targetUserId, sellerUserId, type),
  ];
  for (const s of stores) {
    delKeys.push(
      `storefront:${s.slug}`,
      `storefront:${s.id}`,
      `storefront:${s.slug}:${targetUserId}`,
      `storefront:${s.id}:${targetUserId}`
    );
  }
  await Promise.all(delKeys.map((k) => redis.del(k)));
}

/**
 * Get follow status for a user → store relationship (customer perspective).
 * Uses Redis cache (300s TTL) with DB fallback.
 */
export async function getFollowStatus(
  followerUserId: string,
  storeId: string
): Promise<'FOLLOWING' | 'NOT_FOLLOWING' | 'BLOCKED'> {
  const type = FollowRelationshipType.CUSTOMER_TO_SELLER;

  // 1. Check block first (not cached)
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { seller: { select: { userId: true } } },
  });
  if (!store) return 'NOT_FOLLOWING';

  const followedUserId = store.seller.userId;
  if (await isBlocked(followerUserId, followedUserId)) return 'BLOCKED';

  // 2. Redis cache
  const cached = await redis.get(KEYS.followStatus(followerUserId, storeId, type));
  if (cached === 'FOLLOWING') return 'FOLLOWING';
  if (cached === 'NOT_FOLLOWING') return 'NOT_FOLLOWING';

  // 3. DB fallback
  const follow = await prisma.socialFollow.findUnique({
    where: {
      followerUserId_followedUserId_relationshipType: {
        followerUserId,
        followedUserId,
        relationshipType: type,
      },
    },
    select: { status: true },
  });

  const status = follow ? 'FOLLOWING' : 'NOT_FOLLOWING';
  await redis.set(KEYS.followStatus(followerUserId, storeId, type), status, FOLLOW_STATUS_TTL);
  return status;
}

/**
 * Reconcile follower/following counters for a user from actual DB count.
 * Called by the nightly background job to fix counter drift.
 */
export async function reconcileCounters(
  userId: string,
  type: FollowRelationshipType
): Promise<void> {
  const [followerCount, followingCount] = await Promise.all([
    prisma.socialFollow.count({
      where: { followedUserId: userId, relationshipType: type, status: FollowStatus.FOLLOWING },
    }),
    prisma.socialFollow.count({
      where: { followerUserId: userId, relationshipType: type, status: FollowStatus.FOLLOWING },
    }),
  ]);

  await prisma.followCounter.upsert({
    where: { userId_relationshipType: { userId, relationshipType: type } },
    update: { followerCount, followingCount },
    create: { userId, relationshipType: type, followerCount, followingCount },
  });

  await Promise.all([
    redis.setCounter(KEYS.userFollowerCount(userId, type), followerCount),
    redis.setCounter(KEYS.userFollowingCount(userId, type), followingCount),
  ]);

  // If CUSTOMER_TO_SELLER, also update StoreEnhancement for the seller's store
  if (type === FollowRelationshipType.CUSTOMER_TO_SELLER) {
    const seller = await prisma.seller.findUnique({
      where: { userId },
      select: { stores: { select: { id: true } } },
    });
    if (seller?.stores[0]) {
      await prisma.storeEnhancement.upsert({
        where: { storeId: seller.stores[0].id },
        update: { followerCount },
        create: { storeId: seller.stores[0].id, followerCount },
      });
    }
  }
}
