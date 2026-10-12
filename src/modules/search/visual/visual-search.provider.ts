import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { formatProductsForClient } from '../../../utils/product-formatter.util';
import { normalizeArabic, getSearchTokensWithAliases } from '../utils/arabic-normalizer.util';
import { catalogVisualIndexService } from './catalog-visual-index.service';
import { VisualFeatureVector } from './image-hasher.util';

export interface VisualSearchContext {
  buffer?: Buffer;
  mimetype?: string;
  filename?: string;
  publicUrl?: string;
  textQuery?: string;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  limit?: number;
}

export interface VisualSearchResult {
  queryId: string;
  provider: string;
  detectedTags: string[];
  detectedCategory?: { id: string; nameAr: string; nameEn: string; slug: string };
  suggestedCategories: Array<{ id: string; nameAr: string; nameEn: string; slug: string; count: number }>;
  bestMatch?: any | null;
  similarProducts: any[];
  products: any[];
  metadata: Record<string, any>;
}

export interface IVisualSearchProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  search(context: VisualSearchContext): Promise<VisualSearchResult>;
}

/**
 * Production-ready Real Visual Search Provider.
 * 
 * Directly matches uploaded photos against real product images stored in Cloudflare R2
 * storage and the PostgreSQL catalog database using perceptual hash (dHash) & color similarity.
 * Labels matches honestly into Exact Matches ('أفضل تطابق') and Similar Products ('منتجات مشابهة').
 */
