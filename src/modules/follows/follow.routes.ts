import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { authenticate } from '../../middleware/auth.middleware';
import { requireCustomer, requireSeller } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { followLimiter } from '../../middleware/rate-limiter.middleware';
import {
  followStore,
  unfollowStore,
  followCustomer,
  unfollowCustomer,
  removeStoreFollower,
  getFollowStatus,
} from './follow.service';
import { FollowRelationshipType } from '@prisma/client';

const router = Router();

// ── Optional auth middleware (attaches user if token present, proceeds without) ─────────
async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.headers.authorization) {
    return authenticate(req, res, next);
  }
  next();
}

// ── Customer → Follow/Unfollow Store ────────────────────────────────────────────

/**
 * POST /api/v1/follows/stores/:storeId
 * Customer follows a store. Idempotent.
 */
router.post(
  '/stores/:storeId',
  authenticate,
  followLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = String(req.params.storeId);
      const result = await followStore(req.user!.userId, storeId);
      ResponseUtil.success(res, {
        success: true,
        isFollowing: true,
        followerCount: result.followerCount,
      }, 'تمت المتابعة بنجاح');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/follows/stores/:storeId
 * Customer unfollows a store. Idempotent.
 */
router.delete(
  '/stores/:storeId',
  authenticate,
  followLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = String(req.params.storeId);
      const result = await unfollowStore(req.user!.userId, storeId);
      ResponseUtil.success(res, {
        success: true,
        isFollowing: false,
        followerCount: result.followerCount,
      }, 'تم إلغاء المتابعة بنجاح');
    } catch (error) {
      next(error);
    }
  }
);


/**
 * GET /api/v1/follows/stores/:storeId/status
 * Get follow status for a store (optional auth — guests always NOT_FOLLOWING).
 */
