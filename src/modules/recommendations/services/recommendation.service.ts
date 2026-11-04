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
import { featureStoreService } from './feature-store.service';
import { recommendationConfigManager } from '../config/recommendation.config';
import { formatProductsForClient, formatProductsWithCampaigns } from '../../../utils/product-formatter.util';

export class RecommendationService {
  private inFlightProductRecs = new Map<string, Promise<{
    similar: any[];
    frequentlyBoughtTogether: any[];
    alsoViewed: any[];
  }>>();
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
    const citySuffix = context.cityId ? `:city:${context.cityId}` : '';
    if (context.userId) {
      cacheKey = `recommendations:home:user:${context.userId}${citySuffix}`;
    } else if (!isGenericGuest) {
      cacheKey = `recommendations:home:session:${context.sessionId}${citySuffix}`;
    } else {
      cacheKey = `recommendations:home:public_guest${citySuffix}`;
    }

    const hasPrivateSignals = Boolean(
      (context.recentViewedIds && context.recentViewedIds.length > 0) ||
      (context.cartProductIds && context.cartProductIds.length > 0)
    );

    // If generic guest with private signals or if forcing refresh, do not read from cache
    if (!context.forceRefresh && (!isGenericGuest || !hasPrivateSignals)) {
      const cached = await redisService.getJson<RecommendationSectionDto[]>(cacheKey);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }

    const sections: RecommendationSectionDto[] = [];

    // Helper to ensure 100% unique products within each section
    const uniqueById = (items: any[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        const id = item.id || item.productId;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    };

    // ── 1. NEW ARRIVALS SECTION (وصل حديثاً — First Section) ───────────────
    const newArrivals = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
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
      sections.push({
        id: 'rec_sec_new_arrivals',
        type: RecommendationType.NEW_ARRIVALS,
        title: 'New Arrivals',
        titleAr: 'وصل حديثاً',
        subtitle: 'Fresh arrivals from certified sellers',
        subtitleAr: 'أحدث التشكيلات والمنتجات المضافة حديثاً',
        products: uniqueById(newArrivals),
        items: newArrivals.map((p) => ({
          product: p,
          score: 1.0,
          explanation: {
            reason: 'Newly listed product',
            reasonAr: 'وصل حديثاً إلى سوقناا',
            sourceType: 'NEW_ARRIVALS',
          },
          algorithm: 'chronological_freshness',
        })),
        hasMore: true,
        algorithm: 'chronological_freshness',
      });
    }

    // ── 2. FOR YOU / PERSONALIZED SECTION ──────────────────────────────────
    const forYouCandidates = await candidateGeneratorService.generateCandidates(context, 100);
    const rankedForYou = await recommendationRankerV2.rankCandidates(forYouCandidates, context);
    const diversifiedForYou = diversityRerankerService.rerankAndDiversify(
      rankedForYou,
      context,
      12
    );

    // Check if real personalization was performed
    const hasPersonalizedCandidates = diversifiedForYou.some((c) => c.personalizationScore > 0.05);
    const isPersonalized =
      Boolean(context.userId || (context.recentViewedIds && context.recentViewedIds.length > 0)) &&
      hasPersonalizedCandidates;

    if (diversifiedForYou.length > 0) {
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
                reason: 'Top Pick in SOUQNAA',
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
      10
    );

    if (diversifiedTrending.length > 0) {
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
          explanation: c.explanation || {
            reason: 'Trending fast this week',
            reasonAr: 'من المنتجات الأكثر رواجاً هذا الأسبوع',
            sourceType: 'TRENDING',
          },
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
      10
    );

