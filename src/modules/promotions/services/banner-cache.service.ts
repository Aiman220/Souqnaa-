import { redis } from '../../../database/redis';
import { SocketService } from '../../../services/websocket/socket.service';

const DEFAULT_BANNER_CACHE_TTL = 300; // 5 minutes

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
    // Common combinations to clear immediately
    const locales = ['ar', 'en'];
    const platforms = ['mobile', 'android', 'ios', 'web', 'desktop', 'tablet'];
    const segments = ['all', 'guests', 'registered_users', 'new_customers'];

    const tasks: Promise<any>[] = [];
    for (const l of locales) {
      for (const pl of platforms) {
        for (const s of segments) {
          tasks.push(redis.del(`banners:${p}:${l}:${pl}:${s}`));
        }
      }
    }
    // Also clear home aggregate cache
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
    ];
    await Promise.allSettled(placements.map((p) => this.invalidatePlacement(p)));

    // Broadcast global invalidation
    SocketService.get()?.emitGlobal('promotions:banners_updated', {
      placementKey: 'ALL',
      timestamp: Date.now(),
    });
  }
}

export const bannerCacheService = new BannerCacheService();
