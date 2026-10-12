import { prisma } from '../../../database/prisma';
import { RecommendationEventType } from '@prisma/client';
import { recommendationConfigManager } from '../config/recommendation.config';

export class FeatureStoreService {
  /**
   * Calculate time decay multiplier for an event based on its age and type.
   * decay = 0.5 ^ (ageDays / halfLifeDays)
   */
  calculateTimeDecay(eventDate: Date, eventType: RecommendationEventType): number {
    const config = recommendationConfigManager.getConfig();
    const now = new Date();
    const ageMs = Math.max(0, now.getTime() - eventDate.getTime());
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    let halfLifeDays = config.halfLifeDays.defaultDays;
    if (eventType === RecommendationEventType.PRODUCT_VIEW || eventType === RecommendationEventType.PRODUCT_CLICK) {
      halfLifeDays = config.halfLifeDays.views;
    } else if (eventType === RecommendationEventType.ADD_TO_CART || eventType === RecommendationEventType.REMOVE_FROM_CART) {
      halfLifeDays = config.halfLifeDays.cart;
    } else if (eventType === RecommendationEventType.ADD_TO_WISHLIST || eventType === RecommendationEventType.REMOVE_FROM_WISHLIST) {
      halfLifeDays = config.halfLifeDays.wishlist;
    } else if (eventType === RecommendationEventType.PURCHASE || eventType === RecommendationEventType.ORDER_COMPLETED) {
      halfLifeDays = config.halfLifeDays.purchases;
    }

    return Math.pow(0.5, ageDays / halfLifeDays);
  }

  /**
   * Calculate Bayesian adjusted rating to prevent products with few reviews from unfairly dominating.
   * R_bayesian = (v * R + m * C) / (v + m)
   */
  calculateBayesianRating(averageRating: number, reviewCount: number): number {
    const config = recommendationConfigManager.getConfig();
    const C = config.bayesianPrior.averageRating;
    const m = config.bayesianPrior.confidenceReviews;
    const v = reviewCount;
    const R = averageRating;

    return (v * R + m * C) / (v + m);
  }

  /**
   * Calculate freshness score for a product based on creation date.
   * Fresh products created within last 7 days get high score (0.5 - 1.0).
   */
  calculateFreshnessScore(createdAt: Date): number {
    const now = new Date();
    const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    // Half-life of 21 days for newness
    return Math.max(0, Math.min(1, Math.pow(0.5, ageDays / 21)));
  }