    if (diversifiedPopular.length > 0) {
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
          explanation: c.explanation || {
            reason: 'Top rated and best selling',
            reasonAr: 'الأعلى تقييماً والأكثر طلباً',
            sourceType: 'POPULAR',
          },
          algorithm: 'bayesian_popularity',
        })),
        hasMore: true,
        algorithm: 'bayesian_popularity',
      });
    }

    // ── 4. BECAUSE YOU VIEWED... ──────────────────────────────────────────
    // Determine the reference product ID:
    let refProductId = context.recentViewedIds?.[0];
    if (!refProductId && (context.userId || context.sessionId)) {
      const recentEvt = await prisma.recommendationEvent.findFirst({
        where: {
          OR: [
            ...(context.userId ? [{ userId: context.userId }] : []),
            ...(context.sessionId ? [{ sessionId: context.sessionId }] : []),
          ],
          eventType: 'PRODUCT_VIEW',
        },
        orderBy: { timestamp: 'desc' },
        select: { productId: true },
      });
      if (recentEvt?.productId) {
        refProductId = recentEvt.productId;
      }
    }
    // If still null, check user profile
    if (!refProductId) {
      const profile = await featureStoreService.buildUserProfile(context.userId, context.sessionId);
      if (profile?.recentProductIds) {
        try {
          const ids = JSON.parse(profile.recentProductIds);
          if (Array.isArray(ids) && ids.length > 0) refProductId = ids[0];
        } catch (_) {}
      }
    }
    // Fallback if brand new guest with zero history: pick #1 trending product as reference
    let isBecauseViewedPersonalized = true;
    if (!refProductId && trendingCands.length > 0) {
      refProductId = trendingCands[0].productId;
      isBecauseViewedPersonalized = false;
    }

    if (refProductId) {
      const sourceProduct = await prisma.product.findUnique({
        where: { id: refProductId },
        select: { id: true, nameEn: true, nameAr: true, categoryId: true, storeId: true },
      });

      if (sourceProduct) {
        let similarProducts = await contentSimilarityService.getSimilarProducts(refProductId, 10);
        // Exclude the source product itself
        similarProducts = similarProducts.filter((p) => p.id !== refProductId);

        // If fewer than 4 items, backfill from the same category
        if (similarProducts.length < 4 && sourceProduct.categoryId) {
          const existingIds = new Set(similarProducts.map((p) => p.id));
          existingIds.add(refProductId);
          const categoryBackfill = await prisma.product.findMany({
            where: {
              categoryId: sourceProduct.categoryId,
              id: { notIn: Array.from(existingIds) },
              isActive: true,
              isSuspended: false,
              inventory: { quantity: { gt: 0 } },
            },
            include: {
              store: true,
              category: true,
              images: true,
              inventory: true,
              ratingSummary: true,
            },
            orderBy: { soldCount: 'desc' },
            take: 10 - similarProducts.length,
          });
          similarProducts.push(...categoryBackfill);
        }

        if (similarProducts.length > 0) {
          const itemName = sourceProduct.nameEn || 'Recent Product';
          const itemNameAr = sourceProduct.nameAr || 'منتج مميز';

          sections.push({
            id: 'rec_sec_because_viewed',
            type: RecommendationType.BECAUSE_YOU_VIEWED,
            title: isBecauseViewedPersonalized
              ? `Because You Viewed "${itemName}"`
              : `Because Shoppers Love "${itemName}"`,
            titleAr: isBecauseViewedPersonalized
              ? `لأنك شاهدت "${itemNameAr}"`
              : `لأن المتسوقين يفضلون "${itemNameAr}"`,
            subtitle: 'Similar styles and complementary items',
            subtitleAr: 'خيارات بديلة ومطابقة في نفس الفئة',
            products: uniqueById(similarProducts),
            items: similarProducts.map((p) => ({
              product: p,
              score: p.similarityScore || 0.8,
              explanation: {
                reason: `Similar to ${itemName}`,
                reasonAr: `منتج مشابه لـ "${itemNameAr}"`,
                sourceType: 'CONTENT_SIMILARITY',
              },
              algorithm: 'content_cosine_similarity',
            })),
            hasMore: false,
            algorithm: 'content_cosine_similarity',
          });
        }
      }
    }

    // ── 6. SIMILAR PRODUCTS SECTION (Home) ───────────────────────────────────
    // Focal point: 2nd viewed item, or category focal, or top rated
    let similarFocalId = context.recentViewedIds?.[1] || context.recentViewedIds?.[0];
    if (!similarFocalId || similarFocalId === refProductId) {
      // Pick a top product from a different category or store
      const altProduct = await prisma.product.findFirst({
        where: {
          isActive: true,
          isSuspended: false,
          inventory: { quantity: { gt: 0 } },
          ...(refProductId ? { id: { not: refProductId } } : {}),
        },
        orderBy: [{ rating: 'desc' }, { soldCount: 'desc' }],
        select: { id: true, categoryId: true },
      });
      if (altProduct) similarFocalId = altProduct.id;
    }

    if (similarFocalId) {
      let matchingSimilar = await contentSimilarityService.getSimilarProducts(similarFocalId, 10);
      matchingSimilar = matchingSimilar.filter((p) => p.id !== similarFocalId);

      if (matchingSimilar.length < 4) {
        const simRef = await prisma.product.findUnique({
          where: { id: similarFocalId },
          select: { categoryId: true },
        });
        if (simRef?.categoryId) {
          const catItems = await prisma.product.findMany({
            where: {
              categoryId: simRef.categoryId,
              id: { not: similarFocalId },
              isActive: true,
              isSuspended: false,
              inventory: { quantity: { gt: 0 } },
            },
            include: {
              store: true,
              category: true,
              images: true,
              inventory: true,
              ratingSummary: true,
            },
            orderBy: { rating: 'desc' },
            take: 10 - matchingSimilar.length,
          });
          matchingSimilar.push(...catItems);
        }
      }

      if (matchingSimilar.length > 0) {
        sections.push({
          id: 'rec_sec_similar_products',
          type: RecommendationType.SIMILAR_PRODUCTS,
          title: 'Similar Products You May Like',
          titleAr: 'منتجات مشابهة قد تعجبك',
          subtitle: 'Alternatives and matching styles curated for you',
          subtitleAr: 'تشكيلة مميزة من المنتجات المشابهة لبحثك واهتماماتك',
          products: uniqueById(matchingSimilar),
          items: matchingSimilar.map((p) => ({
            product: p,
            score: p.similarityScore || 0.75,
            explanation: {
              reason: 'Matches your style and preferences',
              reasonAr: 'خيارات مطابقة ومميزة تناسب ذوقك',
              sourceType: 'SIMILAR_STYLES',
            },
            algorithm: 'content_category_matching',
          })),
          hasMore: true,
          algorithm: 'content_category_matching',
        });
      }
    }

    // ── 7. FREQUENTLY BOUGHT TOGETHER SECTION (Home) ─────────────────────────
    let fbtFocalId =
      context.cartProductIds?.[0] ||
      context.recentViewedIds?.[0] ||
      diversifiedPopular[0]?.productId ||
      refProductId;

    if (fbtFocalId) {
      let fbtList = await associationRulesService.getFrequentlyBoughtTogether(fbtFocalId, 10);
      fbtList = fbtList.filter((p) => p.id !== fbtFocalId);

      if (fbtList.length < 4) {
        const focalProduct = await prisma.product.findUnique({
          where: { id: fbtFocalId },
          select: { storeId: true, categoryId: true },
        });
        const existingFbtIds = new Set(fbtList.map((p) => p.id));
        existingFbtIds.add(fbtFocalId);

        const complementaryBackfill = await prisma.product.findMany({
          where: {
            OR: [
              ...(focalProduct?.storeId ? [{ storeId: focalProduct.storeId }] : []),
              ...(focalProduct?.categoryId ? [{ categoryId: focalProduct.categoryId }] : []),
            ],
            id: { notIn: Array.from(existingFbtIds) },
            isActive: true,
            isSuspended: false,
            inventory: { quantity: { gt: 0 } },
          },
          include: {
            store: true,
            category: true,
            images: true,
            inventory: true,
            ratingSummary: true,
          },
          orderBy: { soldCount: 'desc' },
          take: 10 - fbtList.length,
        });
        fbtList.push(...complementaryBackfill);
      }

      if (fbtList.length > 0) {
        sections.push({
          id: 'rec_sec_frequently_bought',
          type: RecommendationType.FREQUENTLY_BOUGHT_TOGETHER,
          title: 'Frequently Bought Together',
          titleAr: 'غالباً ما يتم شراؤها معاً',
          subtitle: 'Top companion product combinations',
          subtitleAr: 'حزم ومجموعات متوافقة يفضل المتسوقون شراءها معاً',
          products: uniqueById(fbtList),
          items: fbtList.map((p) => ({
            product: p,
            score: p.fbtScore || 0.85,
            explanation: {
              reason: 'Frequently paired by shoppers',
              reasonAr: 'حزم ومجموعات متوافقة يفضل المتسوقون شراءها معاً',
              sourceType: 'FREQUENTLY_BOUGHT_TOGETHER',
            },
            algorithm: 'frequent_itemsets_apriori',
          })),
          hasMore: true,
          algorithm: 'frequent_itemsets_apriori',
        });
      }
    }

    // ── 8. BASED ON CART SECTION ──────────────────────────────────────────
    if (context.cartProductIds && context.cartProductIds.length > 0) {
      const cartComplementary: any[] = [];
      const cartSet = new Set(context.cartProductIds);
      for (const cpid of context.cartProductIds.slice(0, 3)) {
        const fbt = await associationRulesService.getFrequentlyBoughtTogether(cpid, 4);
        cartComplementary.push(...fbt);
      }
      const filteredCartRecs = cartComplementary.filter((p) => !cartSet.has(p.id));
      if (filteredCartRecs.length > 0) {
        sections.push({
          id: 'rec_sec_based_on_cart',
          type: RecommendationType.BASED_ON_CART,
          title: 'Frequently Paired with Your Cart',
          titleAr: 'مكملات مميزة لسلة تسوقك',
          subtitle: 'Items customers often add with your selections',
          subtitleAr: 'منتجات يُفضل المتسوقون إضافتها مع محتويات سلتك',
          products: uniqueById(filteredCartRecs).slice(0, 10),
          items: filteredCartRecs.map((p) => ({
            product: p,
            score: p.fbtScore || 0.85,
            explanation: {
              reason: 'Pairs well with your cart',
              reasonAr: 'مكمل رائع لمحتويات سلتك',
              sourceType: 'CART_COMPLEMENTARY',
            },
            algorithm: 'cart_complementary_fbt',
          })),
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

    // Filter products by serviceable stores if destination is active
    if (context.serviceableStoreIds && Array.isArray(context.serviceableStoreIds)) {
      const allowedIds = new Set(context.serviceableStoreIds);
      for (const sec of sections) {
        sec.products = sec.products.filter((p: any) => {
          const sId = p.storeId || p.store?.id;
          return sId ? allowedIds.has(sId) : false;
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

    const filteredSections = sections.filter((sec) => sec.products && sec.products.length > 0);

    // Cache the assembled Home sections for 15 minutes only when safe from leaking private browsing
    if (!isGenericGuest || !hasPrivateSignals) {
      await redisService.setJson(cacheKey, filteredSections, 900);
    }
    return filteredSections;
  }

  /**
   * Product Details Recommendations (§29, §83)
   * Returns: similar, frequentlyBoughtTogether, alsoViewed
   * Deduplicates concurrent in-flight executions and caches assembled payload in Redis.
   */
  async getProductRecommendations(
    productId: string,
    serviceableStoreIds?: string[],
    cityId?: string
  ): Promise<{
    similar: any[];
    frequentlyBoughtTogether: any[];
    alsoViewed: any[];
  }> {
    const cacheKey = serviceableStoreIds !== undefined
      ? `recommendations:product_page:${productId}:city:${cityId || 'all'}`
      : `recommendations:product_page:${productId}`;
    const cached = await redisService.getJson<any>(cacheKey);
    if (cached) return cached;

    // Deduplicate in-flight requests for the same product to eliminate duplicate heavy calculations
    if (this.inFlightProductRecs.has(cacheKey)) {
      return this.inFlightProductRecs.get(cacheKey)!;
    }

    const task = (async () => {
      try {
        if (serviceableStoreIds !== undefined && serviceableStoreIds.length === 0) {
          return { similar: [], frequentlyBoughtTogether: [], alsoViewed: [] };
        }

        const storeIdSet = serviceableStoreIds ? new Set(serviceableStoreIds) : null;

        let [similar, frequentlyBoughtTogether] = await Promise.all([
          contentSimilarityService.getSimilarProducts(productId, 12),
          associationRulesService.getFrequentlyBoughtTogether(productId, 6),
        ]);

        if (storeIdSet) {
          similar = similar.filter((p: any) => storeIdSet.has(p.storeId || p.store?.id));
          frequentlyBoughtTogether = frequentlyBoughtTogether.filter((p: any) => storeIdSet.has(p.storeId || p.store?.id));
        }

        // Also Viewed: other items in same category
        const target = await prisma.product.findUnique({
          where: { id: productId },
          select: { categoryId: true },
        });

        let alsoViewed: any[] = [];
        if (target?.categoryId) {
          const alsoWhere: any = {
            categoryId: target.categoryId,
            id: { not: productId },
            isActive: true,
            isSuspended: false,
          };
          if (storeIdSet) {
            alsoWhere.storeId = { in: Array.from(storeIdSet) };
          }
          alsoViewed = await prisma.product.findMany({
            where: alsoWhere,
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
          const fallbackWhere: any = {
            id: { not: productId },
            isActive: true,
            isSuspended: false,
          };
          if (storeIdSet) {
            fallbackWhere.storeId = { in: Array.from(storeIdSet) };
          }
          finalSimilar = await prisma.product.findMany({
            where: fallbackWhere,
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

        const targetAlsoViewed = alsoViewed.length > 0 ? alsoViewed : finalSimilar;

        // Batch resolve active campaign badges across unique candidate products in one pass
        const uniqueProductMap = new Map<string, any>();
        for (const p of [...finalSimilar, ...finalFbt, ...targetAlsoViewed]) {
          if (p?.id && !uniqueProductMap.has(p.id)) {
            uniqueProductMap.set(p.id, p);
          }
        }
        const formattedUnique = await formatProductsWithCampaigns(Array.from(uniqueProductMap.values()));
        const lookup = new Map<string, any>(formattedUnique.map((p: any) => [p.id, p]));

        let formattedSimilar = finalSimilar.map((p) => lookup.get(p.id) || p);
        let formattedFbt = finalFbt.map((p) => lookup.get(p.id) || p);
        let formattedAlsoViewed = targetAlsoViewed.map((p) => lookup.get(p.id) || p);

        if (storeIdSet) {
          formattedSimilar = formattedSimilar.filter((p: any) => storeIdSet.has(p.storeId || p.store?.id));
          formattedFbt = formattedFbt.filter((p: any) => storeIdSet.has(p.storeId || p.store?.id));
          formattedAlsoViewed = formattedAlsoViewed.filter((p: any) => storeIdSet.has(p.storeId || p.store?.id));
        }

        const payload = {
          similar: formattedSimilar,
          frequentlyBoughtTogether: formattedFbt,
          alsoViewed: formattedAlsoViewed,
        };

        await redisService.setJson(cacheKey, payload, 3600); // 1 hour cache
        return payload;
      } finally {
        this.inFlightProductRecs.delete(cacheKey);
      }
    })();

    this.inFlightProductRecs.set(cacheKey, task);
    return task;
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
    const storeIdSet = context.serviceableStoreIds ? new Set(context.serviceableStoreIds) : null;
    if (storeIdSet && storeIdSet.size === 0) {
      return { personalized: [], wishlist: [], recentlyViewed: [], becauseYouBought: [] };
    }
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
