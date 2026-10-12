import { prisma } from '../../../database/prisma';
import { redisService } from '../../../database/redis';
import { CandidateProduct, RecommendationContext } from '../types/recommendation.types';
import { featureStoreService } from './feature-store.service';
import { contentSimilarityService } from './content-similarity.service';
import { associationRulesService } from './association-rules.service';
import { recommendationConfigManager } from '../config/recommendation.config';

export class CandidateGeneratorService {
  /**
   * Stage 1: Multi-Source Candidate Retrieval
   * Gathers up to ~500 candidate products across multiple independent channels.
   */
  async generateCandidates(context: RecommendationContext, targetPoolSize = 500): Promise<CandidateProduct[]> {
    const candidateMap = new Map<string, CandidateProduct>();

    const addCandidate = (cand: CandidateProduct) => {
      const existing = candidateMap.get(cand.productId);
      if (!existing || cand.rawScore > existing.rawScore) {
        candidateMap.set(cand.productId, cand);
      }
    };

    // Parallel fetch from all candidate sources
    const [
      personalCandidates,
      trendingCandidates,
      popularCandidates,
      categoryCandidates,
      sellerCandidates,
      campaignCandidates,
      freshnessCandidates,
      cartFbtCandidates,
    ] = await Promise.all([
      this.getPersonalHistoryCandidates(context),
      this.getTrendingCandidates(60),
      this.getPopularCandidates(80),
      this.getCategoryAffinityCandidates(context, 80),
      this.getSellerAffinityCandidates(context, 50),
      this.getCampaignCandidates(40),
      this.getNewArrivalCandidates(50),
      this.getCartAndWishlistComplementaryCandidates(context, 40),
    ]);

    personalCandidates.forEach(addCandidate);
    trendingCandidates.forEach(addCandidate);
    popularCandidates.forEach(addCandidate);
    categoryCandidates.forEach(addCandidate);
    sellerCandidates.forEach(addCandidate);
    campaignCandidates.forEach(addCandidate);
    freshnessCandidates.forEach(addCandidate);
    cartFbtCandidates.forEach(addCandidate);

    return Array.from(candidateMap.values()).slice(0, targetPoolSize);
  }

  /**
   * Candidate Channel: Personal History (Recently viewed, wishlist, cart)
   */
  private async getPersonalHistoryCandidates(context: RecommendationContext): Promise<CandidateProduct[]> {
    const candidates: CandidateProduct[] = [];
    const { userId, sessionId } = context;

    // Check user profile for recent interactions
    let recentProductIds: string[] = [];
    if (context.recentViewedIds && context.recentViewedIds.length > 0) {
      recentProductIds = context.recentViewedIds;
    } else {
      const profile = await featureStoreService.buildUserProfile(userId, sessionId);
      if (profile && profile.recentProductIds) {
        try {
          recentProductIds = JSON.parse(profile.recentProductIds);
        } catch (_) {}
      }
    }

    // For each recent product, pull similar candidates
    for (const pid of recentProductIds.slice(0, 5)) {
      const similar = await contentSimilarityService.getSimilarProducts(pid, 8);
      similar.forEach((p, idx) => {
        candidates.push({
          productId: p.id,
          source: 'SIMILAR',
          rawScore: 0.9 - idx * 0.05,
          sourceMetadata: { sourceProductId: pid },
        });
      });
    }

    return candidates;
  }

  /**
   * Candidate Channel: Trending Products (Recent acceleration)
   */
  async getTrendingCandidates(limit = 60): Promise<CandidateProduct[]> {
    const cacheKey = `recommendations:trending:candidates:${limit}`;
    const cached = await redisService.getJson<CandidateProduct[]>(cacheKey);
    if (cached) return cached;

    // Fetch from ProductFeature trendingScore
    const features = await prisma.productFeature.findMany({
      where: {
        isActive: true,
        stock: { gt: 0 },
      },
      orderBy: { trendingScore: 'desc' },
      take: limit,
      select: { productId: true, trendingScore: true },
    });

    let candidates: CandidateProduct[] = [];
    if (features.length > 0) {
      candidates = features.map((f, idx) => ({
        productId: f.productId,
        source: 'TRENDING' as const,
        rawScore: Math.max(0.5, 1.0 - idx * 0.01),
      }));
    } else {
      // Fallback to recent products
      const fallback = await prisma.product.findMany({
        where: { isActive: true, isSuspended: false, inventory: { quantity: { gt: 0 } } },
        orderBy: { soldCount: 'desc' },
        take: limit,
        select: { id: true },
      });
      candidates = fallback.map((p, idx) => ({
        productId: p.id,
        source: 'TRENDING' as const,
        rawScore: 0.8 - idx * 0.01,
      }));
    }

    await redisService.setJson(cacheKey, candidates, 1800); // 30 min
    return candidates;
  }

