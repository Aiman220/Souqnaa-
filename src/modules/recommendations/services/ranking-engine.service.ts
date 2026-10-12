import { prisma } from '../../../database/prisma';
import { CandidateProduct, ScoredCandidate, RecommendationContext, RecommendationExplanation } from '../types/recommendation.types';
import { recommendationConfigManager } from '../config/recommendation.config';
import { featureStoreService } from './feature-store.service';

export class RecommendationRankerV2 {
  /**
   * Stage 2: Multi-Signal Ranking with Min-Max Score Normalization
   */
  async rankCandidates(candidates: CandidateProduct[], context: RecommendationContext): Promise<ScoredCandidate[]> {
    if (!candidates || candidates.length === 0) return [];

    const productIds = Array.from(new Set(candidates.map((c) => c.productId)));

    // Fetch full product models along with features, stores, categories
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
      },
      include: {
        store: true,
        category: true,
        brand: true,
        images: true,
        inventory: true,
        ratingSummary: true,
        productFeature: true,
      },
    });

    const productMap = new Map<string, any>();
    products.forEach((p) => productMap.set(p.id, p));

    // Retrieve user recommendation profile
    const profile = await featureStoreService.buildUserProfile(context.userId, context.sessionId);
    let userFavCategories: Array<{ categoryId: string; score: number }> = [];
    let userFavSellers: Array<{ sellerId: string; score: number }> = [];
    let recentProductIds: string[] = [];

    if (profile) {
      try {
        if (profile.favoriteCategories) userFavCategories = JSON.parse(profile.favoriteCategories);
        if (profile.favoriteSellers) userFavSellers = JSON.parse(profile.favoriteSellers);
        if (profile.recentProductIds) recentProductIds = JSON.parse(profile.recentProductIds);
      } catch (_) {}
    }

    const config = recommendationConfigManager.getConfig();
    const weights = config.rankingWeights;

    // Group candidate sources per product
    const productSourcesMap = new Map<string, { sources: Set<string>; maxRawScore: number }>();
    for (const c of candidates) {
      if (!productSourcesMap.has(c.productId)) {
        productSourcesMap.set(c.productId, { sources: new Set(), maxRawScore: 0 });
      }
      const item = productSourcesMap.get(c.productId)!;
      item.sources.add(c.source);
      if (c.rawScore > item.maxRawScore) item.maxRawScore = c.rawScore;
    }

    const scoredList: ScoredCandidate[] = [];

    for (const product of products) {
      const sourceInfo = productSourcesMap.get(product.id) || { sources: new Set(['POPULAR']), maxRawScore: 0.5 };
      const sources = Array.from(sourceInfo.sources);

      // 1. Personalization Score [0, 1]
      let personalizationScore = 0;
      const catMatch = userFavCategories.find((c) => c.categoryId === product.categoryId);
      if (catMatch) {
        personalizationScore += 0.5 * Math.min(1.0, catMatch.score / 10);
      }
      const sellerMatch = userFavSellers.find((s) => s.sellerId === product.store?.sellerId);
      if (sellerMatch) {
        personalizationScore += 0.3 * Math.min(1.0, sellerMatch.score / 10);
      }
      if (recentProductIds.includes(product.id)) {
        personalizationScore += 0.2;
      }
      personalizationScore = Math.min(1.0, personalizationScore);

      // 2. Behavior Similarity Score [0, 1]
      const behaviorSimilarityScore = sourceInfo.maxRawScore;

      // 3. Popularity Score [0, 1]
      const feature = product.productFeature;
      const soldCount = product.soldCount || 0;
      const reviewCount = product.reviewCount || 0;
      const rawPop = feature?.popularityScore || (soldCount * 2 + reviewCount);
      const popularityScore = Math.min(1.0, Math.log10(rawPop + 1) / 4); // Log scaling

      // 4. Trending Score [0, 1]
      const trendingScore = Math.min(1.0, (feature?.trendingScore || 1.0) / 5.0);

      // 5. Purchase Association (FBT) Score [0, 1]
      const purchaseAssociationScore = sources.includes('FBT') ? 0.9 : 0.0;

      // 6. Freshness Score [0, 1]
      const freshnessScore = feature?.freshnessScore ?? featureStoreService.calculateFreshnessScore(product.createdAt);

      // 7. Product Quality Score (Bayesian rating + review weight) [0, 1]
      const bayesianRating = featureStoreService.calculateBayesianRating(product.rating || 0, product.reviewCount || 0);
      const productQualityScore = bayesianRating / 5.0;

      // 8. Seller Quality Score [0, 1]
      const storeRating = product.store?.rating ?? 4.0;
      const sellerQualityScore = Math.min(1.0, storeRating / 5.0);

      // 9. Campaign Relevance Score [0, 1]
      const campaignRelevanceScore = sources.includes('CAMPAIGN') || product.isFeatured ? 0.95 : 0.0;

      // 10. Price Relevance Score [0, 1]
      let priceRelevanceScore = 0.5;
      if (profile?.preferredPriceMin !== undefined && profile?.preferredPriceMax !== undefined) {
        if (product.price >= profile.preferredPriceMin && product.price <= profile.preferredPriceMax) {
          priceRelevanceScore = 1.0;
        } else {
          const dist = Math.min(
            Math.abs(product.price - profile.preferredPriceMin),
            Math.abs(product.price - profile.preferredPriceMax)
          );
          priceRelevanceScore = Math.max(0.1, 1.0 - dist / 5000);
        }
      }

      // Final Score Calculation with configured weights
      const finalScore =
        personalizationScore * weights.personalization +
        behaviorSimilarityScore * weights.behaviorSimilarity +
        popularityScore * weights.popularity +
        trendingScore * weights.trending +
        purchaseAssociationScore * weights.purchaseAssociation +
        freshnessScore * weights.freshness +
        productQualityScore * weights.productQuality +
        sellerQualityScore * weights.sellerQuality +
        campaignRelevanceScore * weights.campaignRelevance +
        priceRelevanceScore * weights.priceRelevance;

      // Recommendation Explanation
      const explanation = this.generateExplanation(sources, product, catMatch);

      scoredList.push({
        productId: product.id,
        product,
        candidateSources: sources,
        personalizationScore,
        behaviorSimilarityScore,
        popularityScore,
        trendingScore,
        purchaseAssociationScore,
        freshnessScore,
        productQualityScore,
        sellerQualityScore,
        campaignRelevanceScore,
        priceRelevanceScore,
        finalScore,
        isExploration: false,
        explanation,
      });
    }

    // Sort descending by finalScore
    scoredList.sort((a, b) => b.finalScore - a.finalScore);
    return scoredList;
  }

  /**
   * Deterministic human-readable explanation builder with bilingual support.
   */
  private generateExplanation(sources: string[], product: any, categoryMatch?: any): RecommendationExplanation {
    if (sources.includes('FBT')) {
      return {
        reason: 'Frequently bought together',
        reasonAr: 'غالباً ما يُشترى معاً',
        sourceType: 'FREQUENTLY_BOUGHT_TOGETHER',
      };
    }
    if (sources.includes('SIMILAR')) {
      return {
        reason: 'Because you viewed similar items',
        reasonAr: 'لأنك شاهدت منتجات مشابهة',
        sourceType: 'BECAUSE_YOU_VIEWED',
      };
    }
    if (sources.includes('TRENDING')) {
      return {
        reason: 'Trending now in marketplace',
        reasonAr: 'رائج الآن في سوقناا',
        sourceType: 'TRENDING',
      };
    }
    if (sources.includes('CAMPAIGN')) {
      return {
        reason: 'Special promotional campaign pick',
        reasonAr: 'عرض مميز وحصري',
        sourceType: 'CAMPAIGN',
      };
    }
    if (categoryMatch) {
      const catName = product.category?.nameEn || 'your favorites';
      const catNameAr = product.category?.nameAr || 'المفضلة لديك';
      return {
        reason: `Popular in ${catName}`,
        reasonAr: `الأكثر طلباً في ${catNameAr}`,
        sourceType: 'CATEGORY_POPULAR',
        sourceName: catName,
        sourceNameAr: catNameAr,
      };
    }
    return {
      reason: 'Recommended for you',
      reasonAr: 'موصى به لك',
      sourceType: 'RECOMMENDED',
    };
  }
}

export const recommendationRankerV2 = new RecommendationRankerV2();
