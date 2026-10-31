import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { ResponseUtil } from '../../utils/response.util';
import { formatProductForClient, formatProductsForClient } from '../../utils/product-formatter.util';
import { storageService } from '../../services/storage/storage.service';
import { deliveryServiceabilityService } from '../../services/delivery/delivery-serviceability.service';
import { RemoteConfigService } from '../remote-config/remote-config.service';

const router = Router();
const HOME_CACHE_KEY = 'cache:home:feed';
const HOME_CACHE_TTL_SECONDS = 60;

export async function invalidateHomeFeedCache(): Promise<void> {
  try {
    await redis.del(HOME_CACHE_KEY);
  } catch (_) {}
}

// GET /api/v1/home — Combined payload for the customer home screen
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isCityDiscoveryActive = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: (req as any).user?.userId,
    });
    const destination = isCityDiscoveryActive ? await deliveryServiceabilityService.resolveCustomerDestination(req) : null;
    const activeCacheKey = (isCityDiscoveryActive && destination)
      ? `${HOME_CACHE_KEY}:${destination.canonicalCityId || destination.cityId}`
      : `${HOME_CACHE_KEY}:default`;

    const bypassCache = req.query.nocache === 'true';
    if (!bypassCache) {
      const cached = await redis.getJson<any>(activeCacheKey);
      if (cached) {
        return ResponseUtil.success(res, cached);
      }
    }

    let storeFilter: any = {};
    if (isCityDiscoveryActive && destination) {
      if (!destination.isSupported) {
        storeFilter = { id: '__none__' };
      } else {
        const serviceableIds = await deliveryServiceabilityService.getServiceableStoreIds(destination);
        storeFilter = { id: { in: Array.from(serviceableIds) } };
      }
    }

    const [banners, categories, flashSales, rawFeaturedProducts, rawBestSellers, featuredStores, promotions] =
      await Promise.all([
        prisma.banner.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          take: 5,
        }),
        prisma.category.findMany({
          where: { parentId: null, isActive: true },
          orderBy: { sortOrder: 'asc' },
          take: 10,
        }),
        prisma.flashSaleCampaign.findMany({
          where: {
            status: 'ACTIVE',
            startAt: { lte: new Date() },
            endAt: { gt: new Date() },
          },
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
          take: 6,
          include: {
            items: {
              where: { status: 'ACTIVE' },
              take: 12,
              include: {
                product: {
                  include: {
                    images: { orderBy: { sortOrder: 'asc' } },
                    store: { select: { id: true, name: true, logo: true, slug: true } },
                    inventory: { select: { quantity: true } },
                  },
                },
                variant: true,
              },
            },
          },
        }),
        prisma.product.findMany({
          where: { isActive: true, ...(storeFilter.id ? { storeId: storeFilter.id } : {}) },
          orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
          take: 16,
          include: {
            store: { select: { id: true, name: true, slug: true, logo: true, isVerified: true } },
            images: { orderBy: { sortOrder: 'asc' } },
            inventory: { select: { quantity: true } },
          },
        }),
        prisma.product.findMany({
          where: { isActive: true, ...(storeFilter.id ? { storeId: storeFilter.id } : {}) },
          orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
          take: 12,
          include: {
            store: { select: { id: true, name: true, slug: true, logo: true, isVerified: true } },
            images: { orderBy: { sortOrder: 'asc' } },
            inventory: { select: { quantity: true } },
          },
        }),
        prisma.store.findMany({
          where: { isActive: true, ...(storeFilter.id ? storeFilter : {}) },
          orderBy: { rating: 'desc' },
          take: 6,
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            cover: true,
            rating: true,
            isVerified: true,
            _count: { select: { products: { where: { isActive: true } } } },
          },
        }),
        prisma.promotion.findMany({
          where: { isActive: true, endDate: { gt: new Date() } },
          take: 4,
        }),
      ]);

    const formattedFlashSales = flashSales.map((campaign) => {
      const mappedProducts = campaign.items
        .filter((item) => item.product != null)
        .map((item) => {
          const p = item.product;
          const finalPrice =
            item.flashSalePrice && item.flashSalePrice > 0
              ? item.flashSalePrice
              : item.originalPrice ?? p.price;

          const baseFormatted = formatProductForClient(p);

          return {
            ...baseFormatted,
            price: item.originalPrice ?? p.price,
            flashSalePrice: finalPrice,
            compareAtPrice: item.originalPrice ?? p.price,
            isFlashSale: true,
            allocatedStock: item.allocatedStock,
            soldStock: item.soldStock,
            remainingStock: item.remainingStock,
            perCustomerLimit: item.perCustomerLimit,
          };
        });

      return {
        ...campaign,
        startsAt: campaign.startAt,
        endsAt: campaign.endAt,
        items: campaign.items,
        products: mappedProducts,
      };
    });

    const featuredProducts = formatProductsForClient(rawFeaturedProducts);
    const bestSellers = formatProductsForClient(rawBestSellers);

    const normalizedBanners = banners.map((b) => ({
      ...b,
      imageUrl: storageService.normalizeUrl(b.imageUrl),
    }));

    const normalizedStores = featuredStores.map((s) => ({
      ...s,
      logo: s.logo ? storageService.normalizeUrl(s.logo) : null,
      cover: s.cover ? storageService.normalizeUrl(s.cover) : null,
    }));

    const payload = {
      banners: normalizedBanners,
      categories,
      flashSales: formattedFlashSales,
      featuredProducts,
      bestSellers,
      featuredStores: normalizedStores,
      promotions,
    };

    // Cache the assembled payload asynchronously
    redis.setJson(HOME_CACHE_KEY, payload, HOME_CACHE_TTL_SECONDS).catch(() => {});

    ResponseUtil.success(res, payload);
  } catch (error) {
    next(error);
  }
});

export const homeRoutes = router;
