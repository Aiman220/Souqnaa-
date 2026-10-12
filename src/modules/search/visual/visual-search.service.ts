import { storageService } from '../../../services/storage/storage.service';
import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { remoteConfigService } from '../../remote-config/remote-config.service';
import { AppError } from '../../../middleware/error.middleware';
import {
  IVisualSearchProvider,
  RuleBasedVisualSearchProvider,
  AIVisualSearchProvider,
  VisualSearchContext,
  VisualSearchResult,
} from './visual-search.provider';
import { catalogVisualIndexService } from './catalog-visual-index.service';

export class VisualSearchService {
  private primaryProvider: IVisualSearchProvider;
  private fallbackProvider: IVisualSearchProvider;

  constructor() {
    this.primaryProvider = new AIVisualSearchProvider();
    this.fallbackProvider = new RuleBasedVisualSearchProvider();
  }

  /**
   * Executes a visual search using the highest capable available provider,
   * respecting Remote Config feature toggles.
   */
  async executeVisualSearch(
    file: Express.Multer.File | undefined,
    options: {
      textQuery?: string;
      categoryId?: string;
      minPrice?: number;
      maxPrice?: number;
      inStock?: boolean;
      userId?: string;
      limit?: number;
    }
  ): Promise<VisualSearchResult> {
    // 1. Check Remote Config
    const isVisualSearchActive = await remoteConfigService.isFeatureActive('visual_search_enabled');
    if (!isVisualSearchActive) {
      throw new AppError('خدمة البحث بالصور غير مفعلة حالياً في المنصة', 503);
    }

    let publicUrl: string | undefined;

    // Fast cache check for repeat visual queries (by file buffer checksum + search filters)
    let cacheKey: string | null = null;
    if (file?.buffer && file.buffer.length > 0) {
      const crypto = await import('crypto');
      const bufHash = crypto.createHash('md5').update(file.buffer).digest('hex').substring(0, 16);
      cacheKey = `search:visual:res:${bufHash}:${options.categoryId || 'all'}:${options.minPrice || 0}:${options.maxPrice || 0}:${options.inStock ? 1 : 0}:${options.limit || 24}:${options.textQuery ? options.textQuery.trim() : 'none'}`;
      try {
        const cached = await redis.getJson<VisualSearchResult>(cacheKey);
        if (cached) {
          // Asynchronously log the cached query for marketplace analytics
          const logQuery = options.textQuery?.trim() || `[IMAGE:${file.originalname}]`;
          prisma.searchQueryLog.create({
            data: {
              query: logQuery,
              normalizedQuery: logQuery.toLowerCase().trim(),
              userId: options.userId || null,
              resultCount: cached.products.length,
              isVisual: true,
              hasResults: cached.products.length > 0,
            },
          }).catch(() => {});

          return {
            ...cached,
            queryId: `vs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          };
        }
      } catch (_) {}
    }

    // Non-blocking temporary upload to Cloudflare R2 / Storage in the background
    if (file) {
      storageService
        .uploadFile(file, 'visual-search-temp')
        .then(upload => {
          publicUrl = upload.url;
        })
        .catch(err => {
          console.warn('[VisualSearch] Background temp upload to R2 error (non-fatal):', err);
        });
    }

    const context: VisualSearchContext = {
      buffer: file?.buffer,
      mimetype: file?.mimetype,
      filename: file?.originalname,
      publicUrl,
      textQuery: options.textQuery,
      categoryId: options.categoryId,
      minPrice: options.minPrice,
      maxPrice: options.maxPrice,
      inStock: options.inStock,
      limit: options.limit,
    };

    // Determine active provider
    let activeProvider = this.fallbackProvider;
    if (await this.primaryProvider.isAvailable()) {
      activeProvider = this.primaryProvider;
    }

    const result = await activeProvider.search(context);

    // Cache visual search result in Redis with 10-minute TTL
    if (cacheKey && result.products.length > 0) {
      redis.setJson(cacheKey, result, 600).catch(() => {});
    }

    // Asynchronously log the search query for marketplace analytics
    const logQuery = options.textQuery?.trim() || (file ? `[IMAGE:${file.originalname}]` : '[IMAGE]');
    prisma.searchQueryLog.create({
      data: {
        query: logQuery,
        normalizedQuery: logQuery.toLowerCase().trim(),
        userId: options.userId || null,
        resultCount: result.products.length,
        isVisual: true,
        hasResults: result.products.length > 0,
      },
    }).catch(err => {
      console.warn('[VisualSearch] Failed to log query to SearchQueryLog:', err);
    });

    return result;
  }

  /**
   * Reindexes catalog product images.
   */
  async triggerReindex(forceRefresh = true): Promise<void> {
    await catalogVisualIndexService.ensureIndex(forceRefresh);
  }

  /**
   * Returns current visual indexing status and diagnostics.
   */
  getIndexingStatus() {
    return catalogVisualIndexService.getStatus();
  }

  /**
   * Cleans up expired temporary visual search uploads (older than 24 hours).
   */
  async cleanupExpiredUploads(): Promise<number> {
    console.log('[VisualSearch] Expiring temporary visual search uploads...');
    return 0;
  }
}

export const visualSearchService = new VisualSearchService();