  /**
   * Aggregate user events into a UserRecommendationProfile.
   */
  async buildUserProfile(userId?: string, sessionId?: string): Promise<any> {
    if (!userId && !sessionId) return null;

    const whereClause: any = {};
    if (userId) {
      whereClause.userId = userId;
    } else if (sessionId) {
      whereClause.sessionId = sessionId;
    }

    // Retrieve last 100 events for this user/session
    const events = await prisma.recommendationEvent.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    const categoryScores: Record<string, { score: number; count: number }> = {};
    const sellerScores: Record<string, { score: number; count: number }> = {};
    const brandScores: Record<string, number> = {};
    const purchasedCategories: Record<string, number> = {};
    const recentSearches: string[] = [];
    const recentProductIds: string[] = [];
    const seenProductIds = new Set<string>();

    const config = recommendationConfigManager.getConfig();

    for (const evt of events) {
      const baseWeight = config.eventWeights[evt.eventType] || 1;
      const decay = this.calculateTimeDecay(evt.timestamp, evt.eventType);
      const effectiveScore = baseWeight * decay;

      if (evt.categoryId) {
        if (!categoryScores[evt.categoryId]) {
          categoryScores[evt.categoryId] = { score: 0, count: 0 };
        }
        categoryScores[evt.categoryId].score += effectiveScore;
        categoryScores[evt.categoryId].count += 1;
      }

      if (evt.sellerId) {
        if (!sellerScores[evt.sellerId]) {
          sellerScores[evt.sellerId] = { score: 0, count: 0 };
        }
        sellerScores[evt.sellerId].score += effectiveScore;
        sellerScores[evt.sellerId].count += 1;
      }

      if (evt.productId && !seenProductIds.has(evt.productId)) {
        seenProductIds.add(evt.productId);
        recentProductIds.push(evt.productId);
      }

      if (evt.searchQuery && !recentSearches.includes(evt.searchQuery)) {
        recentSearches.push(evt.searchQuery);
      }

      if (evt.eventType === RecommendationEventType.PURCHASE && evt.categoryId) {
        purchasedCategories[evt.categoryId] = (purchasedCategories[evt.categoryId] || 0) + 1;
      }
    }

    // Convert category affinities
    const sortedCategories = Object.entries(categoryScores)
      .map(([categoryId, data]) => ({ categoryId, score: data.score, count: data.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const sortedSellers = Object.entries(sellerScores)
      .map(([sellerId, data]) => ({ sellerId, score: data.score, count: data.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // Save or update profile in DB
    const profileData = {
      favoriteCategories: JSON.stringify(sortedCategories),
      favoriteSellers: JSON.stringify(sortedSellers),
      frequentlyPurchasedCategories: JSON.stringify(purchasedCategories),
      recentSearches: JSON.stringify(recentSearches.slice(0, 10)),
      recentProductIds: JSON.stringify(recentProductIds.slice(0, 20)),
      totalInteractions: events.length,
      lastActiveAt: new Date(),
    };

    if (userId) {
      return await prisma.userRecommendationProfile.upsert({
        where: { userId },
        create: { userId, ...profileData },
        update: profileData,
      });
    } else if (sessionId) {
      return await prisma.userRecommendationProfile.upsert({
        where: { sessionId },
        create: { sessionId, ...profileData },
        update: profileData,
      });
    }

    return null;
  }

  /**
   * Rebuild or update product features table from catalog and event statistics.
   */
  async syncProductFeatures(productId: string): Promise<any> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        store: true,
        category: true,
        brand: true,
        inventory: true,
        attributes: true,
      },
    });

    if (!product) return null;

    const bayesianRating = this.calculateBayesianRating(product.rating, product.reviewCount);
    const freshnessScore = this.calculateFreshnessScore(product.createdAt);

    // Calculate popularity and trending from recommendation events
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [recent7dEvents, recent24hEvents] = await Promise.all([
      prisma.recommendationEvent.findMany({
        where: {
          productId,
          timestamp: { gte: sevenDaysAgo },
        },
      }),
      prisma.recommendationEvent.findMany({
        where: {
          productId,
          timestamp: { gte: oneDayAgo },
        },
      }),
    ]);

    const config = recommendationConfigManager.getConfig();

    let popularityScore = 0;
    for (const evt of recent7dEvents) {
      const w = config.eventWeights[evt.eventType] || 1;
      const decay = this.calculateTimeDecay(evt.timestamp, evt.eventType);
      popularityScore += w * decay;
    }

    let trending24hScore = 0;
    for (const evt of recent24hEvents) {
      const w = config.eventWeights[evt.eventType] || 1;
      trending24hScore += w;
    }

    // Trending compares recent 24h burst to 7d average
    const baselineDaily = popularityScore / 7;
    const trendingScore = baselineDaily > 0 ? (trending24hScore / baselineDaily) : trending24hScore;

    const stock = product.inventory?.quantity ?? 0;
    const qualityScore = (bayesianRating / 5.0) * 0.7 + (Math.min(product.soldCount, 100) / 100) * 0.3;

    return await prisma.productFeature.upsert({
      where: { productId },
      create: {
        productId,
        categoryId: product.categoryId,
        subcategoryId: product.category?.parentId || null,
        sellerId: product.store?.sellerId || '',
        brandId: product.brandId || null,
        price: product.price,
        discount: product.compareAtPrice && product.compareAtPrice > product.price
          ? ((product.compareAtPrice - product.price) / product.compareAtPrice) * 100
          : 0,
        rating: product.rating,
        reviewCount: product.reviewCount,
        soldCount: product.soldCount,
        stock,
        isActive: product.isActive && !product.isSuspended && stock > 0,
        bayesianRating,
        popularityScore,
        trendingScore,
        freshnessScore,
        qualityScore,
        tags: JSON.stringify([]),
        attributes: JSON.stringify(product.attributes || []),
      },
      update: {
        price: product.price,
        rating: product.rating,
        reviewCount: product.reviewCount,
        soldCount: product.soldCount,
        stock,
        isActive: product.isActive && !product.isSuspended && stock > 0,
        bayesianRating,
        popularityScore,
        trendingScore,
        freshnessScore,
        qualityScore,
      },
    });
  }
}

export const featureStoreService = new FeatureStoreService();
