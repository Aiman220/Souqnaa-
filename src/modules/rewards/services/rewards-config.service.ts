import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { GlobalRewardRules, FeatureFlagsConfig } from '../rewards.types';

export const DEFAULT_FEATURE_FLAGS: FeatureFlagsConfig = {
  'rewards_coins.enabled': true,
  'rewards_coin_redemption.enabled': true,
  'rewards_daily_checkin.enabled': true,
  'rewards_missions.enabled': true,
  'rewards_purchase_rewards.enabled': true,
  'rewards_review_rewards.enabled': true,
  'rewards_photo_review_rewards.enabled': true,
  'rewards_video_review_rewards.enabled': true,
  'rewards_referrals.enabled': true,
  'rewards_campaign_bonus.enabled': true,
  'rewards_seller_rewards.enabled': true,
  'rewards_coin_expiration.enabled': false,
};

export const DEFAULT_REWARD_RULES: GlobalRewardRules = {
  purchaseRewardRate: 0.01, // 1 coin per 100 YER spent
  minPurchaseForReward: 500,
  maxRewardPerOrder: 5000,
  reviewTextReward: 20,
  reviewPhotoReward: 50,
  reviewVideoReward: 100,
  referralReferrerReward: 100,
  referralRefereeReward: 50,
  referralMinOrderAmount: 1000,
  redemptionRatio: 100, // 100 coins = 1 currency unit (YER)
  maxOrderPercentage: 0.20, // max 20% of order payable with coins
  maxCoinsPerOrder: 2000,
  minCoinsRequired: 50,
  minOrderAmount: 200,
  defaultExpirationDays: 0, // No expiration (Shopee-style permanent coins)
  warningDays: 0,
  coinsCoverDelivery: false,
  negativeBalanceAllowed: false,
  version: '1.0.0',
};

export class RewardsConfigService {
  private static rulesCache: GlobalRewardRules | null = null;
  private static flagsCache: FeatureFlagsConfig | null = null;
  private static cacheExpiry = 0;
  private static readonly TTL_MS = 60 * 1000; // 1 minute in-memory cache

  /**
   * Retrieves active global reward rules. Cached with fallback to defaults.
   */
  static async getRules(): Promise<GlobalRewardRules> {
    const now = Date.now();
    if (this.rulesCache && now < this.cacheExpiry) {
      return this.rulesCache;
    }

    try {
      let config = await prisma.rewardRuleConfig.findUnique({
        where: { key: 'global_reward_rules' },
      });

      if (!config) {
        config = await prisma.rewardRuleConfig.create({
          data: {
            key: 'global_reward_rules',
            ...DEFAULT_REWARD_RULES,
          },
        });
      }

      this.rulesCache = {
        purchaseRewardRate: config.purchaseRewardRate,
        minPurchaseForReward: config.minPurchaseForReward,
        maxRewardPerOrder: config.maxRewardPerOrder,
        reviewTextReward: config.reviewTextReward,
        reviewPhotoReward: config.reviewPhotoReward,
        reviewVideoReward: config.reviewVideoReward,
        referralReferrerReward: config.referralReferrerReward,
        referralRefereeReward: config.referralRefereeReward,
        referralMinOrderAmount: config.referralMinOrderAmount,
        redemptionRatio: config.redemptionRatio,
        maxOrderPercentage: config.maxOrderPercentage,
        maxCoinsPerOrder: config.maxCoinsPerOrder,
        minCoinsRequired: config.minCoinsRequired,
        minOrderAmount: config.minOrderAmount,
        defaultExpirationDays: config.defaultExpirationDays,
        warningDays: config.warningDays,
        coinsCoverDelivery: config.coinsCoverDelivery,
        negativeBalanceAllowed: config.negativeBalanceAllowed,
        version: config.version,
      };
      this.cacheExpiry = now + this.TTL_MS;
      return this.rulesCache;
    } catch (e) {
      console.error('[RewardsConfigService] Error loading rules:', e);
      return DEFAULT_REWARD_RULES;
    }
  }