export class RuleBasedVisualSearchProvider implements IVisualSearchProvider {
  readonly name = 'RuleBasedVisualSearchProvider';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(context: VisualSearchContext): Promise<VisualSearchResult> {
    const queryId = `vs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const limit = context.limit || 24;

    const detectedTags: string[] = [];
    let detectedCategory: { id: string; nameAr: string; nameEn: string; slug: string } | undefined;
    let queryFeatures: VisualFeatureVector | undefined;
    let visualMatches: Array<{
      productId: string;
      score: number;
      distance: number;
      isExactMatch: boolean;
      matchType: 'EXACT' | 'SIMILAR' | 'RELATED';
    }> = [];

    // 1. Real Visual Image Matching against Storage
    if (context.buffer && context.buffer.length > 0) {
      const visualResult = await catalogVisualIndexService.findVisuallySimilarProducts(
        context.buffer,
        {
          categoryId: context.categoryId,
          limit,
        }
      );
      visualMatches = visualResult.matches;
      queryFeatures = visualResult.queryFeatures;
    }

    // 2. Extract hints from customer text query if provided
    if (context.textQuery && context.textQuery.trim().length > 0) {
      const textHints = getSearchTokensWithAliases(context.textQuery.trim());
      for (const h of textHints) {
        if (!detectedTags.includes(h)) {
          detectedTags.push(h);
        }
      }
    }

    // 3. Resolve category if provided or detected (cached in Redis to avoid DB roundtrips)
    let allCategories: Array<{ id: string; nameAr: string; nameEn: string; slug: string }> | null = null;
    try {
      allCategories = await redis.getJson<Array<{ id: string; nameAr: string; nameEn: string; slug: string }>>('search:categories:active');
    } catch (_) {}

    if (!allCategories) {
      allCategories = await prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, nameAr: true, nameEn: true, slug: true },
      });
      redis.setJson('search:categories:active', allCategories, 900).catch(() => {});
    }

    if (context.categoryId && allCategories) {
      detectedCategory = allCategories.find(c => c.id === context.categoryId);
    }

    // 4. Retrieve matching products from database based on real visual ranking
    let products: any[] = [];
    const matchMetadataMap = new Map<string, { isExactMatch: boolean; matchType: string; score: number; distance: number }>();

    for (const m of visualMatches) {
      matchMetadataMap.set(m.productId, {
        isExactMatch: m.isExactMatch,
        matchType: m.matchType,
        score: m.score,
        distance: m.distance,
      });
    }

    if (visualMatches.length > 0) {
      const matchedIds = visualMatches.map(m => m.productId);

      const where: any = {
        id: { in: matchedIds },
        isActive: true,
        isSuspended: false,
      };

      if (context.minPrice || context.maxPrice) {
        where.price = {};
        if (context.minPrice) where.price.gte = context.minPrice;
        if (context.maxPrice) where.price.lte = context.maxPrice;
      }

      if (context.inStock) {
        where.OR = [
          { inventory: { quantity: { gt: 0 } } },
          { variants: { some: { stockQuantity: { gt: 0 } } } },
        ];
      }

      if (detectedCategory) {
        where.categoryId = detectedCategory.id;
      }

      const fetchedProducts = await prisma.product.findMany({
        where,
        include: {
          store: { select: { id: true, name: true, logo: true, isVerified: true } },
          category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          variants: true,
          inventory: { select: { quantity: true } },
          ratingSummary: true,
        },
      });

      // Preserve exact visual similarity rank order
      const productMap = new Map(fetchedProducts.map(p => [p.id, p]));
      for (const m of visualMatches) {
        const prod = productMap.get(m.productId);
        if (prod) {
          products.push(prod);
        }
      }
    }

    // 5. If visual matches are fewer than requested limit, fill with catalog items
    if (products.length < limit) {
      const existingIds = products.map(p => p.id);
      const fallbackWhere: any = {
        isActive: true,
        isSuspended: false,
        id: { notIn: existingIds },
      };

      if (detectedCategory) {
        fallbackWhere.categoryId = detectedCategory.id;
      }

      if (detectedTags.length > 0) {
        fallbackWhere.OR = detectedTags.map(tag => ({
          OR: [
            { nameAr: { contains: tag, mode: 'insensitive' } },
            { nameEn: { contains: tag, mode: 'insensitive' } },
            { descriptionAr: { contains: tag, mode: 'insensitive' } },
            { descriptionEn: { contains: tag, mode: 'insensitive' } },
          ],
        }));
      }

      const moreProducts = await prisma.product.findMany({
        where: fallbackWhere,
        take: limit - products.length,
        orderBy: [{ isFeatured: 'desc' }, { soldCount: 'desc' }],
        include: {
          store: { select: { id: true, name: true, logo: true, isVerified: true } },
          category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          variants: true,
          inventory: { select: { quantity: true } },
          ratingSummary: true,
        },
      });

      products = [...products, ...moreProducts];
    }

    // 6. Aggregate category chips
    const categoryCounts = new Map<string, { cat: any; count: number }>();
    for (const p of products) {
      if (p.category) {
        const existing = categoryCounts.get(p.category.id);
        if (existing) {
          existing.count++;
        } else {
          categoryCounts.set(p.category.id, { cat: p.category, count: 1 });
        }
      }
    }

    const suggestedCategories = Array.from(categoryCounts.values())
      .map(entry => ({
        id: entry.cat.id,
        nameAr: entry.cat.nameAr,
        nameEn: entry.cat.nameEn,
        slug: entry.cat.slug,
        count: entry.count,
      }))
      .slice(0, 5);

    // Format for client
    const formattedProducts = formatProductsForClient(products);

    // Attach visual match classification metadata
    let bestMatch: any | null = null;
    const similarProducts: any[] = [];

    formattedProducts.forEach((fp: any, idx: number) => {
      const matchMeta = matchMetadataMap.get(fp.id);
      if (matchMeta) {
        fp.visualMatchType = matchMeta.matchType;
        fp.isExactMatch = matchMeta.isExactMatch;
        fp.visualScore = matchMeta.score;
        fp.visualDistance = matchMeta.distance;
      } else {
        fp.visualMatchType = 'RELATED';
        fp.isExactMatch = false;
      }

      if (idx === 0 && fp.isExactMatch) {
        bestMatch = fp;
      } else {
        similarProducts.push(fp);
      }
    });

    return {
      queryId,
      provider: this.name,
      detectedTags: Array.from(new Set(detectedTags)),
      detectedCategory,
      suggestedCategories,
      bestMatch,
      similarProducts,
      products: formattedProducts,
      metadata: {
        imageProvided: Boolean(context.buffer || context.publicUrl),
        mimetype: context.mimetype,
        totalMatched: products.length,
        visualMatchesCount: visualMatches.length,
        hasExactMatch: Boolean(bestMatch),
        closestDistance: visualMatches[0]?.distance,
        highestScore: visualMatches[0]?.score,
        dominantColor: queryFeatures?.dominantColor,
      },
    };
  }
}

/**
 * Extensible AI/ML Vision Provider interface ready for vector embedding & multimodal models.
 */
export class AIVisualSearchProvider implements IVisualSearchProvider {
  readonly name = 'AIVisualSearchProvider';

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env.AI_VISION_MODEL_ENDPOINT);
  }

  async search(context: VisualSearchContext): Promise<VisualSearchResult> {
    throw new Error('AI Vision model is not configured. Falling back to RuleBasedVisualSearchProvider.');
  }
}
