import { redis } from '../../database/redis';

export class MembershipCacheService {
  private static readonly TIERS_KEY = 'membership:tiers:all';
  private static readonly CUSTOMER_PREFIX = 'membership:customer:';
  private static readonly DEFAULT_TTL_SECONDS = 300; // 5 minutes
  private static readonly TIERS_TTL_SECONDS = 3600; // 1 hour

  /**
   * Get cached active tiers list.
   */
  public static async getActiveTiers(): Promise<any[] | null> {
    try {
      const data = await redis.get(this.TIERS_KEY);
      if (!data) return null;
      return JSON.parse(data);
    } catch (_) {
      return null;
    }
  }

  /**
   * Set cached active tiers list.
   */
  public static async setActiveTiers(tiers: any[]): Promise<void> {
    try {
      await redis.set(this.TIERS_KEY, JSON.stringify(tiers), this.TIERS_TTL_SECONDS);
    } catch (_) {}
  }

  /**
   * Invalidate cached active tiers list.
   */
  public static async invalidateTiers(): Promise<void> {
    try {
      await redis.del(this.TIERS_KEY);
    } catch (_) {}
  }

  /**
   * Get cached customer membership summary.
   */
  public static async getCustomerSummary(userId: string): Promise<any | null> {
    try {
      const key = `${this.CUSTOMER_PREFIX}${userId}`;
      const data = await redis.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (_) {
      return null;
    }
  }

  /**
   * Set cached customer membership summary.
   */
  public static async setCustomerSummary(userId: string, summary: any): Promise<void> {
    try {
      const key = `${this.CUSTOMER_PREFIX}${userId}`;
      await redis.set(key, JSON.stringify(summary), this.DEFAULT_TTL_SECONDS);
    } catch (_) {}
  }

  /**
   * Invalidate cached customer membership summary.
   */
  public static async invalidateCustomer(userId: string): Promise<void> {
    try {
      const key = `${this.CUSTOMER_PREFIX}${userId}`;
      await redis.del(key);
    } catch (_) {}
  }
}
