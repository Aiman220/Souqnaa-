import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { storageService } from '../../../services/storage/storage.service';
import {
  extractVisualFeatures,
  calculateHammingDistance,
  calculateHammingDistanceHex,
  calculateColorDistance,
  VisualFeatureVector,
} from './image-hasher.util';

export interface ProductVisualIndexEntry {
  productId: string;
  imageUrl: string;
  features: VisualFeatureVector;
}

export interface VisualMatchResult {
  productId: string;
  score: number;
  distance: number;
  matchedImageUrl: string;
  isExactMatch: boolean;
  matchType: 'EXACT' | 'SIMILAR' | 'RELATED';
}

export interface VisualIndexStatus {
  indexedImagesCount: number;
  indexedProductsCount: number;
  isIndexing: boolean;
  lastIndexedAt: number;
  lastIndexedAtIso: string;
  cacheTtlMs: number;
  errorCount: number;
  lastError: string | null;
}

/**
 * Service that indexes real product images directly from Cloudflare R2 storage & catalog URLs,
 * allowing real visual similarity matching with zero mock data.
 * Features are cached in Redis to minimize CPU & bandwidth overhead.
 */
export class CatalogVisualIndexService {
  private index: ProductVisualIndexEntry[] = [];
  private lastIndexedAt = 0;
  private isIndexing = false;
  private errorCount = 0;
  private lastError: string | null = null;
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes in-memory cache

