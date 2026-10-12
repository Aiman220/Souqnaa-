import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { optionalAuth } from '../../middleware/auth.middleware';
import { storefrontLimiter } from '../../middleware/rate-limiter.middleware';
import { VoucherService } from '../vouchers/voucher.service';
import { SellerPerformanceService } from '../seller-performance/seller-performance.service';

const router = Router();

const STOREFRONT_TTL = 60; // 1 minute Redis TTL

// Helper: resolve store by id OR slug
async function resolveStore(idOrSlug: string) {
  return prisma.store.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }, { sellerId: idOrSlug }], isActive: true },
    select: {
      id: true,
      sellerId: true,
      name: true,
      slug: true,
      description: true,
      logo: true,
      cover: true,
      rating: true,
      reviewCount: true,
      isActive: true,
      isVerified: true,
      isOpen: true,
      openingTime: true,
      closingTime: true,
      acceptsExpress: true,
      acceptsScheduled: true,
      busyMode: true,
      closedReason: true,
      latitude: true,
      longitude: true,
      createdAt: true,
      seller: {
        select: {
          id: true,
          userId: true,
          status: true,
          businessType: true,
          user: { select: { phone: true, email: true } },
        },
      },
      enhancement: true,
      addresses: {
        include: { city: true, district: true },
        take: 1,
      },
    },
  });
}

// ── List active stores ────────────────────────────────────────────────────────

// GET /api/v1/stores
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stores = await prisma.store.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { products: { where: { isActive: true } } } },
        enhancement: { select: { followerCount: true, logoMedium: true, logoSmall: true } },
      },
      orderBy: { rating: 'desc' },
      take: 20,
    });
    ResponseUtil.success(res, stores);
  } catch (error) {
    next(error);
  }
});

// ── Storefront endpoints (must come before /:id to avoid route conflict) ──────

/**
 * GET /api/v1/stores/:slug/storefront
 * Full storefront aggregation — the main seller page.
 * Cached in Redis for 60 seconds.
 */
