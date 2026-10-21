import { prisma } from '../../../database/prisma';
import { redisService } from '../../../database/redis';
import {
  RecommendationType,
  RecommendationSectionDto,
  RecommendationContext,
  ScoredCandidate,
} from '../types/recommendation.types';
import { candidateGeneratorService } from './candidate-generator.service';
import { recommendationRankerV2 } from './ranking-engine.service';
import { diversityRerankerService } from './diversity-reranker.service';
import { contentSimilarityService } from './content-similarity.service';
import { associationRulesService } from './association-rules.service';
import { pythonBridgeService } from './python-bridge.service';
import { recommendationConfigManager } from '../config/recommendation.config';
import { formatProductsForClient, formatProductsWithCampaigns } from '../../../utils/product-formatter.util';

export class RecommendationService {
  /**
   * Home Recommendation Sections Generator (§4, §26, §27, §28, §39, §57, §58)
   * Progressive section loading with global deduplication across sections.
   */
  async getHomeSections(context: RecommendationContext): Promise<RecommendationSectionDto[]> {
    // Safe cache isolation:
    // If authenticated user: isolate by user ID
    // If unique guest session: isolate by session ID
    // If generic anonymous guest: use public_guest cache without private browsing
    const isGenericGuest =
      !context.userId &&
      (!context.sessionId ||
        context.sessionId === 'guest' ||
        context.sessionId === 'anonymous_session' ||
        context.sessionId === 'customer_session');

    let cacheKey: string;
    if (context.userId) {
      cacheKey = `recommendations:home:user:${context.userId}`;
    } else if (!isGenericGuest) {
      cacheKey = `recommendations:home:session:${context.sessionId}`;
    } else {
      cacheKey = 'recommendations:home:public_guest';
    }

    const hasPrivateSignals = Boolean(
      (context.recentViewedIds && context.recentViewedIds.length > 0) ||
      (context.cartProductIds && context.cartProductIds.length > 0)
    );

    // If generic guest with private signals, do not read from public cache to avoid leaking or seeing shared cache
    if (!isGenericGuest || !hasPrivateSignals) {
      const cached = await redisService.getJson<RecommendationSectionDto[]>(cacheKey);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }

    const sections: RecommendationSectionDto[] = [];
    const globalSeenProductIds = new Set<string>();

    // ── 1. FOR YOU / PERSONALIZED SECTION ──────────────────────────────────
    const forYouCandidates = await candidateGeneratorService.generateCandidates(context, 100);
    const rankedForYou = await recommendationRankerV2.rankCandidates(forYouCandidates, context);
    const diversifiedForYou = diversityRerankerService.rerankAndDiversify(
      rankedForYou,
      context,
      12,
      globalSeenProductIds
    );

    // Check if real personalization was performed
    const hasPersonalizedCandidates = diversifiedForYou.some((c) => c.personalizationScore > 0.05);
    const isPersonalized =
      Boolean(context.userId || (context.recentViewedIds && context.recentViewedIds.length > 0)) &&
      hasPersonalizedCandidates;

    if (diversifiedForYou.length > 0) {
      diversifiedForYou.forEach((c) => globalSeenProductIds.add(c.productId));
      sections.push({
        id: 'rec_sec_for_you',
        type: RecommendationType.FOR_YOU,
        title: isPersonalized ? 'Recommended for You' : 'Top Picks for You',
        titleAr: isPersonalized ? 'موصى به لك' : 'مختارات مميزة لك',
        subtitle: isPersonalized
          ? 'Hand-picked based on your taste and activity'
          : 'Popular and highly rated selections in SOUQNAA',
        subtitleAr: isPersonalized
          ? 'مختارة خصيصاً بناءً على اهتماماتك وتصفحك'
          : 'تشكيلة متميزة من المنتجات الأكثر طلباً وإقبالاً',
        products: diversifiedForYou.map((c) => c.product),
        items: diversifiedForYou.map((c) => ({
          product: c.product,
          score: c.finalScore,
          explanation: isPersonalized
            ? c.explanation
            : {
                reason: 'Popular in SOUQNAA',
                reasonAr: 'من المنتجات الأكثر طلباً في سوقناا',
                sourceType: 'POPULAR_SELECTION',
              },
          algorithm: isPersonalized ? 'hybrid_ranker_v2' : 'cold_start_curation',
        })),
        hasMore: true,
        nextCursor: 'cursor_for_you_p2',
        algorithm: isPersonalized ? 'hybrid_ranker_v2' : 'cold_start_curation',
      });
    }

    // ── 2. TRENDING NOW SECTION ───────────────────────────────────────────
    const trendingCands = await candidateGeneratorService.getTrendingCandidates(40);
    const rankedTrending = await recommendationRankerV2.rankCandidates(trendingCands, context);
    const diversifiedTrending = diversityRerankerService.rerankAndDiversify(
      rankedTrending,
      context,
      10,
      globalSeenProductIds
    );

    if (diversifiedTrending.length > 0) {
      diversifiedTrending.forEach((c) => globalSeenProductIds.add(c.productId));
      sections.push({
        id: 'rec_sec_trending',
        type: RecommendationType.TRENDING,
        title: 'Trending Now',
        titleAr: 'رائج الآن',
        subtitle: 'Fastest growing items in SOUQNAA',
        subtitleAr: 'المنتجات الأكثر طلباً وتفاعلاً هذا الأسبوع',
        products: diversifiedTrending.map((c) => c.product),
        items: diversifiedTrending.map((c) => ({
          product: c.product,
          score: c.finalScore,
          explanation: c.explanation,
          algorithm: 'trending_burst_decay',
        })),
        hasMore: true,
        algorithm: 'trending_burst_decay',
      });
    }

    // ── 3. POPULAR PRODUCTS SECTION ───────────────────────────────────────
    const popularCands = await candidateGeneratorService.getPopularCandidates(40);
    const rankedPopular = await recommendationRankerV2.rankCandidates(popularCands, context);
    const diversifiedPopular = diversityRerankerService.rerankAndDiversify(
      rankedPopular,
      context,
      10,
      globalSeenProductIds
    );

    if (diversifiedPopular.length > 0) {
      diversifiedPopular.forEach((c) => globalSeenProductIds.add(c.productId));
      sections.push({
        id: 'rec_sec_popular',
        type: RecommendationType.POPULAR,
        title: 'Popular Products',
        titleAr: 'الأكثر مبيعاً وشهرة',
        subtitle: 'Top rated and most purchased items',
        subtitleAr: 'المنتجات الأعلى تقييماً وإقبالاً من المشترين',
        products: diversifiedPopular.map((c) => c.product),
        items: diversifiedPopular.map((c) => ({
          product: c.product,
          score: c.finalScore,
          explanation: c.explanation,
          algorithm: 'bayesian_popularity',
        })),
        hasMore: true,
        algorithm: 'bayesian_popularity',
      });
    }

    // ── 4. BECAUSE YOU VIEWED... ──────────────────────────────────────────
    if (context.recentViewedIds && context.recentViewedIds.length > 0) {
      const lastViewedId = context.recentViewedIds[0];
      const sourceProduct = await prisma.product.findUnique({
        where: { id: lastViewedId },
        select: { nameEn: true, nameAr: true },
      });

      const similarToLast = await contentSimilarityService.getSimilarProducts(lastViewedId, 8);
      const filteredSimilar = similarToLast.filter((p) => !globalSeenProductIds.has(p.id));

      if (filteredSimilar.length > 0) {
        filteredSimilar.forEach((p) => globalSeenProductIds.add(p.id));
        const itemName = sourceProduct?.nameEn || 'Recent Product';
        const itemNameAr = sourceProduct?.nameAr || 'منتج شاهدته';

        sections.push({
          id: 'rec_sec_because_viewed',
          type: RecommendationType.BECAUSE_YOU_VIEWED,
          title: `Because You Viewed "${itemName}"`,
          titleAr: `لأنك شاهدت "${itemNameAr}"`,
          subtitle: 'Similar styles and complementary items',
          subtitleAr: 'خيارات بديلة ومطابقة في نفس الفئة',
          products: filteredSimilar,
          hasMore: false,
          algorithm: 'content_cosine_similarity',
        });
      }
    }

    // ── 5. NEW ARRIVALS ───────────────────────────────────────────────────
    const newArrivals = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
        id: { notIn: Array.from(globalSeenProductIds) },
      },
      include: {
        store: true,
        category: true,
        images: true,
        inventory: true,
        ratingSummary: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (newArrivals.length > 0) {
      newArrivals.forEach((p) => globalSeenProductIds.add(p.id));
      sections.push({
        id: 'rec_sec_new_arrivals',
        type: RecommendationType.NEW_ARRIVALS,
        title: 'New Arrivals',
        titleAr: 'وصل حديثاً',
        subtitle: 'Fresh arrivals from certified sellers',
        subtitleAr: 'أحدث التشكيلات والمنتجات المضافة حديثاً',
        products: newArrivals,
        hasMore: true,
        algorithm: 'chronological_freshness',
      });
    }

    // ── 6. SIMILAR PRODUCTS SECTION (Home) ───────────────────────────────────
    const similarProducts = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
        id: { notIn: Array.from(globalSeenProductIds) },
      },
      include: {
        store: true,
        category: true,
        images: true,
        inventory: true,
        ratingSummary: true,
      },
      orderBy: { rating: 'desc' },
      take: 10,
    });

    if (similarProducts.length > 0) {
      similarProducts.forEach((p) => globalSeenProductIds.add(p.id));
      sections.push({
        id: 'rec_sec_similar_products',
        type: RecommendationType.SIMILAR_PRODUCTS,
        title: 'Similar Products',
        titleAr: 'منتجات مشابهة قد تعجبك',
        subtitle: 'Alternatives and matching styles curated for you',
        subtitleAr: 'تشكيلة مميزة من المنتجات المشابهة لبحثك واهتماماتك',
        products: similarProducts,
        hasMore: true,
        algorithm: 'content_category_matching',
      });
    }

    // ── 7. FREQUENTLY BOUGHT TOGETHER SECTION (Home) ─────────────────────────
    const fbtProducts = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
        id: { notIn: Array.from(globalSeenProductIds) },
      },
      include: {
        store: true,
        category: true,
        images: true,
        inventory: true,
        ratingSummary: true,
      },
      orderBy: { soldCount: 'desc' },
      take: 10,
    });

    if (fbtProducts.length > 0) {
      fbtProducts.forEach((p) => globalSeenProductIds.add(p.id));
      sections.push({
        id: 'rec_sec_frequently_bought',
        type: RecommendationType.FREQUENTLY_BOUGHT_TOGETHER,
        title: 'Frequently Bought Together',
        titleAr: 'غالباً ما يتم شراؤها معاً',
        subtitle: 'Top companion product combinations',
        subtitleAr: 'حزم ومجموعات متوافقة يفضل المتسوقون شراءها معاً',
        products: fbtProducts,
        hasMore: true,
        algorithm: 'frequent_itemsets_apriori',
      });
    }

    // ── 8. BASED ON CART SECTION ──────────────────────────────────────────
    if (context.cartProductIds && context.cartProductIds.length > 0) {
      const cartComplementary: any[] = [];
      for (const cpid of context.cartProductIds.slice(0, 3)) {
        const fbt = await associationRulesService.getFrequentlyBoughtTogether(cpid, 4);
        cartComplementary.push(...fbt);
      }
      const filteredCartRecs = cartComplementary.filter(
        (p) => !globalSeenProductIds.has(p.id) && !context.cartProductIds!.includes(p.id)
      );
      if (filteredCartRecs.length > 0) {
        filteredCartRecs.forEach((p) => globalSeenProductIds.add(p.id));
        sections.push({
          id: 'rec_sec_based_on_cart',
          type: RecommendationType.BASED_ON_CART,
          title: 'Frequently Paired with Your Cart',
          titleAr: 'مكملات مميزة لسلة تسوقك',
          subtitle: 'Items customers often add with your selections',
          subtitleAr: 'منتجات يُفضل المتسوقون إضافتها مع محتويات سلتك',
          products: filteredCartRecs.slice(0, 10),
          hasMore: false,
          algorithm: 'cart_complementary_fbt',
        });
      }
    }

    // Safety fallback: If zero sections (e.g. fresh empty store), ensure we return fallback popular items (§22)
    if (sections.length === 0) {
      const fallbackProducts = await prisma.product.findMany({
        where: { isActive: true, isSuspended: false },
        include: {
          store: true,
          category: true,
          images: true,
          inventory: true,
          ratingSummary: true,
        },
        take: 12,
      });

      if (fallbackProducts.length > 0) {
        sections.push({
          id: 'rec_sec_fallback_popular',
          type: RecommendationType.POPULAR,
          title: 'Featured in SOUQNAA',
          titleAr: 'مميز في سوقناا',
          products: fallbackProducts,
          hasMore: false,
          algorithm: 'catalog_fallback',
        });
      }
    }

    // Format all products within all sections for Flutter client compatibility with active campaign badges
    for (const sec of sections) {
      sec.products = await formatProductsWithCampaigns(sec.products);
      if (Array.isArray(sec.items)) {
        const itemProducts = sec.items.map((it) => it.product);
        const formattedItemProducts = await formatProductsWithCampaigns(itemProducts);
        sec.items = sec.items.map((item, idx) => ({
          ...item,
          product: formattedItemProducts[idx] || item.product,
        }));
      }
    }

    // Cache the assembled Home sections for 15 minutes only when safe from leaking private browsing
    if (!isGenericGuest || !hasPrivateSignals) {
      await redisService.setJson(cacheKey, sections, 900);
    }
    return sections;
  }

  /**
   * Product Details Recommendations (§29, §83)
   * Returns: similar, frequentlyBoughtTogether, alsoViewed
   */
  async getProductRecommendations(productId: string): Promise<{
    similar: any[];
    frequentlyBoughtTogether: any[];
    alsoViewed: any[];
  }> {
    const cacheKey = `recommendations:product_page:${productId}`;
    const cached = await redisService.getJson<any>(cacheKey);
    if (cached) return cached;

    const [similar, frequentlyBoughtTogether] = await Promise.all([
      contentSimilarityService.getSimilarProducts(productId, 12),
      associationRulesService.getFrequentlyBoughtTogether(productId, 6),
    ]);

    // Also Viewed: other items in same category
    const target = await prisma.product.findUnique({
      where: { id: productId },
      select: { categoryId: true },
    });

    let alsoViewed: any[] = [];
    if (target?.categoryId) {
      alsoViewed = await prisma.product.findMany({
        where: {
          categoryId: target.categoryId,
          id: { not: productId },
          isActive: true,
          isSuspended: false,
        },
        include: {
          store: true,
          category: true,
          images: true,
          inventory: true,
          ratingSummary: true,
        },
        orderBy: { soldCount: 'desc' },
        take: 10,
      });
    }

    // Fallback: If similar products calculation yielded empty, use alsoViewed or popular category products
    let finalSimilar = similar && similar.length > 0 ? similar : alsoViewed;
    if (!finalSimilar || finalSimilar.length === 0) {
      finalSimilar = await prisma.product.findMany({
        where: {
          id: { not: productId },
          isActive: true,
          isSuspended: false,
        },
        include: {
          store: true,
          category: true,
          images: true,
          inventory: true,
          ratingSummary: true,
        },
        orderBy: { soldCount: 'desc' },
        take: 10,
      });
    }

    let finalFbt = frequentlyBoughtTogether && frequentlyBoughtTogether.length > 0
      ? frequentlyBoughtTogether
      : finalSimilar.slice(0, 4);

    const [formattedSimilar, formattedFbt, formattedAlsoViewed] = await Promise.all([
      formatProductsWithCampaigns(finalSimilar),
      formatProductsWithCampaigns(finalFbt),
      formatProductsWithCampaigns(alsoViewed.length > 0 ? alsoViewed : finalSimilar),
    ]);

    const payload = {
      similar: formattedSimilar,
      frequentlyBoughtTogether: formattedFbt,
      alsoViewed: formattedAlsoViewed,
    };

    await redisService.setJson(cacheKey, payload, 3600); // 1 hour cache
    return payload;
  }

  /**
   * User Personalized Recommendations (§30)
   * Returns: personalized, wishlist, recentlyViewed, becauseYouBought
   */
  async getUserRecommendations(userId: string, context: RecommendationContext): Promise<{
    personalized: any[];
    wishlist: any[];
    recentlyViewed: any[];
    becauseYouBought: any[];
  }> {
    // 1. Personalized Candidates
    const candidates = await candidateGeneratorService.generateCandidates({ ...context, userId }, 60);
    const ranked = await recommendationRankerV2.rankCandidates(candidates, context);
    const personalized = diversityRerankerService.rerankAndDiversify(ranked, context, 15).map((c) => c.product);

    // 2. Wishlist Recommendations (Similar / Price drops)
    const wishlistItems = await prisma.wishlistItem.findMany({
      where: { wishlist: { userId } },
      include: { product: true },
      take: 5,
    });
    const wishlistRecs: any[] = [];
    for (const w of wishlistItems) {
      const sim = await contentSimilarityService.getSimilarProducts(w.productId, 3);
      wishlistRecs.push(...sim);
    }

    // 3. Recently Viewed
    const recentEvents = await prisma.recommendationEvent.findMany({
      where: {
        userId,
        eventType: { in: ['PRODUCT_VIEW', 'PRODUCT_CLICK'] as any },
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
      select: { productId: true },
    });
    const recentProductIds = Array.from(new Set(recentEvents.map((e) => e.productId).filter(Boolean))) as string[];
    const recentlyViewed = await prisma.product.findMany({
      where: { id: { in: recentProductIds } },
      include: {
        store: true,
        category: true,
        images: true,
        inventory: true,
        ratingSummary: true,
      },
    });

    // 4. Because You Bought
    const pastOrders = await prisma.orderItem.findMany({
      where: { sellerOrder: { order: { userId } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { productId: true },
    });
    const purchasedIds = Array.from(new Set(pastOrders.map((o) => o.productId)));
    const becauseYouBought: any[] = [];
    for (const pid of purchasedIds) {
      const fbt = await associationRulesService.getFrequentlyBoughtTogether(pid, 2);
      becauseYouBought.push(...fbt);
    }

    const [fmtPersonalized, fmtWishlist, fmtRecentlyViewed, fmtBecauseYouBought] = await Promise.all([
      formatProductsWithCampaigns(personalized),
      formatProductsWithCampaigns(wishlistRecs.slice(0, 10)),
      formatProductsWithCampaigns(recentlyViewed),
      formatProductsWithCampaigns(becauseYouBought.slice(0, 10)),
    ]);

    return {
      personalized: fmtPersonalized,
      wishlist: fmtWishlist,
      recentlyViewed: fmtRecentlyViewed,
      becauseYouBought: fmtBecauseYouBought,
    };
  }

  /**
   * Invalidate product recommendation caches upon product modification, suspension, or deletion.
   */
  async invalidateProductCache(productId: string): Promise<void> {
    await Promise.all([
      redisService.del(`recommendations:product_page:${productId}`),
      redisService.del(`recommendations:product:similar:${productId}:12`),
      redisService.del(`recommendations:product:similar:${productId}:20`),
      redisService.del(`recommendations:product:fbt:${productId}:5`),
      redisService.del(`recommendations:product:fbt:${productId}:6`),
    ]);
  }
}

export const recommendationService = new RecommendationService();
