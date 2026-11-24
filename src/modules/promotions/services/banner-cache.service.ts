import { redis } from '../../../database/redis';
import { SocketService } from '../../../services/websocket/socket.service';
import { invalidateHomeFeedCache } from '../../home/home.routes';

const DEFAULT_BANNER_CACHE_TTL = 120; // 2 minutes (rapid refresh with L1/L2 Redis caching)

class BannerCacheService {
  buildKey(placementKey: string, locale = 'ar', platform = 'MOBILE', segment = 'ALL'): string {
    const p = (placementKey || 'default').toUpperCase();
    const l = (locale || 'ar').toLowerCase();
    const pl = (platform || 'mobile').toLowerCase();
    const s = (segment || 'all').toLowerCase();
    return `banners:${p}:${l}:${pl}:${s}`;
  }

  async getCachedBanners<T>(
    placementKey: string,
    locale = 'ar',
    platform = 'MOBILE',
    segment = 'ALL'
  ): Promise<T | null> {
    const key = this.buildKey(placementKey, locale, platform, segment);
    return redis.getJson<T>(key);
  }

  async setCachedBanners<T>(
    placementKey: string,
    locale = 'ar',
    platform = 'MOBILE',
    segment = 'ALL',
    data: T,
    ttlSeconds = DEFAULT_BANNER_CACHE_TTL
  ): Promise<void> {
    const key = this.buildKey(placementKey, locale, platform, segment);
    await redis.setJson(key, data, ttlSeconds);
  }

  /**
   * Invalidate all cached placements matching this placement key
   */
  async invalidatePlacement(placementKey: string): Promise<void> {
    const p = (placementKey || '').toUpperCase();

    // 1. Purge all matching pattern keys from Redis (L1 memory + L2 Redis)
    const tasks: Promise<any>[] = [
      redis.delPattern(`banners:${p}:*`),
      redis.delPattern('banners:HOME_AGGREGATE:*'),
      invalidateHomeFeedCache(),
    ];

    // 2. Explicitly wipe common key combinations directly for instant zero-latency clearing
    const locales = ['ar', 'en'];
    const platforms = ['mobile', 'android', 'ios', 'web', 'desktop', 'tablet'];
    const segments = ['all', 'guest', 'guests', 'registered', 'registered_users', 'new_customers'];

    for (const l of locales) {
      for (const pl of platforms) {
        for (const s of segments) {
          tasks.push(redis.del(`banners:${p}:${l}:${pl}:${s}`));
        }
      }
    }
    // Also clear legacy aggregate keys
    tasks.push(redis.del(`banners:HOME_AGGREGATE:ar`));
    tasks.push(redis.del(`banners:HOME_AGGREGATE:en`));

    await Promise.allSettled(tasks);

    // Notify connected clients immediately via real-time WebSocket
    SocketService.get()?.emitGlobal('promotions:banners_updated', {
      placementKey: p,
      timestamp: Date.now(),
    });
  }

  async invalidateAllBanners(): Promise<void> {
    // 1. Invalidate all banner patterns across Redis
    await Promise.allSettled([
      redis.delPattern('banners:*'),
      invalidateHomeFeedCache(),
    ]);

    const placements = [
      'HOME_HERO',
      'HOME_SECONDARY',
      'HOME_VOUCHER',
      'HOME_FLASH_SALE',
      'CATEGORY_TOP',
      'SEARCH_TOP',
      'STORE_TOP',
      'PRODUCT_TOP',
      'CHECKOUT_PROMOTION',
      'FEATURED_STORES',
    ];
    await Promise.allSettled(placements.map((p) => this.invalidatePlacement(p)));

    // Broadcast global invalidation for both banners and campaigns
    SocketService.get()?.emitGlobal('promotions:banners_updated', {
      placementKey: 'ALL',
      timestamp: Date.now(),
    });
    SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
      action: 'INVALIDATE_ALL',
      timestamp: Date.now(),
    });
  }
}

export const bannerCacheService = new BannerCacheService();