router.get('/:slug/storefront', optionalAuth, storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const customerId = (req as any).user?.userId;
    const cacheKey = customerId ? `storefront:${slug}:${customerId}` : `storefront:${slug}`;

    const cached = await redis.getJson<any>(cacheKey);
    if (cached && cached.performance !== undefined && cached.performance !== null) {
      res.setHeader('X-Cache', 'HIT');
      return ResponseUtil.success(res, cached);
    }

    const store = await resolveStore(slug);
    if (!store) throw new AppError('Store not found', 404);
    if (store.seller.status !== 'ACTIVE') throw new AppError('This store is not available.', 403);

    const storeId = store.id;
    const sellerId = store.sellerId;
    const sellerUserId = store.seller.userId;

    const [popularProducts, activeVouchers, flashSaleItems, ratingBreakdown, productCount, followerCounter, followRecord, storeCategories, performance] =
      await Promise.all([
        prisma.product.findMany({
          where: { storeId, isActive: true, isSuspended: false },
          include: {
            images: { where: { isPrimary: true }, take: 1 },
          },
          orderBy: [{ rating: 'desc' }, { soldCount: 'desc' }],
          take: 8,
        }),
        VoucherService.getStoreVouchers(sellerId, customerId),
        prisma.flashSaleItem.findMany({
          where: {
            product: { storeId },
            campaign: { status: 'ACTIVE', startAt: { lte: new Date() }, endAt: { gt: new Date() } },
          },
          include: {
            product: { include: { images: { where: { isPrimary: true }, take: 1 } } },
            campaign: { select: { id: true, name: true, endAt: true } },
          },
          take: 8,
        }),
        prisma.productReview.groupBy({
          by: ['rating'],
          where: { product: { storeId }, status: 'PUBLISHED', deletedAt: null },
          _count: { id: true },
        }),
        prisma.product.count({ where: { storeId, isActive: true, isSuspended: false } }),
        prisma.followCounter.findUnique({
          where: { userId_relationshipType: { userId: sellerUserId, relationshipType: 'CUSTOMER_TO_SELLER' } },
          select: { followerCount: true },
        }),
        customerId && sellerUserId
          ? prisma.socialFollow.findUnique({
              where: {
                followerUserId_followedUserId_relationshipType: {
                  followerUserId: customerId,
                  followedUserId: sellerUserId,
                  relationshipType: 'CUSTOMER_TO_SELLER',
                },
              },
              select: { id: true },
            })
          : Promise.resolve(null),
        prisma.category.findMany({
          where: { products: { some: { storeId, isActive: true, isSuspended: false } } },
          include: {
            _count: { select: { products: { where: { storeId, isActive: true, isSuspended: false } } } },
          },
          orderBy: { sortOrder: 'asc' },
        }),
        SellerPerformanceService.getPublicSellerPerformance(sellerId).catch(() => null),
      ]);

    const ratingMap: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalReviews = 0;
    for (const r of ratingBreakdown) {
      const cnt = (r._count as { id?: number })?.id ?? 0;
      ratingMap[r.rating] = cnt;
      totalReviews += cnt;
    }

    const storefront = {
      store: {
        id: store.id,
        sellerId: store.sellerId,
        sellerUserId: store.seller.userId,
        name: store.name,
        slug: store.slug,
        description: store.description,
        logo: store.enhancement?.logoMedium ?? store.enhancement?.logoSmall ?? store.logo,
        logoOriginal: store.enhancement?.logoOriginal ?? store.logo,
        cover: store.cover,
        rating: store.rating,
        reviewCount: store.reviewCount,
        isActive: store.isActive,
        isVerified: store.isVerified,
        isOpen: store.isOpen,
        openingTime: store.openingTime,
        closingTime: store.closingTime,
        acceptsExpress: store.acceptsExpress,
        acceptsScheduled: store.acceptsScheduled,
        busyMode: store.busyMode,
        closedReason: store.closedReason,
        phone: store.seller.user?.phone ?? null,
        email: store.seller.user?.email ?? null,
        latitude: store.latitude,
        longitude: store.longitude,
        joinedDate: store.enhancement?.joinedDate ?? store.createdAt,
        responseRate: store.enhancement?.responseRate ?? null,
        responseTimeMinutes: store.enhancement?.responseTimeMinutes ?? null,
        totalSoldCount: store.enhancement?.totalSoldCount ?? 0,
        address: store.addresses[0] ?? null,
        businessType: store.seller.businessType,
        performance,
      },
      banner: store.enhancement && (store.enhancement.bannerDesktop || store.enhancement.bannerMobile)
        ? {
            desktop: store.enhancement.bannerDesktop,
            tablet: store.enhancement.bannerTablet,
            mobile: store.enhancement.bannerMobile,
            titleAr: store.enhancement.bannerTitleAr,
            titleEn: store.enhancement.bannerTitleEn,
            subtitleAr: store.enhancement.bannerSubtitleAr,
            subtitleEn: store.enhancement.bannerSubtitleEn,
            ctaTextAr: store.enhancement.bannerCtaTextAr,
            ctaTextEn: store.enhancement.bannerCtaTextEn,
            ctaUrl: store.enhancement.bannerCtaUrl,
          }
        : null,
      social: {
        followerCount: followerCounter?.followerCount ?? store.enhancement?.followerCount ?? 0,
        followingCount: store.enhancement?.followingCount ?? 0,
        isFollowing: !!followRecord,
      },
      stats: {
        productCount,
        reviewCount: totalReviews,
        averageRating: store.rating,
        totalSoldCount: store.enhancement?.totalSoldCount ?? 0,
      },
      ratingBreakdown: ratingMap,
      popularProducts,
      categories: storeCategories.map(c => ({
        id: c.id,
        name: c.nameAr || c.nameEn,
        nameAr: c.nameAr,
        nameEn: c.nameEn,
        slug: c.slug,
        icon: c.icon,
        image: c.image,
        parentId: c.parentId,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        productCount: (c as any)._count?.products ?? 0,
      })),
      vouchers: activeVouchers,
      flashSaleItems,
      performance,
    };

    await redis.setJson(cacheKey, storefront, STOREFRONT_TTL);
    res.setHeader('X-Cache', 'MISS');
    ResponseUtil.success(res, storefront);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/products
 * Products with filters, sort, and cursor pagination.
 */
router.get('/:slug/products', storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }, { sellerId: slug }], isActive: true },
      select: { id: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const limit = Math.min(parseInt(String(req.query.limit ?? '24'), 10), 48);
    const cursor = req.query.cursor as string | undefined;
    const categoryId = (req.query.category ?? req.query.categoryId) as string | undefined;
    const searchQuery = String(req.query.search ?? req.query.q ?? '').trim();
    const minPrice = req.query.minPrice ? parseFloat(String(req.query.minPrice)) : undefined;
    const maxPrice = req.query.maxPrice ? parseFloat(String(req.query.maxPrice)) : undefined;
    const minRating = req.query.minRating ? parseFloat(String(req.query.minRating)) : undefined;
    const hasDiscount = req.query.hasDiscount === 'true';
    const inStock = req.query.inStock === 'true';
    const sort = (req.query.sort as string) ?? 'recommended';

    const where: any = {
      storeId: store.id,
      isActive: true,
      ...(categoryId && { categoryId }),
      ...(searchQuery
        ? {
            OR: [
              { nameAr: { contains: searchQuery, mode: 'insensitive' } },
              { nameEn: { contains: searchQuery, mode: 'insensitive' } },
              { descriptionAr: { contains: searchQuery, mode: 'insensitive' } },
              { descriptionEn: { contains: searchQuery, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(minPrice !== undefined || maxPrice !== undefined
        ? { price: { ...(minPrice !== undefined && { gte: minPrice }), ...(maxPrice !== undefined && { lte: maxPrice }) } }
        : {}),
      ...(minRating !== undefined && { rating: { gte: minRating } }),
      ...(hasDiscount && { discountPrice: { not: null } }),
      ...(inStock && { stock: { gt: 0 } }),
    };

    const orderBy: any = (() => {
      switch (sort) {
        case 'popular':        return [{ rating: 'desc' }];
        case 'newest':         return { createdAt: 'desc' };
        case 'bestSelling':    return [{ rating: 'desc' }];
        case 'highestRated':   return { rating: 'desc' };
        case 'priceLow':       return { price: 'asc' };
        case 'priceHigh':      return { price: 'desc' };
        case 'largestDiscount':return { discountPrice: 'asc' };
        default:               return [{ rating: 'desc' }, { createdAt: 'desc' }];
      }
    })();

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        include: {
          images: { where: { isPrimary: true }, take: 1 },
          category: { select: { id: true, nameAr: true, nameEn: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    const hasNext = products.length > limit;
    const items = hasNext ? products.slice(0, limit) : products;

    ResponseUtil.success(res, {
      items,
      nextCursor: hasNext ? items[items.length - 1].id : null,
      hasMore: hasNext,
      total,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/categories
 * Categories of this store's products with product counts.
 */
router.get('/:slug/categories', storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }, { sellerId: slug }], isActive: true },
      select: { id: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const categories = await prisma.category.findMany({
      where: { products: { some: { storeId: store.id, isActive: true, isSuspended: false } } },
      include: {
        _count: { select: { products: { where: { storeId: store.id, isActive: true, isSuspended: false } } } },
      },
      orderBy: { sortOrder: 'asc' },
    });

    const mapped = categories.map(c => ({
      id: c.id,
      name: c.nameAr || c.nameEn,
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      slug: c.slug,
      icon: c.icon,
      image: c.image,
      parentId: c.parentId,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      productCount: (c as any)._count?.products ?? 0,
    }));

    ResponseUtil.success(res, mapped);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/vouchers
 * Active vouchers for this store.
 */
router.get('/:slug/vouchers', optionalAuth, storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }], isActive: true },
      select: { id: true, sellerId: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const customerId = (req as any).user?.userId;
    const vouchers = await VoucherService.getStoreVouchers(store.sellerId, customerId);

    ResponseUtil.success(res, vouchers);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/flash-sales
 * Active flash sale items for this store.
 */
router.get('/:slug/flash-sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }], isActive: true },
      select: { id: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const items = await prisma.flashSaleItem.findMany({
      where: {
        product: { storeId: store.id },
        campaign: {
          status: 'ACTIVE',
          startAt: { lte: new Date() },
          endAt: { gt: new Date() },
        },
        remainingStock: { gt: 0 },
      },
      include: {
        product: { include: { images: { where: { isPrimary: true }, take: 1 } } },
        campaign: { select: { id: true, name: true, endAt: true, startAt: true } },
      },
      orderBy: { campaign: { endAt: 'asc' } },
      take: 20,
    });

    ResponseUtil.success(res, items);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/reviews
 * Paginated reviews + rating breakdown for this store.
 */
router.get('/:slug/reviews', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 30);
    const skip = (page - 1) * limit;
    const ratingFilter = req.query.rating ? parseInt(String(req.query.rating), 10) : undefined;

    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }], isActive: true },
      select: { id: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const reviewWhere: any = {
      product: { storeId: store.id },
      status: 'PUBLISHED',
      deletedAt: null,
      ...(ratingFilter ? { rating: ratingFilter } : {}),
    };

    const [reviews, total, ratingBreakdown] = await Promise.all([
      prisma.productReview.findMany({
        where: reviewWhere,
        include: {
          user: { select: { firstName: true, lastName: true, avatar: true } },
          product: { select: { id: true, nameAr: true, nameEn: true } },
          media: { select: { url: true }, take: 5 },
          sellerResponse: { select: { body: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.productReview.count({ where: reviewWhere }),
      prisma.productReview.groupBy({
        by: ['rating'],
        where: { product: { storeId: store.id }, status: 'PUBLISHED', deletedAt: null },
        _count: { id: true },
      }),
    ]);

    const ratingMap: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratingBreakdown) {
      ratingMap[r.rating] = (r._count as { id?: number })?.id ?? 0;
    }

    ResponseUtil.success(res, {
      reviews,
      ratingBreakdown: ratingMap,
      total,
      page,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/stores/:slug/search
 * In-store product search.
 */
router.get('/:slug/search', storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const query = String(req.query.q ?? '').trim();

    if (!query) return ResponseUtil.success(res, { items: [], total: 0, query: '' });

    const store = await prisma.store.findFirst({
      where: { OR: [{ id: slug }, { slug }, { sellerId: slug }], isActive: true },
      select: { id: true },
    });
    if (!store) throw new AppError('Store not found', 404);

    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 48);

    const searchFilter = {
      storeId: store.id,
      isActive: true,
      OR: [
        { nameAr: { contains: query, mode: 'insensitive' as const } },
        { nameEn: { contains: query, mode: 'insensitive' as const } },
        { descriptionAr: { contains: query, mode: 'insensitive' as const } },
        { descriptionEn: { contains: query, mode: 'insensitive' as const } },
      ],
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where: searchFilter,
        include: {
          images: { where: { isPrimary: true }, take: 1 },
          category: { select: { id: true, nameAr: true, nameEn: true } },
        },
        orderBy: { rating: 'desc' },
        take: limit,
      }),
      prisma.product.count({
        where: searchFilter,
      }),
    ]);

    ResponseUtil.success(res, { items, total, query });
  } catch (error) {
    next(error);
  }
});

// ── Original /:id route (must come AFTER specific sub-routes) ─────────────────

// GET /api/v1/stores/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const store = await prisma.store.findFirst({
      where: { OR: [{ id }, { slug: id }] },
      include: {
        seller: { select: { status: true, businessType: true } },
        products: {
          where: { isActive: true },
          include: { images: { where: { isPrimary: true } } },
          take: 24,
        },
        enhancement: true,
        _count: { select: { products: { where: { isActive: true } } } },
      },
    });

    if (!store) throw new AppError('Store not found', 404);
    ResponseUtil.success(res, store);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/stores/:id/availability
router.patch('/:id/availability', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const {
      isOpen, openingTime, closingTime,
      acceptsExpress, acceptsScheduled, busyMode, closedReason,
    } = req.body;

    const store = await prisma.store.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!store) throw new AppError('Store not found', 404);

    const updateData: any = {};
    if (isOpen !== undefined)          updateData.isOpen = Boolean(isOpen);
    if (openingTime !== undefined)     updateData.openingTime = openingTime;
    if (closingTime !== undefined)     updateData.closingTime = closingTime;
    if (acceptsExpress !== undefined)  updateData.acceptsExpress = Boolean(acceptsExpress);
    if (acceptsScheduled !== undefined)updateData.acceptsScheduled = Boolean(acceptsScheduled);
    if (busyMode !== undefined)        updateData.busyMode = Boolean(busyMode);
    if (closedReason !== undefined)    updateData.closedReason = closedReason;

    const updated = await prisma.store.update({ where: { id: store.id }, data: updateData });

    // Invalidate storefront cache
    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, updated, 'تم تحديث حالة وساعات عمل المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const storeRoutes = router;
