import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { formatProductsWithCampaigns } from '../../utils/product-formatter.util';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { AppError } from '../../middleware/error.middleware';
import {
  normalizeArabic,
  getSearchTokensWithAliases,
  findTypoCorrections,
  isTypoMatch,
  CANONICAL_VOCABULARY,
} from './utils/arabic-normalizer.util';

export interface SearchParams {
  q?: string;
  categoryId?: string;
  brandId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  cursor?: string;
  userId?: string;
  locale?: string;
}

export interface SuggestionItem {
  text: string;
  type: 'RECENT' | 'POPULAR' | 'TRENDING' | 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'KEYWORD';
  id?: string;
  metadata?: Record<string, any>;
}

export interface SearchResponse {
  products: any[];
  total: number;
  page: number;
  limit: number;
  nextCursor: string | null;
  queryCorrection?: {
    originalQuery: string;
    correctedQuery: string;
    hasCorrection: boolean;
  };
}

export class SearchService {
  /**
   * Fetches active catalog vocabulary (brands and categories) for dynamic typo-correction.
   * Cached in Redis for 1 hour.
   */
  private async getCatalogVocabulary(): Promise<string[]> {
    const cacheKey = 'search:catalog:vocab';
    const cached = await redis.getJson<string[]>(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
    }

    try {
      const [brands, categories] = await Promise.all([
        prisma.brand.findMany({
          where: { isActive: true },
          select: { nameAr: true, nameEn: true },
          take: 200,
        }),
        prisma.category.findMany({
          where: { isActive: true },
          select: { nameAr: true, nameEn: true },
          take: 100,
        }),
      ]);

      const vocabSet = new Set<string>();
      for (const b of brands) {
        if (b.nameAr) vocabSet.add(b.nameAr);
        if (b.nameEn) vocabSet.add(b.nameEn);
      }
      for (const c of categories) {
        if (c.nameAr) vocabSet.add(c.nameAr);
        if (c.nameEn) vocabSet.add(c.nameEn);
      }

      const vocab = Array.from(vocabSet);
      await redis.setJson(cacheKey, vocab, 3600);
      return vocab;
    } catch {
      return [];
    }
  }

  /**
   * Calculates a multi-tier relevance score for a product given a query and its tokens.
   * Hierarchy:
   * 1. Exact SKU/barcode match (+10000)
   * 2. Exact product title match (+5000)
   * 3. Brand exact match (+3000)
   * 4. Title phrase match (+2000)
   * 5. Title token matches (+500 per token)
   * 6. Typo-corrected token match (+300 per token)
   * 7. Category match (+300)
   * 8. Description token matches (+100 per token)
   */
  private calculateRelevanceScore(
    product: any,
    rawQuery: string,
    normalizedQuery: string,
    tokens: string[],
    correctedQuery: string
  ): { score: number; relevanceGrade: 'EXACT' | 'CLOSE' | 'RELATED' } {
    let score = 0;
    const normNameAr = normalizeArabic(product.nameAr || '');
    const normNameEn = normalizeArabic(product.nameEn || '');
    const normDescAr = normalizeArabic(product.descriptionAr || '');
    const normDescEn = normalizeArabic(product.descriptionEn || '');
    const brandNameAr = normalizeArabic(product.brand?.nameAr || '');
    const brandNameEn = normalizeArabic(product.brand?.nameEn || '');
    const categoryNameAr = normalizeArabic(product.category?.nameAr || '');
    const categoryNameEn = normalizeArabic(product.category?.nameEn || '');
    const cleanSku = (product.sku || '').toLowerCase().trim();
    const cleanBarcode = (product.barcode || '').toLowerCase().trim();
    const cleanQuery = rawQuery.toLowerCase().trim();

    // 1. Exact SKU / Barcode match
    if (cleanSku && (cleanSku === cleanQuery || cleanSku === normalizedQuery)) {
      score += 10000;
      return { score, relevanceGrade: 'EXACT' };
    }
    if (cleanBarcode && (cleanBarcode === cleanQuery || cleanBarcode === normalizedQuery)) {
      score += 10000;
      return { score, relevanceGrade: 'EXACT' };
    }

    // 2. Exact Product Title match
    if (normNameAr === normalizedQuery || normNameEn === normalizedQuery) {
      score += 5000;
      return { score, relevanceGrade: 'EXACT' };
    }

    // 3. Exact Brand match
    if (
      brandNameAr &&
      (brandNameAr === normalizedQuery || normalizedQuery.includes(brandNameAr))
    ) {
      score += 2500;
    }
    if (
      brandNameEn &&
      (brandNameEn === normalizedQuery || normalizedQuery.includes(brandNameEn))
    ) {
      score += 2500;
    }

    // 4. Exact Phrase match in title
    if (normNameAr.includes(normalizedQuery) || normNameEn.includes(normalizedQuery)) {
      score += 2000;
    } else if (
      correctedQuery &&
      (normNameAr.includes(correctedQuery) || normNameEn.includes(correctedQuery))
    ) {
      score += 1500;
    }

    // 5. Title Token matches
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (normNameAr.includes(token) || normNameEn.includes(token)) {
        score += 500;
      } else if (isTypoMatch(token, normNameAr) || isTypoMatch(token, normNameEn)) {
        score += 250;
      }
    }

