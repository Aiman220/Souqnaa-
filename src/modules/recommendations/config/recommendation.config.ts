import { RecommendationEventType } from '../types/recommendation.types';

export interface RecommendationConfig {
  eventWeights: Record<RecommendationEventType, number>;
  halfLifeDays: {
    views: number;
    clicks: number;
    cart: number;
    wishlist: number;
    purchases: number;
    defaultDays: number;
  };
  rankingWeights: {
    personalization: number;
    behaviorSimilarity: number;
    popularity: number;
    trending: number;
    purchaseAssociation: number;
    freshness: number;
    productQuality: number;
    sellerQuality: number;
    campaignRelevance: number;
    priceRelevance: number;
  };
  explorationRatio: number;
  diversity: {
    maxConsecutiveSameSeller: number;
    maxPerSellerTotal: number;
    maxConsecutiveSameCategory: number;
  };
  cacheTtl: {
    trendingSeconds: number;
    popularSeconds: number;
    userSeconds: number;
    productSimilaritySeconds: number;
    associationsSeconds: number;
    homeSectionsSeconds: number;
  };
  bayesianPrior: {
    averageRating: number;
    confidenceReviews: number;
  };
  featureFlags: {
    'recommendations.enabled': boolean;
    'mlRecommendations.enabled': boolean;
    'lightfm.enabled': boolean;
    'collaborativeFiltering.enabled': boolean;
    'similarProducts.enabled': boolean;
    'frequentlyBought.enabled': boolean;
    'trending.enabled': boolean;
    'personalization.enabled': boolean;
    'exploration.enabled': boolean;
  };
}

export const defaultRecommendationConfig: RecommendationConfig = {
  eventWeights: {
    [RecommendationEventType.PURCHASE]: 10,
    [RecommendationEventType.ORDER_COMPLETED]: 10,
    [RecommendationEventType.ADD_TO_CART]: 7,
    [RecommendationEventType.REMOVE_FROM_CART]: -2,
    [RecommendationEventType.ADD_TO_WISHLIST]: 6,
    [RecommendationEventType.REMOVE_FROM_WISHLIST]: -1,
    [RecommendationEventType.PRODUCT_CLICK]: 3,
    [RecommendationEventType.PRODUCT_VIEW]: 2,
    [RecommendationEventType.SEARCH]: 1,
    [RecommendationEventType.SEARCH_RESULT_CLICK]: 2,
    [RecommendationEventType.PRODUCT_SHARE]: 2,
    [RecommendationEventType.PRODUCT_IMAGE_VIEW]: 1,
    [RecommendationEventType.PRODUCT_REVIEW]: 2,
    [RecommendationEventType.PRODUCT_RATING]: 2,
    [RecommendationEventType.CATEGORY_VIEW]: 1,
    [RecommendationEventType.SELLER_VIEW]: 1,
    [RecommendationEventType.FOLLOW_SELLER]: 3,
    [RecommendationEventType.UNFOLLOW_SELLER]: -1,
    [RecommendationEventType.COUPON_USED]: 4,
    [RecommendationEventType.FLASH_SALE_CLICK]: 3,
    [RecommendationEventType.CAMPAIGN_CLICK]: 3,
  },
  halfLifeDays: {
    views: 7,
    clicks: 7,
    cart: 14,
    wishlist: 14,
    purchases: 30,
    defaultDays: 14,
  },
  rankingWeights: {
    personalization: 0.30,
    behaviorSimilarity: 0.15,
    popularity: 0.10,
    trending: 0.10,
    purchaseAssociation: 0.10,
    freshness: 0.05,
    productQuality: 0.05,
    sellerQuality: 0.05,
    campaignRelevance: 0.05,
    priceRelevance: 0.05,
  },
  explorationRatio: 0.20,
  diversity: {
    maxConsecutiveSameSeller: 3,
    maxPerSellerTotal: 5,
    maxConsecutiveSameCategory: 4,
  },
  cacheTtl: {
    trendingSeconds: 1800,
    popularSeconds: 7200,
    userSeconds: 3600,
    productSimilaritySeconds: 86400,
    associationsSeconds: 86400,
    homeSectionsSeconds: 900,
  },
  bayesianPrior: {
    averageRating: 4.2,
    confidenceReviews: 5,
  },
  featureFlags: {
    'recommendations.enabled': true,
    'mlRecommendations.enabled': true,
    'lightfm.enabled': true,
    'collaborativeFiltering.enabled': true,
    'similarProducts.enabled': true,
    'frequentlyBought.enabled': true,
    'trending.enabled': true,
    'personalization.enabled': true,
    'exploration.enabled': true,
  },
};

class RecommendationConfigManager {
  private config: RecommendationConfig = { ...defaultRecommendationConfig };

  getConfig(): RecommendationConfig {
    return this.config;
  }

  updateConfig(partial: Partial<RecommendationConfig>): RecommendationConfig {
    this.config = {
      ...this.config,
      ...partial,
      eventWeights: { ...this.config.eventWeights, ...(partial.eventWeights || {}) },
      halfLifeDays: { ...this.config.halfLifeDays, ...(partial.halfLifeDays || {}) },
      rankingWeights: { ...this.config.rankingWeights, ...(partial.rankingWeights || {}) },
      diversity: { ...this.config.diversity, ...(partial.diversity || {}) },
      cacheTtl: { ...this.config.cacheTtl, ...(partial.cacheTtl || {}) },
      bayesianPrior: { ...this.config.bayesianPrior, ...(partial.bayesianPrior || {}) },
      featureFlags: { ...this.config.featureFlags, ...(partial.featureFlags || {}) },
    };
    return this.config;
  }

  getFlag(flagName: keyof RecommendationConfig['featureFlags']): boolean {
    return this.config.featureFlags[flagName] ?? true;
  }

  setFlag(flagName: keyof RecommendationConfig['featureFlags'], value: boolean): void {
    this.config.featureFlags[flagName] = value;
  }
}

export const recommendationConfigManager = new RecommendationConfigManager();
