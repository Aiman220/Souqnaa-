import { FreshnessType } from '../types/analytics.types';

interface CacheEntry<T> {
  data: T;
  freshness: FreshnessType;
  expiresAt: number;
  cachedAt: number;
}

export class AnalyticsCacheService {
  private static cache = new Map<string, CacheEntry<any>>();

  /**
   * Retrieves an item from memory cache if not expired.
   */
  public static get<T = any>(key: string): { data: T; freshness: FreshnessType } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return {
      data: entry.data,
      freshness: entry.freshness,
    };
  }

  /**
   * Stores an aggregate item in cache with TTL (seconds).
   */
  public static set<T>(
    key: string,
    data: T,
    ttlSeconds: number = 60,
    freshness: FreshnessType = 'NEAR_REAL_TIME'
  ): void {
    this.cache.set(key, {
      data,
      freshness,
      expiresAt: Date.now() + ttlSeconds * 1000,
      cachedAt: Date.now(),
    });
  }

  /**
   * Invalidates cache entries matching a prefix or sellerId.
   */
  public static invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}