router.get(
  '/stores/:storeId/status',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = String(req.params.storeId);

      if (!req.user) {
        return ResponseUtil.success(res, { status: 'NOT_FOLLOWING', isFollowing: false });
      }

      const status = await getFollowStatus(req.user.userId, storeId);
      ResponseUtil.success(res, { status, isFollowing: status === 'FOLLOWING' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/stores/:storeId/followers
 * Paginated list of store followers (cursor-based, most recent first).
 * Safe public data only (avatar, firstName, lastName, createdAt of follow).
 */
router.get(
  '/stores/:storeId/followers',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = String(req.params.storeId);
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;

      const store = await prisma.store.findFirst({
        where: { OR: [{ id: storeId }, { slug: storeId }, { sellerId: storeId }], isActive: true },
        select: { id: true, name: true, slug: true, seller: { select: { userId: true } }, isActive: true },
      });
      if (!store || !store.isActive) throw new AppError('Store not found.', 404);

      const follows = await prisma.socialFollow.findMany({
        where: {
          followedUserId: store.seller.userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          createdAt: true,
          follower: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;
      const nextCursor = hasNext ? items[items.length - 1].id : null;

      ResponseUtil.success(res, {
        items: items.map((f) => ({
          followId: f.id,
          followedAt: f.createdAt,
          user: f.follower,
        })),
        nextCursor,
        hasMore: hasNext,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/stores/:storeId/following
 * Paginated list of users/customers followed by the store.
 */
router.get(
  '/stores/:storeId/following',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = String(req.params.storeId);
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;

      const store = await prisma.store.findFirst({
        where: { OR: [{ id: storeId }, { slug: storeId }, { sellerId: storeId }], isActive: true },
        select: { id: true, name: true, slug: true, seller: { select: { userId: true } }, isActive: true },
      });
      if (!store || !store.isActive) throw new AppError('Store not found.', 404);

      const follows = await prisma.socialFollow.findMany({
        where: {
          followerUserId: store.seller.userId,
          relationshipType: FollowRelationshipType.SELLER_TO_CUSTOMER,
          status: 'FOLLOWING',
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          createdAt: true,
          followed: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;
      const nextCursor = hasNext ? items[items.length - 1].id : null;

      ResponseUtil.success(res, {
        items: items.map((f) => ({
          followId: f.id,
          followedAt: f.createdAt,
          user: f.followed,
        })),
        nextCursor,
        hasMore: hasNext,
      });
    } catch (error) {
      next(error);
    }
  }
);


/**
 * GET /api/v1/follows/me/following/stores
 * My followed stores (customer view). Requires auth.
 */
router.get(
  ['/me/following/stores', '/me/following', '/my/following', '/my/following/stores'],
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.userId) {
        return ResponseUtil.success(res, { items: [], nextCursor: null, hasMore: false });
      }
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;

      const follows = await prisma.socialFollow.findMany({
        where: {
          followerUserId: req.user!.userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          createdAt: true,
          followerUserId: true,
          followedUserId: true,
          relationshipType: true,
          status: true,
          followed: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              seller: {
                select: {
                  id: true,
                  stores: {
                    select: {
                      id: true,
                      sellerId: true,
                      name: true,
                      slug: true,
                      logo: true,
                      rating: true,
                      reviewCount: true,
                      isActive: true,
                      isVerified: true,
                      enhancement: {
                        select: { followerCount: true, logoMedium: true, logoSmall: true },
                      },
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;

      ResponseUtil.success(res, {
        items: items.map((f) => {
          const store = f.followed.seller?.stores[0];
          return {
            id: f.id,
            followId: f.id,
            followerUserId: f.followerUserId,
            followedUserId: f.followedUserId,
            relationshipType: f.relationshipType,
            status: f.status,
            createdAt: f.createdAt,
            followedAt: f.createdAt,
            followedUser: {
              id: f.followed.id,
              firstName: f.followed.firstName,
              lastName: f.followed.lastName,
              avatar: f.followed.avatar,
            },
            store: store
              ? {
                  id: store.id,
                  sellerId: store.sellerId ?? f.followedUserId,
                  sellerUserId: f.followedUserId,
                  name: store.name,
                  slug: store.slug,
                  logo: store.enhancement?.logoMedium ?? store.enhancement?.logoSmall ?? store.logo,
                  rating: store.rating,
                  reviewCount: store.reviewCount,
                  isActive: store.isActive,
                  isVerified: store.isVerified,
                  followerCount: store.enhancement?.followerCount ?? 0,
                }
              : null,
          };
        }),
        nextCursor: hasNext ? items[items.length - 1].id : null,
        hasMore: hasNext,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/me/followers
 * Who follows me (customer — lists sellers/customers who follow me).
 */
router.get(
  ['/me/followers', '/my/followers'],
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.userId) {
        return ResponseUtil.success(res, { items: [], nextCursor: null, hasMore: false });
      }
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;

      const follows = await prisma.socialFollow.findMany({
        where: {
          followedUserId: req.user!.userId,
          status: 'FOLLOWING',
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          createdAt: true,
          followerUserId: true,
          followedUserId: true,
          relationshipType: true,
          status: true,
          follower: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              role: true,
              seller: {
                select: {
                  stores: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                      logo: true,
                      rating: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;

      ResponseUtil.success(res, {
        items: items.map((f) => {
          const store = f.follower.seller?.stores[0];
          return {
            id: f.id,
            followId: f.id,
            followerUserId: f.followerUserId,
            followedUserId: f.followedUserId,
            followedAt: f.createdAt,
            createdAt: f.createdAt,
            relationshipType: f.relationshipType,
            status: f.status,
            follower: {
              id: f.follower.id,
              firstName: f.follower.firstName,
              lastName: f.follower.lastName,
              avatar: f.follower.avatar,
              role: f.follower.role,
            },
            user: {
              id: f.follower.id,
              firstName: f.follower.firstName,
              lastName: f.follower.lastName,
              avatar: f.follower.avatar,
              role: f.follower.role,
            },
            store: store
              ? {
                  id: store.id,
                  name: store.name,
                  slug: store.slug,
                  logo: store.logo,
                  rating: store.rating,
                }
              : null,
          };
        }),
        nextCursor: hasNext ? items[items.length - 1].id : null,
        hasMore: hasNext,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/users/:userId/profile
 * Public customer profile — only safe, non-private fields.
 * Does NOT expose email, phone, password, addresses, payment info.
 */
router.get(
  '/users/:userId/profile',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetId = String(req.params.userId);

      // Check block (viewer must not be blocked by / have blocked the target)
      if (req.user) {
        const blocked = await prisma.userBlock.findFirst({
          where: {
            OR: [
              { blockerUserId: req.user.userId, blockedUserId: targetId },
              { blockerUserId: targetId, blockedUserId: req.user.userId },
            ],
          },
          select: { id: true },
        });
        if (blocked) throw new AppError('Profile not available.', 403);
      }

      const user = await prisma.user.findUnique({
        where: { id: targetId, isActive: true },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatar: true,
          role: true,
          createdAt: true,
          followPrivacy: { select: { whoCanFollow: true } },
          followCounters: { select: { relationshipType: true, followerCount: true, followingCount: true } },
        },
      });
      if (!user) throw new AppError('User not found.', 404);

      // Get follow status if viewer is logged in
      let viewerFollowsTarget = false;
      if (req.user && req.user.userId !== targetId) {
        const follow = await prisma.socialFollow.findFirst({
          where: {
            followerUserId: req.user.userId,
            followedUserId: targetId,
            status: 'FOLLOWING',
          },
          select: { id: true },
        });
        viewerFollowsTarget = !!follow;
      }

      ResponseUtil.success(res, {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        joinedAt: user.createdAt,
        privacy: user.followPrivacy?.whoCanFollow ?? 'PUBLIC',
        counters: user.followCounters,
        viewerFollows: viewerFollowsTarget,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── Block/Unblock ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/follows/blocked, /blocks, /me/blocked, /seller/blocked
 * Get list of blocked users/stores for the authenticated user.
 */
router.get(
  ['/blocked', '/blocks', '/me/blocked', '/seller/blocked', '/seller/blocks'],
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const blockerUserId = req.user!.userId;
      const blocks = await prisma.userBlock.findMany({
        where: { blockerUserId },
        orderBy: { createdAt: 'desc' },
        include: {
          blocked: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              role: true,
              seller: {
                select: {
                  stores: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                      logo: true,
                      rating: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      const formatted = blocks.map((b) => {
        const store = b.blocked.seller?.stores[0];
        return {
          id: b.id,
          blockId: b.id,
          blockerUserId: b.blockerUserId,
          blockedUserId: b.blockedUserId,
          reason: b.reason,
          createdAt: b.createdAt,
          blockedUser: {
            id: b.blocked.id,
            firstName: b.blocked.firstName,
            lastName: b.blocked.lastName,
            avatar: b.blocked.avatar,
            role: b.blocked.role,
          },
          store: store
            ? {
                id: store.id,
                name: store.name,
                slug: store.slug,
                logo: store.logo,
                rating: store.rating,
              }
            : null,
        };
      });

      ResponseUtil.success(res, { items: formatted, total: formatted.length });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/follows/block/:userId
 * Block a user or store. Automatically removes any existing follows between them.
 */
router.post(
  ['/block/:userId', '/users/:userId/block', '/seller/block/:userId', '/stores/:userId/block', '/store/:userId/block'],
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetParam = String(req.params.userId);
      const blockerUserId = req.user!.userId;
      const { reason } = req.body ?? {};

      // Check if targetParam is a user or store
      let blockedUserId = targetParam;
      const user = await prisma.user.findUnique({ where: { id: targetParam }, select: { id: true } });
      if (!user) {
        const store = await prisma.store.findFirst({
          where: { OR: [{ id: targetParam }, { slug: targetParam }, { sellerId: targetParam }] },
          select: { seller: { select: { userId: true } } },
        });
        if (store?.seller?.userId) {
          blockedUserId = store.seller.userId;
        }
      }

      if (blockerUserId === blockedUserId) throw new AppError('Cannot block yourself.', 400);

      await prisma.$transaction(async (tx) => {
        await tx.userBlock.upsert({
          where: { blockerUserId_blockedUserId: { blockerUserId, blockedUserId } },
          update: { reason: reason ?? undefined },
          create: { blockerUserId, blockedUserId, reason: reason ?? null },
        });
        // Remove all follow relationships between the two users
        await tx.socialFollow.deleteMany({
          where: {
            OR: [
              { followerUserId: blockerUserId, followedUserId: blockedUserId },
              { followerUserId: blockedUserId, followedUserId: blockerUserId },
            ],
          },
        });
      });

      // Invalidate Redis storefront caches if blocker or blocked is a seller
      const stores = await prisma.store.findMany({
        where: {
          OR: [
            { seller: { userId: blockerUserId } },
            { seller: { userId: blockedUserId } },
          ],
        },
        select: { id: true, slug: true },
      });
      const delKeys: string[] = [];
      for (const s of stores) {
        delKeys.push(
          `storefront:${s.slug}`,
          `storefront:${s.id}`,
          `storefront:${s.slug}:${blockedUserId}`,
          `storefront:${s.id}:${blockedUserId}`,
          `storefront:${s.slug}:${blockerUserId}`,
          `storefront:${s.id}:${blockerUserId}`
        );
      }
      if (delKeys.length) {
        await Promise.all(delKeys.map((k) => redis.del(k)));
      }

      ResponseUtil.success(res, { success: true }, 'تم الحظر بنجاح');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/follows/block/:userId
 * Unblock a user or store.
 */
router.delete(
  ['/block/:userId', '/users/:userId/block', '/seller/block/:userId', '/stores/:userId/block', '/store/:userId/block'],
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let targetParam = String(req.params.userId);
      const blockerUserId = req.user!.userId;

      let blockedUserId = targetParam;
      const user = await prisma.user.findUnique({ where: { id: targetParam }, select: { id: true } });
      if (!user) {
        const store = await prisma.store.findFirst({
          where: { OR: [{ id: targetParam }, { slug: targetParam }, { sellerId: targetParam }] },
          select: { seller: { select: { userId: true } } },
        });
        if (store?.seller?.userId) {
          blockedUserId = store.seller.userId;
        }
      }

      await prisma.userBlock.deleteMany({
        where: { blockerUserId, blockedUserId },
      });

      ResponseUtil.success(res, { success: true }, 'تم رفع الحظر بنجاح');
    } catch (error) {
      next(error);
    }
  }
);

// ── Privacy Settings ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/follows/me/privacy
 * Get my follow privacy settings.
 */
router.get(
  '/me/privacy',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const privacy = await prisma.userFollowPrivacy.findUnique({
        where: { userId: req.user!.userId },
      });
      ResponseUtil.success(res, {
        whoCanFollow: privacy?.whoCanFollow ?? 'PUBLIC',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/follows/me/privacy
 * Update my follow privacy settings.
 */
router.patch(
  '/me/privacy',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { whoCanFollow } = req.body;
      if (!['PUBLIC', 'PRIVATE', 'NOBODY'].includes(whoCanFollow)) {
        throw new AppError('قيمة غير صحيحة. الخيارات: PUBLIC, PRIVATE, NOBODY', 400);
      }

      const privacy = await prisma.userFollowPrivacy.upsert({
        where: { userId: req.user!.userId },
        update: { whoCanFollow },
        create: { userId: req.user!.userId, whoCanFollow },
      });

      ResponseUtil.success(res, privacy, 'تم تحديث إعدادات الخصوصية بنجاح');
    } catch (error) {
      next(error);
    }
  }
);

// ── Seller → Follow/Unfollow Customer ───────────────────────────────────────────

/**
 * POST /api/v1/follows/seller/customers/:customerId & /seller/follow/:customerId
 * Seller follows a customer.
 */
router.post(
  ['/seller/customers/:customerId', '/seller/follow/:customerId'],
  authenticate,
  requireSeller,
  followLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = String(req.params.customerId);
      await followCustomer(req.user!.userId, customerId);
      ResponseUtil.success(
        res,
        { success: true, isFollowing: true, followerCount: 0 },
        'تمت متابعة العميل بنجاح'
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/follows/seller/customers/:customerId & /seller/follow/:customerId
 * Seller unfollows a customer.
 */
router.delete(
  ['/seller/customers/:customerId', '/seller/follow/:customerId'],
  authenticate,
  requireSeller,
  followLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = String(req.params.customerId);
      await unfollowCustomer(req.user!.userId, customerId);
      ResponseUtil.success(
        res,
        { success: true, isFollowing: false, followerCount: 0 },
        'تم إلغاء المتابعة بنجاح'
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/follows/seller/followers/:customerId
 * Seller removes a customer from their store followers.
 */
router.delete(
  ['/seller/followers/:customerId', '/seller/followers/remove/:customerId'],
  authenticate,
  requireSeller,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = String(req.params.customerId);
      await removeStoreFollower(req.user!.userId, customerId);
      ResponseUtil.success(
        res,
        { success: true, isFollowing: false },
        'تمت إزالة المتابع من المتجر بنجاح'
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/seller/following
 * Paginated list of customers the seller follows.
 */
router.get(
  '/seller/following',
  authenticate,
  requireSeller,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;

      const follows = await prisma.socialFollow.findMany({
        where: {
          followerUserId: req.user!.userId,
          relationshipType: FollowRelationshipType.SELLER_TO_CUSTOMER,
          status: 'FOLLOWING',
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          followerUserId: true,
          followedUserId: true,
          relationshipType: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          followed: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              createdAt: true,
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;

      const formatted = items.map((f) => ({
        id: f.id,
        followId: f.id,
        followerUserId: f.followerUserId,
        followedUserId: f.followedUserId,
        relationshipType: f.relationshipType,
        status: f.status,
        createdAt: f.createdAt,
        followedAt: f.createdAt,
        updatedAt: f.updatedAt,
        followedUser: f.followed,
        customer: f.followed,
        isFollowingBack: true,
      }));

      ResponseUtil.success(res, {
        items: formatted,
        nextCursor: hasNext ? items[items.length - 1].id : null,
        hasMore: hasNext,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/seller/followers
 * Paginated list of customers following the seller's store.
 */
router.get(
  '/seller/followers',
  authenticate,
  requireSeller,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
      const cursor = req.query.cursor as string | undefined;
      const search = req.query.search as string | undefined;

      const follows = await prisma.socialFollow.findMany({
        where: {
          followedUserId: req.user!.userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
          ...(search
            ? {
                follower: {
                  OR: [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                  ],
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          followerUserId: true,
          followedUserId: true,
          relationshipType: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          follower: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
        },
      });

      const hasNext = follows.length > limit;
      const items = hasNext ? follows.slice(0, limit) : follows;

      // Check which of these followers the seller also follows back
      const customerUserIds = items.map((f) => f.followerUserId);
      const followingBack = await prisma.socialFollow.findMany({
        where: {
          followerUserId: req.user!.userId,
          followedUserId: { in: customerUserIds },
          relationshipType: FollowRelationshipType.SELLER_TO_CUSTOMER,
          status: 'FOLLOWING',
        },
        select: { followedUserId: true },
      });
      const followingBackSet = new Set(followingBack.map((f) => f.followedUserId));

      const formatted = items.map((f) => ({
        id: f.id,
        followId: f.id,
        followerUserId: f.followerUserId,
        followedUserId: f.followedUserId,
        relationshipType: f.relationshipType,
        status: f.status,
        createdAt: f.createdAt,
        followedAt: f.createdAt,
        updatedAt: f.updatedAt,
        follower: f.follower,
        customer: f.follower,
        isFollowingBack: followingBackSet.has(f.followerUserId),
      }));

      // Get total count for display
      const totalCount = await prisma.socialFollow.count({
        where: {
          followedUserId: req.user!.userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
        },
      });

      ResponseUtil.paginated(
        res,
        formatted,
        totalCount,
        1,
        limit,
        undefined
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/follows/seller/analytics
 * Follow analytics for the seller dashboard.
 */
router.get(
  '/seller/analytics',
  authenticate,
  requireSeller,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Get seller's store
      const seller = await prisma.seller.findUnique({
        where: { userId },
        select: {
          stores: {
            select: { id: true, enhancement: { select: { followerCount: true, newFollowersToday: true, newFollowersWeek: true, newFollowersMonth: true } } },
            take: 1,
          },
        },
      });

      const store = seller?.stores[0];
      const enhancement = store?.enhancement;

      // Total followers
      const totalFollowers = await prisma.socialFollow.count({
        where: {
          followedUserId: userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
        },
      });

      // New followers in the last 30 days with daily breakdown
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const newFollowers30d = await prisma.socialFollow.findMany({
        where: {
          followedUserId: userId,
          relationshipType: FollowRelationshipType.CUSTOMER_TO_SELLER,
          status: 'FOLLOWING',
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      // Group by date
      const dailyBreakdown: Record<string, number> = {};
      for (const f of newFollowers30d) {
        const dateKey = f.createdAt.toISOString().slice(0, 10);
        dailyBreakdown[dateKey] = (dailyBreakdown[dateKey] ?? 0) + 1;
      }

      // Following count (customers seller follows)
      const followingCount = await prisma.socialFollow.count({
        where: {
          followerUserId: userId,
          relationshipType: FollowRelationshipType.SELLER_TO_CUSTOMER,
          status: 'FOLLOWING',
        },
      });

      ResponseUtil.success(res, {
        totalFollowers,
        followingCount,
        newFollowersToday: enhancement?.newFollowersToday ?? 0,
        newFollowersWeek: enhancement?.newFollowersWeek ?? 0,
        newFollowersMonth: enhancement?.newFollowersMonth ?? 0,
        last30Days: {
          count: newFollowers30d.length,
          daily: dailyBreakdown,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export const followRoutes = router;
