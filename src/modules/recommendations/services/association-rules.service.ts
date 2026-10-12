import { prisma } from '../../../database/prisma';
import { redisService } from '../../../database/redis';

export class AssociationRulesService {
  /**
   * Calculate and persist frequently-bought-together associations from order history.
   */
  async computeMarketplaceAssociations(): Promise<{ totalPairsComputed: number }> {
    // 1. Fetch completed or valid orders with order items
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
      },
      select: {
        id: true,
        sellerOrders: {
          select: {
            items: {
              select: { productId: true },
            },
          },
        },
      },
      take: 10000,
    });

    const totalOrders = orders.length;
    if (totalOrders === 0) return { totalPairsComputed: 0 };

    const productOrderCounts = new Map<string, number>();
    const coOccurrenceCounts = new Map<string, number>(); // key: `${pA}:${pB}`

    for (const order of orders) {
      const productSet = new Set<string>();
      for (const so of order.sellerOrders) {
        for (const it of so.items) {
          if (it.productId) productSet.add(it.productId);
        }
      }

      const products = Array.from(productSet);
      for (const p of products) {
        productOrderCounts.set(p, (productOrderCounts.get(p) || 0) + 1);
      }

      // Compute pairwise co-occurrences
      for (let i = 0; i < products.length; i++) {
        for (let j = 0; j < products.length; j++) {
          if (i !== j) {
            const pairKey = `${products[i]}:${products[j]}`;
            coOccurrenceCounts.set(pairKey, (coOccurrenceCounts.get(pairKey) || 0) + 1);
          }
        }
      }
    }

    let pairsInserted = 0;

    for (const [pairKey, count] of coOccurrenceCounts.entries()) {
      if (count < 1) continue; // Min 1 co-purchase

      const [pA, pB] = pairKey.split(':');
      const countA = productOrderCounts.get(pA) || 1;
      const countB = productOrderCounts.get(pB) || 1;

      const supportAB = count / totalOrders;
      const supportB = countB / totalOrders;
      const confidence = count / countA;
      const lift = supportB > 0 ? confidence / supportB : 1.0;

      // Association score combining confidence and log-dampened count
      const score = confidence * Math.log10(count + 9);

      await prisma.productAssociation.upsert({
        where: {
          productId_relatedProductId: {
            productId: pA,
            relatedProductId: pB,
          },
        },
        create: {
          productId: pA,
          relatedProductId: pB,
          score,
          purchaseCount: count,
          confidence,
          lift,
        },
        update: {
          score,
          purchaseCount: count,
          confidence,
          lift,
        },
      });

      pairsInserted++;
    }

    return { totalPairsComputed: pairsInserted };
  }

  /**
   * Get Frequently Bought Together recommendations for a given product.
   */
  async getFrequentlyBoughtTogether(productId: string, limit = 5): Promise<any[]> {
    const cacheKey = `recommendations:product:fbt:${productId}:${limit}`;
    const cached = await redisService.getJson<any[]>(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
    }

    const associations = await prisma.productAssociation.findMany({
      where: {
        productId,
        relatedProduct: {
          isActive: true,
          isSuspended: false,
          inventory: { quantity: { gt: 0 } },
        },
      },
      include: {
        relatedProduct: {
          include: {
            store: true,
            category: true,
            images: true,
            inventory: true,
            ratingSummary: true,
          },
        },
      },
      orderBy: { score: 'desc' },
      take: limit,
    });

    if (associations.length > 0) {
      const results = associations.map((a) => ({
        ...a.relatedProduct,
        fbtScore: a.score,
        confidence: a.confidence,
        explanation: {
          reason: 'Frequently bought together with this product',
          reasonAr: 'غالباً ما يتم شراؤه معاً',
          sourceType: 'FREQUENTLY_BOUGHT_TOGETHER',
        },
      }));
      await redisService.setJson(cacheKey, results, 86400);
      return results;
    }

    // Fallback: If no direct co-occurrence, return complementary items from same category / accessories
    const target = await prisma.product.findUnique({
      where: { id: productId },
      select: { categoryId: true, storeId: true, price: true },
    });

    if (!target) return [];

    const fallbacks = await prisma.product.findMany({
      where: {
        id: { not: productId },
        categoryId: target.categoryId,
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
      take: limit,
    });

    const results = fallbacks.map((f) => ({
      ...f,
      fbtScore: 0.5,
      explanation: {
        reason: 'Customers who viewed this also bought',
        reasonAr: 'العملاء الذين شاهدوا هذا اشتروا أيضاً',
        sourceType: 'COMPLEMENTARY_FALLBACK',
      },
    }));

    await redisService.setJson(cacheKey, results, 3600);
    return results;
  }
}

export const associationRulesService = new AssociationRulesService();