  /**
   * Status reporter for Admin search diagnostics.
   */
  getStatus(): VisualIndexStatus {
    const uniqueProducts = new Set(this.index.map(i => i.productId)).size;
    return {
      indexedImagesCount: this.index.length,
      indexedProductsCount: uniqueProducts,
      isIndexing: this.isIndexing,
      lastIndexedAt: this.lastIndexedAt,
      lastIndexedAtIso: this.lastIndexedAt ? new Date(this.lastIndexedAt).toISOString() : 'Never',
      cacheTtlMs: this.CACHE_TTL_MS,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  /**
   * Helper to fetch an image buffer from R2 storage or external URL.
   */
  private async fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
      // 1. Check if image is stored in Cloudflare R2 storage
      let r2Key: string | null = null;
      if (url.includes('.eu.r2.cloudflarestorage.com/sogana/')) {
        r2Key = url.split('.eu.r2.cloudflarestorage.com/sogana/')[1];
      } else if (url.includes('/storage/file/')) {
        r2Key = url.replace(/^.*\/storage\/file\//, '');
      } else if (url.startsWith('products/')) {
        r2Key = url;
      } else if (url.includes('/products/')) {
        const match = url.match(/products\/([^?#]+)/);
        if (match) r2Key = `products/${match[1]}`;
      }

      if (r2Key) {
        try {
          const fileStreamObj = await storageService.getFileStream(r2Key);
          const chunks: Buffer[] = [];
          for await (const chunk of fileStreamObj.stream) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        } catch (err) {
          // Log only if unexpected
        }
      }

      // 2. External URL - fetch with timeout
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (!url.includes('localhost:4000')) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          if (response.ok) {
            const arrayBuf = await response.arrayBuffer();
            return Buffer.from(arrayBuf);
          }
        }
      }
    } catch (e) {
      // Ignore network timeouts for external URLs
    }
    return null;
  }

  /**
   * Builds or refreshes the visual feature index from real database & storage product images.
   */
  async ensureIndex(forceRefresh = false): Promise<void> {
    const now = Date.now();
    if (!forceRefresh && this.index.length > 0 && now - this.lastIndexedAt < this.CACHE_TTL_MS) {
      return; // Index is fresh
    }

    if (this.isIndexing) {
      return; // Indexing already in progress
    }

    this.isIndexing = true;

    try {
      console.log('[VisualIndex] Refreshing product image visual index from storage and database...');
      const images = await prisma.productImage.findMany({
        where: {
          product: {
            isActive: true,
            isSuspended: false,
          },
        },
        select: {
          productId: true,
          url: true,
        },
      });

      const newIndex: ProductVisualIndexEntry[] = [];

      const batchSize = 8;
      for (let i = 0; i < images.length; i += batchSize) {
        const batch = images.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async img => {
            try {
              // Check Redis cache first for extracted feature vector using full URL SHA-256 hash
              const crypto = await import('crypto');
              const urlHash = crypto.createHash('sha256').update(img.url).digest('hex');
              const redisKey = `search:feat:${urlHash}`;
              let features = await redis.getJson<VisualFeatureVector>(redisKey);

              if (!features) {
                const buffer = await this.fetchImageBuffer(img.url);
                if (buffer && buffer.length > 0) {
                  features = await extractVisualFeatures(buffer);
                  // Cache features in Redis for 7 days
                  await redis.setJson(redisKey, features, 7 * 24 * 3600);
                }
              }

              if (features) {
                newIndex.push({
                  productId: img.productId,
                  imageUrl: img.url,
                  features,
                });
              }
            } catch (e) {
              this.errorCount++;
              this.lastError = (e as any).message;
            }
          })
        );
      }

      this.index = newIndex;
      this.lastIndexedAt = Date.now();
      console.log(`[VisualIndex] Successfully indexed ${newIndex.length} real product images from storage.`);
    } catch (err) {
      this.errorCount++;
      this.lastError = (err as any).message;
      console.error('[VisualIndex] Failed to build visual index:', err);
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Re-indexes a single product's images (called when product images change).
   */
  async indexProduct(productId: string): Promise<void> {
    try {
      const images = await prisma.productImage.findMany({
        where: { productId },
        select: { productId: true, url: true },
      });

      // Remove existing entries for this product
      this.index = this.index.filter(e => e.productId !== productId);

      for (const img of images) {
        const buffer = await this.fetchImageBuffer(img.url);
        if (buffer && buffer.length > 0) {
          const features = await extractVisualFeatures(buffer);
          this.index.push({
            productId: img.productId,
            imageUrl: img.url,
            features,
          });
          const crypto = await import('crypto');
          const urlHash = crypto.createHash('sha256').update(img.url).digest('hex');
          const redisKey = `search:feat:${urlHash}`;
          await redis.setJson(redisKey, features, 7 * 24 * 3600);
        }
      }
    } catch (err) {
      console.warn(`[VisualIndex] Failed to reindex product ${productId}:`, err);
    }
  }

  /**
   * Removes a deleted product from the visual index.
   */
  removeProduct(productId: string): void {
    this.index = this.index.filter(e => e.productId !== productId);
  }

  /**
   * Compares the uploaded query image against real catalog images in storage.
   * Returns ranked product matches sorted by visual similarity score,
   * with honest labeling of exact vs similar matches.
   */
  async findVisuallySimilarProducts(
    queryBuffer: Buffer,
    options?: {
      categoryId?: string;
      limit?: number;
    }
  ): Promise<{ matches: VisualMatchResult[]; queryFeatures: VisualFeatureVector }> {
    await this.ensureIndex();

    const queryFeatures = await extractVisualFeatures(queryBuffer);
    const limit = options?.limit || 24;

    const scoredProducts = new Map<string, VisualMatchResult>();

    for (const entry of this.index) {
      // 1. Calculate 64-bit Hamming distance between difference hashes (0 - 64)
      const dist64 = calculateHammingDistance(queryFeatures.dHash, entry.features.dHash);

      // Fast early pruning: If 64-bit structural difference is > 26 (more than ~40% bit flips),
      // candidate is visually dissimilar. Skip expensive 256-bit HD & Euclidean color calculations.
      if (dist64 > 26) {
        continue;
      }

      // 2. Compute base structural score and match type
      let score = 0;
      let isExact = false;
      let matchType: 'EXACT' | 'SIMILAR' | 'RELATED' = 'RELATED';

      // 3. Calculate Color distance (0 - 441.6) only for prospective candidates
      const fullColorDist = calculateColorDistance(
        { avgR: queryFeatures.avgR, avgG: queryFeatures.avgG, avgB: queryFeatures.avgB },
        { avgR: entry.features.avgR, avgG: entry.features.avgG, avgB: entry.features.avgB }
      );

      const fgColorDist = calculateColorDistance(
        { avgR: queryFeatures.fgAvgR, avgG: queryFeatures.fgAvgG, avgB: queryFeatures.fgAvgB },
        { avgR: entry.features.fgAvgR, avgG: entry.features.fgAvgG, avgB: entry.features.fgAvgB }
      );

      if (dist64 === 0 && fullColorDist < 30) {
        // IDENTICAL VISUAL HASH MATCH!
        score += 10000;
        isExact = true;
        matchType = 'EXACT';
      } else if (dist64 <= 3 && fgColorDist < 40) {
        // Near identical (compression / crop / format variation)
        score += 5000 + (3 - dist64) * 600;
        isExact = dist64 <= 1;
        matchType = isExact ? 'EXACT' : 'SIMILAR';
      } else if (dist64 <= 10) {
        // Strong visual resemblance
        score += 2000 + (10 - dist64) * 200;
        matchType = 'SIMILAR';
      } else if (dist64 <= 18) {
        // Moderate structural match
        score += 800 + (18 - dist64) * 80;
        matchType = 'RELATED';
      } else {
        // Weak structural similarity
        score += Math.max(0, (32 - dist64) * 15);
        matchType = 'RELATED';
      }

      // 4. Calculate high-definition 256-bit hash bonus (up to 1000 pts) for close matches
      if (dist64 <= 18 && queryFeatures.dHash256 && entry.features.dHash256) {
        const dist256 = calculateHammingDistanceHex(
          queryFeatures.dHash256,
          entry.features.dHash256
        );
        const normDist256 = dist256 >> 2; // integer divide by 4 (0-64 scale)
        if (normDist256 <= 10) {
          score += (10 - normDist256) * 100;
        }
      }

      // Add Foreground Object Color bonus (up to 500 pts)
      if (fgColorDist < 60) {
        score += Math.round((60 - fgColorDist) * 8);
      }

      // Add Full Image Color bonus (up to 300 pts)
      if (fullColorDist < 60) {
        score += Math.round((60 - fullColorDist) * 5);
      }

      // Dominant color category match bonus
      if (
        queryFeatures.dominantColor !== 'other' &&
        queryFeatures.dominantColor === entry.features.dominantColor
      ) {
        score += 250;
      }

      // Aspect ratio penalty if vastly different
      const arDiff = Math.abs(queryFeatures.aspectRatio - entry.features.aspectRatio);
      if (arDiff > 0.5) {
        score = Math.max(0, score - Math.round(arDiff * 50));
      }

      const existing = scoredProducts.get(entry.productId);
      if (!existing || score > existing.score) {
        scoredProducts.set(entry.productId, {
          productId: entry.productId,
          score,
          distance: dist64,
          matchedImageUrl: entry.imageUrl,
          isExactMatch: isExact,
          matchType,
        });
      }
    }

    // Sort by score descending (highest visual similarity first)
    const sorted = Array.from(scoredProducts.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { matches: sorted, queryFeatures };
  }
}

export const catalogVisualIndexService = new CatalogVisualIndexService();
