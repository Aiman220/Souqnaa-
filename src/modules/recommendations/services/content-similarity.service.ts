import { prisma } from '../../../database/prisma';
import { redisService } from '../../../database/redis';

export class ContentSimilarityService {
  /**
   * Tokenize text into normalized lowercase tokens for TF-IDF / bag of words comparison.
   */
  private tokenize(text: string): string[] {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s\u0600-\u06FF]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  /**
   * Calculate cosine similarity between two word frequency maps.
   */
  private calculateCosineSimilarity(vecA: Map<string, number>, vecB: Map<string, number>): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, freqA] of vecA.entries()) {
      normA += freqA * freqA;
      const freqB = vecB.get(term) || 0;
      dotProduct += freqA * freqB;
    }

    for (const freqB of vecB.values()) {
      normB += freqB * freqB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Calculate content-based similarity score between two products.
   * Multi-signal:
   * - Category match (0.35)
   * - Brand match (0.20)
   * - Price similarity (0.15)
   * - Text similarity (title/description) (0.20)
   * - Attribute overlap (0.10)
   */
  computeProductSimilarityScore(p1: any, p2: any): {
    totalScore: number;
    categoryScore: number;
    brandScore: number;
    priceScore: number;
    textScore: number;
  } {
    // 1. Category Similarity (0.35)
    let categoryScore = 0;
    if (p1.categoryId && p2.categoryId && p1.categoryId === p2.categoryId) {
      categoryScore = 1.0;
    }

    // 2. Brand Similarity (0.20)
    let brandScore = 0;
    if (p1.brandId && p2.brandId && p1.brandId === p2.brandId) {
      brandScore = 1.0;
    }

    // 3. Price Similarity (0.15)
    const maxPrice = Math.max(p1.price, p2.price);
    const priceDiff = Math.abs(p1.price - p2.price);
    const priceScore = maxPrice > 0 ? Math.max(0, 1 - priceDiff / maxPrice) : 1;

    // 4. Text Similarity (0.20)
    const text1 = `${p1.nameEn || ''} ${p1.nameAr || ''} ${p1.descriptionEn || ''} ${p1.descriptionAr || ''}`;
    const text2 = `${p2.nameEn || ''} ${p2.nameAr || ''} ${p2.descriptionEn || ''} ${p2.descriptionAr || ''}`;
    const tokens1 = this.tokenize(text1);
    const tokens2 = this.tokenize(text2);

    const freq1 = new Map<string, number>();
    tokens1.forEach((t) => freq1.set(t, (freq1.get(t) || 0) + 1));
    const freq2 = new Map<string, number>();
    tokens2.forEach((t) => freq2.set(t, (freq2.get(t) || 0) + 1));

    const textScore = this.calculateCosineSimilarity(freq1, freq2);

    // Weighted composite score
    const totalScore =
      categoryScore * 0.35 +
      brandScore * 0.20 +
      priceScore * 0.15 +
      textScore * 0.20 +
      (p1.storeId === p2.storeId ? 0.10 : 0.0);

    return {
      totalScore: Math.min(1.0, totalScore),
      categoryScore,
      brandScore,
      priceScore,
      textScore,
    };
  }

  /**
   * Find similar products for a given productId.
   * Excludes: current product, out of stock, deleted, blocked.
   */
  async getSimilarProducts(productId: string, limit = 20): Promise<any[]> {
    const cacheKey = `recommendations:product:similar:${productId}:${limit}`;
    const cached = await redisService.getJson<any[]>(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
    }

    // First check precomputed ProductSimilarity table
    const precomputed = await prisma.productSimilarity.findMany({
      where: {
        productId,
        similarProduct: {
          isActive: true,
          isSuspended: false,
          inventory: { quantity: { gt: 0 } },
        },
      },
      include: {
        similarProduct: {
          include: {
            store: true,
            category: true,
            images: true,
            inventory: true,
            ratingSummary: true,
          },
        },
      },
      orderBy: { similarityScore: 'desc' },
      take: limit,
    });

    if (precomputed.length >= Math.min(limit, 5)) {
      const results = precomputed.map((p) => ({
        ...p.similarProduct,
        similarityScore: p.similarityScore,
        explanation: {
          reason: 'Similar to item you viewed',
          reasonAr: 'منتج مشابه لما شاهدته',
          sourceType: 'CONTENT_SIMILARITY',
        },
      }));
      await redisService.setJson(cacheKey, results, 86400); // 24 hours
      return results;
    }

    // Dynamic on-demand calculation from catalog
    const targetProduct = await prisma.product.findUnique({
      where: { id: productId },
      include: { attributes: true },
    });

    if (!targetProduct) return [];

    // Candidate selection: fetch products from same category or same brand
    const orConditions: any[] = [{ categoryId: targetProduct.categoryId }];
    if (targetProduct.brandId) {
      orConditions.push({ brandId: targetProduct.brandId });
    }

    const candidates = await prisma.product.findMany({
      where: {
        id: { not: productId },
        isActive: true,
        isSuspended: false,
        inventory: { quantity: { gt: 0 } },
        OR: orConditions,
      },
      include: {
        store: true,
        category: true,
        images: true,
        inventory: true,
        ratingSummary: true,
      },
      take: 60,
    });

    const scored = candidates
      .map((cand) => {
        const sim = this.computeProductSimilarityScore(targetProduct, cand);
        return {
          ...cand,
          similarityScore: sim.totalScore,
          explanation: {
            reason: 'Similar to item you viewed',
            reasonAr: 'منتج مشابه لما شاهدته',
            sourceType: 'CONTENT_SIMILARITY',
          },
        };
      })
      .filter((c) => c.similarityScore > 0.15)
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, limit);

    await redisService.setJson(cacheKey, scored, 3600); // 1 hour
    return scored;
  }
}

export const contentSimilarityService = new ContentSimilarityService();