  /**
   * Candidate Channel: Popular Products (Long-term weighted engagement)
   */
  async getPopularCandidates(limit = 80): Promise<CandidateProduct[]> {
    const cacheKey = `recommendations:popular:candidates:${limit}`;
    const cached = await redisService.getJson<CandidateProduct[]>(cacheKey);
    if (cached) return cached;

    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
      },
      orderBy: [
        { soldCount: 'desc' },
        { rating: 'desc' },
        { reviewCount: 'desc' },
      ],
      take: limit,
      select: { id: true, soldCount: true, rating: true },
    });

    const candidates = products.map((p, idx) => ({
      productId: p.id,
      source: 'POPULAR' as const,
      rawScore: Math.max(0.3, 1.0 - idx * 0.01),
    }));

    await redisService.setJson(cacheKey, candidates, 7200); // 2 hours
    return candidates;
  }

  /**
   * Candidate Channel: Category Affinity
   */
  private async getCategoryAffinityCandidates(context: RecommendationContext, limit = 80): Promise<CandidateProduct[]> {
    const { userId, sessionId } = context;
    const profile = await featureStoreService.buildUserProfile(userId, sessionId);
    if (!profile || !profile.favoriteCategories) return [];

    let favoriteCategories: Array<{ categoryId: string; score: number }> = [];
    try {
      favoriteCategories = JSON.parse(profile.favoriteCategories);
    } catch (_) {
      return [];
    }

    if (favoriteCategories.length === 0) return [];

    const topCategoryIds = favoriteCategories.slice(0, 3).map((c) => c.categoryId);

    const products = await prisma.product.findMany({
      where: {
        categoryId: { in: topCategoryIds },
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
      },
      orderBy: { soldCount: 'desc' },
      take: limit,
      select: { id: true, categoryId: true },
    });

    return products.map((p, idx) => ({
      productId: p.id,
      source: 'CATEGORY' as const,
      rawScore: 0.85 - idx * 0.005,
      sourceMetadata: { categoryId: p.categoryId },
    }));
  }

  /**
   * Candidate Channel: Seller Affinity
   */
  private async getSellerAffinityCandidates(context: RecommendationContext, limit = 50): Promise<CandidateProduct[]> {
    const { userId, sessionId } = context;
    const profile = await featureStoreService.buildUserProfile(userId, sessionId);
    if (!profile || !profile.favoriteSellers) return [];

    let favoriteSellers: Array<{ sellerId: string; score: number }> = [];
    try {
      favoriteSellers = JSON.parse(profile.favoriteSellers);
    } catch (_) {
      return [];
    }

    if (favoriteSellers.length === 0) return [];

    const topSellerIds = favoriteSellers.slice(0, 3).map((s) => s.sellerId);

    const products = await prisma.product.findMany({
      where: {
        store: { sellerId: { in: topSellerIds } },
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
      },
      orderBy: { soldCount: 'desc' },
      take: limit,
      select: { id: true, store: { select: { sellerId: true } } },
    });

    return products.map((p, idx) => ({
      productId: p.id,
      source: 'SELLER' as const,
      rawScore: 0.8 - idx * 0.01,
      sourceMetadata: { sellerId: p.store.sellerId },
    }));
  }

  /**
   * Candidate Channel: Active Campaigns & Flash Sales
   */
  private async getCampaignCandidates(limit = 40): Promise<CandidateProduct[]> {
    const now = new Date();
    // Flash sale items active right now
    const flashItems = await prisma.flashSaleItem.findMany({
      where: {
        status: 'ACTIVE',
        campaign: {
          status: 'ACTIVE',
          startAt: { lte: now },
          endAt: { gte: now },
        },
        product: {
          isActive: true,
          isSuspended: false,
        },
      },
      take: limit,
      select: { productId: true, flashSalePrice: true, discountValue: true },
    });

    return flashItems.map((fi, idx) => ({
      productId: fi.productId,
      source: 'CAMPAIGN' as const,
      rawScore: 0.95 - idx * 0.01,
      sourceMetadata: { isFlashSale: true },
    }));
  }

  /**
   * Candidate Channel: New Arrivals
   */
  private async getNewArrivalCandidates(limit = 50): Promise<CandidateProduct[]> {
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true },
    });

    return products.map((p, idx) => ({
      productId: p.id,
      source: 'NEW_ARRIVALS' as const,
      rawScore: 0.75 - idx * 0.01,
    }));
  }

  /**
   * Candidate Channel: Cart and Wishlist Complementary / FBT
   */
  private async getCartAndWishlistComplementaryCandidates(context: RecommendationContext, limit = 40): Promise<CandidateProduct[]> {
    const candidates: CandidateProduct[] = [];
    const sourceIds: string[] = [];

    if (context.cartProductIds && context.cartProductIds.length > 0) {
      sourceIds.push(...context.cartProductIds);
    }
    if (context.wishlistProductIds && context.wishlistProductIds.length > 0) {
      sourceIds.push(...context.wishlistProductIds.slice(0, 3));
    }

    for (const pid of sourceIds.slice(0, 4)) {
      const fbt = await associationRulesService.getFrequentlyBoughtTogether(pid, 5);
      fbt.forEach((p, idx) => {
        candidates.push({
          productId: p.id,
          source: 'FBT' as const,
          rawScore: 0.85 - idx * 0.05,
          sourceMetadata: { sourceProductId: pid },
        });
      });
    }

    return candidates;
  }
}

export const candidateGeneratorService = new CandidateGeneratorService();