    // 6. Category match
    if (categoryNameAr.includes(normalizedQuery) || categoryNameEn.includes(normalizedQuery)) {
      score += 400;
    }

    // 7. Description Token matches
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (normDescAr.includes(token) || normDescEn.includes(token)) {
        score += 100;
      }
    }

    // Small popularity & rating tie-breaker
    const popularityBonus = Math.min(product.soldCount || 0, 50) + Math.round((product.rating || 0) * 10);
    score += popularityBonus;

    let relevanceGrade: 'EXACT' | 'CLOSE' | 'RELATED' = 'RELATED';
    if (score >= 4000) {
      relevanceGrade = 'EXACT';
    } else if (score >= 1500) {
      relevanceGrade = 'CLOSE';
    }

    return { score, relevanceGrade };
  }

  /**
   * Main catalog text search with dynamic filters, typo-tolerance, weighted relevance ranking,
   * cursor/page pagination, and query logging.
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(30, params.limit || 20));
    const skip = (page - 1) * limit;

    const rawQuery = params.q ? String(params.q).trim() : '';
    const normalizedQuery = normalizeArabic(rawQuery);

    // Dynamic catalog vocabulary for typo correction
    let catalogVocab: string[] = [];
    let typoInfo = { hasCorrection: false, correctedQuery: normalizedQuery };
    if (rawQuery.length > 0) {
      catalogVocab = await this.getCatalogVocabulary();
      typoInfo = findTypoCorrections(rawQuery, catalogVocab);
    }

    const where: any = {
      isActive: true,
      isSuspended: false,
    };

    if (params.categoryId) {
      const cleanCategoryId = String(params.categoryId).trim();
      const category = await prisma.category.findFirst({
        where: {
          OR: [{ id: cleanCategoryId }, { slug: cleanCategoryId }],
          isActive: true,
        },
        include: {
          children: {
            where: { isActive: true },
            select: { id: true },
          },
        },
      });

      if (!category) {
        throw new AppError('Invalid category identifier', 400);
      }

      const categoryIds = [category.id, ...category.children.map(c => c.id)];
      where.categoryId = { in: categoryIds };
    }

    if (params.brandId) where.brandId = params.brandId;

    if (params.minPrice != null || params.maxPrice != null) {
      if (params.minPrice != null && (isNaN(params.minPrice) || params.minPrice < 0)) {
        throw new AppError('Minimum price must be a valid non-negative number', 400);
      }
      if (params.maxPrice != null && (isNaN(params.maxPrice) || params.maxPrice < 0)) {
        throw new AppError('Maximum price must be a valid non-negative number', 400);
      }
      if (params.minPrice != null && params.maxPrice != null && params.minPrice > params.maxPrice) {
        throw new AppError('Minimum price cannot exceed maximum price', 400);
      }
      where.price = {};
      if (params.minPrice != null) where.price.gte = params.minPrice;
      if (params.maxPrice != null) where.price.lte = params.maxPrice;
    }

    if (params.inStock) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { inventory: { quantity: { gt: 0 } } },
            { variants: { some: { stockQuantity: { gt: 0 } } } },
          ],
        },
      ];
    }

    // Build text query with Arabic normalization, aliases, and typo-corrections
    let searchTokens: string[] = [];
    if (rawQuery.length > 0) {
      searchTokens = getSearchTokensWithAliases(rawQuery, catalogVocab);

      const orConditions: any[] = [
        // Exact SKU / Barcode lookup
        { sku: { equals: rawQuery, mode: 'insensitive' } },
        { barcode: { equals: rawQuery } },
        // Direct title and description matches
        { nameAr: { contains: rawQuery, mode: 'insensitive' } },
        { nameEn: { contains: rawQuery, mode: 'insensitive' } },
        { descriptionAr: { contains: rawQuery, mode: 'insensitive' } },
        { descriptionEn: { contains: rawQuery, mode: 'insensitive' } },
        // Brand name matches
        { brand: { nameAr: { contains: rawQuery, mode: 'insensitive' } } },
        { brand: { nameEn: { contains: rawQuery, mode: 'insensitive' } } },
        // Category name matches
        { category: { nameAr: { contains: rawQuery, mode: 'insensitive' } } },
        { category: { nameEn: { contains: rawQuery, mode: 'insensitive' } } },
      ];

      // Add typo-corrected query condition if available
      if (typoInfo.hasCorrection && typoInfo.correctedQuery !== normalizedQuery) {
        orConditions.push(
          { nameAr: { contains: typoInfo.correctedQuery, mode: 'insensitive' } },
          { nameEn: { contains: typoInfo.correctedQuery, mode: 'insensitive' } },
          { brand: { nameAr: { contains: typoInfo.correctedQuery, mode: 'insensitive' } } },
          { brand: { nameEn: { contains: typoInfo.correctedQuery, mode: 'insensitive' } } },
        );
      }

      // Add alias and individual token expansions
      for (const token of searchTokens) {
        if (token !== rawQuery && token.length > 1) {
          orConditions.push(
            { nameAr: { contains: token, mode: 'insensitive' } },
            { nameEn: { contains: token, mode: 'insensitive' } },
            { brand: { nameAr: { contains: token, mode: 'insensitive' } } },
            { brand: { nameEn: { contains: token, mode: 'insensitive' } } },
          );
        }
      }

      where.OR = orConditions;
    }

    // Order mapping
    let orderBy: any = { createdAt: 'desc' };
    const sort = params.sortBy || 'relevance';
    if (sort === 'top_sales' || sort === 'soldCount') {
      orderBy = { soldCount: 'desc' };
    } else if (sort === 'price_asc') {
      orderBy = { price: 'asc' };
    } else if (sort === 'price_desc') {
      orderBy = { price: 'desc' };
    } else if (sort === 'rating') {
      orderBy = { rating: 'desc' };
    } else if (sort === 'latest') {
      orderBy = { createdAt: 'desc' };
    } else if (sort === 'price') {
      orderBy = { price: params.sortOrder || 'asc' };
    }

    const findArgs: any = {
      where,
      take: sort === 'relevance' && rawQuery.length > 0 ? limit * 3 : limit, // Fetch candidate pool for relevance reranking
      orderBy,
      include: {
        store: { select: { id: true, name: true, logo: true, isVerified: true } },
        category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
        brand: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        inventory: { select: { quantity: true } },
        ratingSummary: true,
      },
    };

    if (params.cursor && sort !== 'relevance') {
      findArgs.cursor = { id: params.cursor };
      findArgs.skip = 1;
    } else if (sort !== 'relevance') {
      findArgs.skip = skip;
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany(findArgs),
    ]);

    // Asynchronously log search activity for analytics & trending calculation
    if (rawQuery.length > 0 && page === 1 && !params.cursor) {
      prisma.searchQueryLog.create({
        data: {
          query: rawQuery,
          normalizedQuery,
          userId: params.userId || null,
          resultCount: total,
          isVisual: false,
          hasResults: total > 0,
        },
      }).catch(err => {
        console.warn('[SearchService] Error logging search query:', err);
      });
    }

    // Relevance Reranking when sort is 'relevance' and query is provided
    let rankedProducts = products;
    if (sort === 'relevance' && rawQuery.length > 0) {
      const scoredList = products.map(p => {
        const { score, relevanceGrade } = this.calculateRelevanceScore(
          p,
          rawQuery,
          normalizedQuery,
          searchTokens,
          typoInfo.correctedQuery
        );
        return { product: p, score, relevanceGrade };
      });

      scoredList.sort((a, b) => b.score - a.score);

      const startIndex = (page - 1) * limit;
      const paginatedList = scoredList.slice(startIndex, startIndex + limit);

      rankedProducts = paginatedList.map(item => {
        const prod = item.product;
        (prod as any)._relevanceScore = item.score;
        (prod as any)._relevanceGrade = item.relevanceGrade;
        return prod;
      });
    }

    const nextCursor =
      rankedProducts.length >= limit ? rankedProducts[rankedProducts.length - 1].id : null;

    let clientProducts = await formatProductsWithCampaigns(rankedProducts, params.locale || 'ar');
    if (params.inStock) {
      clientProducts = clientProducts.filter((p: any) => (p.stock || 0) > 0);
    }

    return {
      products: clientProducts,
      total: params.inStock ? clientProducts.length : total,
      page,
      limit,
      nextCursor,
      queryCorrection: typoInfo.hasCorrection
        ? {
            originalQuery: rawQuery,
            correctedQuery: typoInfo.correctedQuery,
            hasCorrection: true,
          }
        : undefined,
    };
  }

  /**
   * Fast, multi-source autocomplete suggestions with ranking and Redis caching.
   */
  async getSuggestions(query: string, userId?: string): Promise<SuggestionItem[]> {
    const raw = (query || '').trim();
    if (raw.length === 0) return [];

    const normalized = normalizeArabic(raw);
    const cacheKey = `search:suggestions:${normalized}`;

    // Try Redis cache
    const cached = await redis.getJson<SuggestionItem[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    const suggestions: SuggestionItem[] = [];
    const seenTexts = new Set<string>();

    const addSuggestion = (item: SuggestionItem) => {
      const lower = item.text.trim().toLowerCase();
      if (!seenTexts.has(lower) && lower.length > 0) {
        seenTexts.add(lower);
        suggestions.push(item);
      }
    };

    // 1. User's Recent Searches (if user is authenticated)
    if (userId) {
      const userHistory = await prisma.searchHistory.findMany({
        where: {
          userId,
          query: { contains: raw, mode: 'insensitive' },
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      });

      for (const h of userHistory) {
        addSuggestion({ text: h.query, type: 'RECENT' });
      }
    }

    // 2. Typo-corrected suggestion if user typed a misspelling
    const catalogVocab = await this.getCatalogVocabulary();
    const typoInfo = findTypoCorrections(raw, catalogVocab);
    if (typoInfo.hasCorrection && typoInfo.correctedQuery !== normalized) {
      addSuggestion({
        text: typoInfo.correctedQuery,
        type: 'KEYWORD',
        metadata: { isTypoCorrection: true, original: raw },
      });
    }

    // 3. Matching Brands
    const brands = await prisma.brand.findMany({
      where: {
        isActive: true,
        OR: [
          { nameAr: { contains: raw, mode: 'insensitive' } },
          { nameEn: { contains: raw, mode: 'insensitive' } },
        ],
      },
      select: { id: true, nameAr: true, nameEn: true, slug: true },
      take: 2,
    });

    for (const b of brands) {
      const brandText = b.nameAr || b.nameEn;
      addSuggestion({
        text: brandText,
        type: 'BRAND',
        id: b.id,
        metadata: { slug: b.slug },
      });
    }

    // 4. Matching Categories
    const categories = await prisma.category.findMany({
      where: {
        isActive: true,
        OR: [
          { nameAr: { contains: raw, mode: 'insensitive' } },
          { nameEn: { contains: raw, mode: 'insensitive' } },
        ],
      },
      select: { id: true, nameAr: true, nameEn: true, slug: true },
      take: 2,
    });

    for (const c of categories) {
      const catText = c.nameAr || c.nameEn;
      addSuggestion({
        text: catText,
        type: 'CATEGORY',
        id: c.id,
        metadata: { slug: c.slug },
      });
    }

    // 5. Matching Product Names
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        isSuspended: false,
        OR: [
          { nameAr: { contains: raw, mode: 'insensitive' } },
          { nameEn: { contains: raw, mode: 'insensitive' } },
        ],
      },
      select: { id: true, nameAr: true, nameEn: true, price: true, slug: true },
      take: 6,
    });

    for (const p of products) {
      const pText = p.nameAr || p.nameEn;
      addSuggestion({
        text: pText,
        type: 'PRODUCT',
        id: p.id,
        metadata: { price: p.price, slug: p.slug },
      });
    }

    // 6. Vocabulary & Brand Prefix Matching
    const combinedVocab = [...CANONICAL_VOCABULARY, ...catalogVocab];
    for (const word of combinedVocab) {
      const normWord = normalizeArabic(word);
      if (normWord.startsWith(normalized) || isTypoMatch(normalized, normWord)) {
        addSuggestion({ text: word, type: 'KEYWORD' });
        if (suggestions.length >= 10) break;
      }
    }

    // 7. Aliases & Popular Keywords
    const tokensWithAliases = getSearchTokensWithAliases(raw, catalogVocab);
    for (const token of tokensWithAliases) {
      if (token !== raw && token.length >= 2) {
        addSuggestion({ text: token, type: 'KEYWORD' });
      }
    }

    const finalSuggestions = suggestions.slice(0, 10);

    // Cache in Redis for 10 minutes
    await redis.setJson(cacheKey, finalSuggestions, 600);

    return finalSuggestions;
  }

  /**
   * Computes marketplace-wide trending searches from SearchQueryLog.
   * Window: 24h default, configurable up to 7 days.
   */
  async getTrendingSearches(windowHours = 24): Promise<string[]> {
    const cacheKey = `search:trending:${windowHours}`;
    const cached = await redis.getJson<string[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    const sinceDate = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const logs = await prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: {
        createdAt: { gte: sinceDate },
        hasResults: true,
        isVisual: false,
        query: { not: '' },
        NOT: [
          { query: { contains: '.png', mode: 'insensitive' } },
          { query: { contains: '.jpg', mode: 'insensitive' } },
          { query: { contains: '.jpeg', mode: 'insensitive' } },
          { query: { contains: '.webp', mode: 'insensitive' } },
          { query: { contains: 'scaled_', mode: 'insensitive' } },
          { query: { contains: 'media_', mode: 'insensitive' } },
          { query: { contains: 'img_', mode: 'insensitive' } },
        ],
      },
      _count: {
        id: true,
        userId: true,
      },
      orderBy: {
        _count: {
          id: 'desc',
        },
      },
      take: 15,
    });

    const isGarbageQuery = (q: string) => {
      const lower = q.toLowerCase().trim();
      return (
        lower.length <= 2 ||
        /\.(png|jpg|jpeg|webp|gif|svg|bmp)$/i.test(lower) ||
        lower.startsWith('scaled_') ||
        lower.startsWith('media_') ||
        lower.startsWith('img_') ||
        lower.startsWith('photo_') ||
        lower.includes('sticker')
      );
    };

    let trending = logs
      .map(l => l.normalizedQuery)
      .filter(q => q && !isGarbageQuery(q));

    // Fallback to top bestselling product names if search logs are sparse
    if (trending.length < 5) {
      const topProducts = await prisma.product.findMany({
        where: { isActive: true },
        orderBy: [{ soldCount: 'desc' }, { rating: 'desc' }],
        select: { nameAr: true, nameEn: true },
        take: 10,
      });

      for (const p of topProducts) {
        const title = p.nameAr || p.nameEn;
        if (title && !trending.includes(title) && !isGarbageQuery(title)) {
          trending.push(title);
        }
      }
    }

    trending = trending.slice(0, 10);

    // Cache for 15 minutes
    await redis.setJson(cacheKey, trending, 900);

    return trending;
  }

  /**
   * Popular long-term keywords from catalog and historical patterns.
   */
  async getPopularKeywords(): Promise<string[]> {
    const cacheKey = 'search:popular:keywords';
    const cached = await redis.getJson<string[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: [{ isFeatured: 'desc' }, { soldCount: 'desc' }, { createdAt: 'desc' }],
      select: { nameAr: true, nameEn: true },
      take: 10,
    });

    const popular = products
      .map(p => p.nameAr || p.nameEn)
      .filter(Boolean)
      .slice(0, 8);

    await redis.setJson(cacheKey, popular, 1800); // 30 minutes
    return popular;
  }

  /**
   * Get search history for authenticated user.
   */
  async getRecentSearches(userId: string): Promise<string[]> {
    const records = await prisma.searchHistory.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { query: true },
    });

    return records.map(r => r.query);
  }

  /**
   * Add search history entry (idempotent, caps at 50 entries).
   */
  async addRecentSearch(userId: string, query: string): Promise<void> {
    const clean = query.trim();
    if (clean.length === 0) return;

    await prisma.searchHistory.upsert({
      where: {
        userId_query: { userId, query: clean },
      },
      update: {
        updatedAt: new Date(),
      },
      create: {
        userId,
        query: clean,
      },
    });

    // Enforce 50 limit: if more than 50, delete oldest
    const count = await prisma.searchHistory.count({ where: { userId } });
    if (count > 50) {
      const oldest = await prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { updatedAt: 'asc' },
        take: count - 50,
        select: { id: true },
      });

      if (oldest.length > 0) {
        await prisma.searchHistory.deleteMany({
          where: { id: { in: oldest.map(o => o.id) } },
        });
      }
    }
  }

  /**
   * Delete an individual search history entry for a user.
   */
  async deleteRecentSearch(userId: string, query: string): Promise<void> {
    await prisma.searchHistory.deleteMany({
      where: { userId, query: query.trim() },
    });
  }

  /**
   * Clear all search history for a user.
   */
  async clearRecentSearches(userId: string): Promise<void> {
    await prisma.searchHistory.deleteMany({
      where: { userId },
    });
  }

  /**
   * Administrative report of top searches resulting in zero results.
   */
  async getZeroResultSearches(limit = 20) {
    const zeroResults = await prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: { hasResults: false, query: { not: '' } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    });

    return zeroResults.map(zr => ({
      query: zr.normalizedQuery,
      count: zr._count.id,
    }));
  }
}

export const searchService = new SearchService();