  /**
   * Retrieves active feature flags with dependency enforcement (§106, §107, §108, §109).
   */
  static async getFeatureFlags(): Promise<FeatureFlagsConfig> {
    const now = Date.now();
    if (this.flagsCache && now < this.cacheExpiry) {
      return this.flagsCache;
    }

    try {
      const settings = await prisma.systemSetting.findMany({
        where: { group: 'rewards_flags' },
      });

      const flags: FeatureFlagsConfig = { ...DEFAULT_FEATURE_FLAGS };
      for (const s of settings) {
        if (s.key in flags) {
          (flags as any)[s.key] = s.value === 'true';
        }
      }

      // Feature Flag Dependency Rules (§107, §109 Emergency Kill Switch):
      // If master kill switch 'rewards_coins.enabled' is FALSE, all dependent features are forced FALSE.
      if (!flags['rewards_coins.enabled']) {
        flags['rewards_coin_redemption.enabled'] = false;
        flags['rewards_daily_checkin.enabled'] = false;
        flags['rewards_missions.enabled'] = false;
        flags['rewards_purchase_rewards.enabled'] = false;
        flags['rewards_review_rewards.enabled'] = false;
        flags['rewards_photo_review_rewards.enabled'] = false;
        flags['rewards_video_review_rewards.enabled'] = false;
        flags['rewards_referrals.enabled'] = false;
        flags['rewards_campaign_bonus.enabled'] = false;
        flags['rewards_seller_rewards.enabled'] = false;
        flags['rewards_coin_expiration.enabled'] = false;
      }

      this.flagsCache = flags;
      this.cacheExpiry = now + this.TTL_MS;
      return flags;
    } catch (e) {
      console.error('[RewardsConfigService] Error loading feature flags:', e);
      return DEFAULT_FEATURE_FLAGS;
    }
  }

  /**
   * Checks a specific feature flag.
   */
  static async isEnabled(flagName: keyof FeatureFlagsConfig): Promise<boolean> {
    const flags = await this.getFeatureFlags();
    return !!flags[flagName];
  }

  /**
   * Updates global rules (Admin operation).
   */
  static async updateRules(
    updates: Partial<GlobalRewardRules>,
    adminId: string
  ): Promise<GlobalRewardRules> {
    const current = await this.getRules();
    const updated = await prisma.rewardRuleConfig.upsert({
      where: { key: 'global_reward_rules' },
      update: {
        ...updates,
        version: `${parseInt(current.version.split('.')[0] || '1', 10) + 1}.0.0`,
      },
      create: {
        key: 'global_reward_rules',
        ...DEFAULT_REWARD_RULES,
        ...updates,
      },
    });

    // Record audit log
    await prisma.rewardAuditLog.create({
      data: {
        adminId,
        action: 'RULE_UPDATE',
        resource: 'rewards_config',
        details: JSON.stringify({ before: current, after: updates }),
      },
    });

    this.rulesCache = null;
    this.cacheExpiry = 0;
    try {
      await redis.del('rewards:rules');
    } catch (_) {}

    return this.getRules();
  }

  /**
   * Updates feature flags (Admin operation).
   */
  static async updateFeatureFlags(
    updates: Partial<FeatureFlagsConfig>,
    adminId: string
  ): Promise<FeatureFlagsConfig> {
    for (const [key, value] of Object.entries(updates)) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: String(value), group: 'rewards_flags' },
        create: {
          key,
          value: String(value),
          type: 'boolean',
          group: 'rewards_flags',
        },
      });
    }

    await prisma.rewardAuditLog.create({
      data: {
        adminId,
        action: 'FEATURE_FLAGS_UPDATE',
        resource: 'rewards_flags',
        details: JSON.stringify(updates),
      },
    });

    this.flagsCache = null;
    this.cacheExpiry = 0;
    try {
      await redis.del('rewards:flags');
    } catch (_) {}

    return this.getFeatureFlags();
  }

  /**
   * Clears in-memory and Redis caches.
   */
  static invalidateCache(): void {
    this.rulesCache = null;
    this.flagsCache = null;
    this.cacheExpiry = 0;
  }
}
