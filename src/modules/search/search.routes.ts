import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { ResponseUtil } from '../../utils/response.util';
import { optionalAuth, authenticate, authorize } from '../../middleware/auth.middleware';
import { searchService } from './search.service';
import { visualSearchService } from './visual/visual-search.service';
import { catalogVisualIndexService } from './visual/catalog-visual-index.service';
import { validateImageBuffer } from './visual/image-hasher.util';
import { AppError } from '../../middleware/error.middleware';
import { searchLimiter } from '../../middleware/rate-limiter.middleware';

const router = Router();

// Multer configured for visual search images (max 10MB, memory buffer)
const visualUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files (JPEG, PNG, WebP) are supported for visual search', 400));
    }
  },
});

// Stricter rate limiter specifically for visual search to protect computation & storage
const visualSearchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 visual searches per minute per IP
  message: {
    success: false,
    message: 'Too many visual search requests. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── 1. Full Catalog Search ──────────────────────────────────────────────────
// GET /api/v1/search — Full catalog search with dynamic filters, typo-tolerance & relevance ranking
router.get('/', searchLimiter, optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const {
      q,
      categoryId,
      brandId,
      minPrice,
      maxPrice,
      inStock,
      sortBy = 'relevance',
      sortOrder = 'desc',
      cursor,
    } = req.query;

    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const result = await searchService.search({
      q: q ? String(q) : undefined,
      categoryId: categoryId ? String(categoryId) : undefined,
      brandId: brandId ? String(brandId) : undefined,
      minPrice: minPrice ? parseFloat(String(minPrice)) : undefined,
      maxPrice: maxPrice ? parseFloat(String(maxPrice)) : undefined,
      inStock: inStock === 'true',
      sortBy: String(sortBy),
      sortOrder: (sortOrder as any) || 'desc',
      page,
      limit,
      cursor: cursor ? String(cursor) : undefined,
      userId: req.user?.userId,
      locale,
    });

    ResponseUtil.paginated(
      res,
      result.products,
      result.total,
      result.page,
      result.limit,
      undefined,
      result.nextCursor,
      result.queryCorrection
    );
  } catch (error) {
    next(error);
  }
});

// ── 2. Autocomplete Suggestions ─────────────────────────────────────────────
// GET /api/v1/search/suggestions — Instant multi-type typed suggestions
router.get('/suggestions', searchLimiter, optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    if (!q || String(q).trim().length === 0) {
      return ResponseUtil.success(res, []);
    }

    const suggestions = await searchService.getSuggestions(
      String(q),
      req.user?.userId
    );

    ResponseUtil.success(res, suggestions);
  } catch (error) {
    next(error);
  }
});

// ── 3. Trending Searches ────────────────────────────────────────────────────
// GET /api/v1/search/trending — Marketplace trending terms
router.get('/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hours = parseInt(String(req.query.windowHours || '24'), 10);
    const trending = await searchService.getTrendingSearches(hours);
    ResponseUtil.success(res, trending);
  } catch (error) {
    next(error);
  }
});

// ── 4. Popular Keywords ─────────────────────────────────────────────────────
// GET /api/v1/search/popular — Popular phrases from catalog
router.get('/popular', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const popular = await searchService.getPopularKeywords();
    ResponseUtil.success(res, popular);
  } catch (error) {
    next(error);
  }
});

// ── 5. User Search History ──────────────────────────────────────────────────
// GET /api/v1/search/history — Get authenticated customer's search history
router.get('/history', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await searchService.getRecentSearches(req.user!.userId);
    ResponseUtil.success(res, history);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/search/history — Add search history entry (idempotent, called on submit)
router.post('/history', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query } = req.body;
    if (!query || String(query).trim().length === 0) {
      throw new AppError('Search query is required', 400);
    }

    await searchService.addRecentSearch(req.user!.userId, String(query));
    ResponseUtil.success(res, { synced: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/search/history/:query — Delete single search history entry
router.delete('/history/:query', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await searchService.deleteRecentSearch(req.user!.userId, String(req.params.query));
    ResponseUtil.success(res, { deleted: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/search/history — Clear all search history for authenticated customer
router.delete('/history', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await searchService.clearRecentSearches(req.user!.userId);
    ResponseUtil.success(res, { cleared: true });
  } catch (error) {
    next(error);
  }
});

// ── 6. Visual Search ────────────────────────────────────────────────────────
// POST /api/v1/search/visual — Visual search using uploaded image + optional text/filters
router.post(
  '/visual',
  visualSearchLimiter,
  optionalAuth,
  visualUpload.single('image'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      const { textQuery, categoryId, minPrice, maxPrice, inStock, limit } = req.body;

      if (!file && (!textQuery || String(textQuery).trim().length === 0)) {
        throw new AppError('An image or text description is required for visual search', 400);
      }

      // Validate magic bytes to prevent MIME spoofing
      if (file) {
        const validation = validateImageBuffer(file.buffer);
        if (!validation.isValid) {
          throw new AppError(validation.error || 'Invalid or malformed image file', 400);
        }
      }

      const visualResult = await visualSearchService.executeVisualSearch(file, {
        textQuery: textQuery ? String(textQuery).trim() : undefined,
        categoryId: categoryId ? String(categoryId) : undefined,
        minPrice: minPrice ? parseFloat(String(minPrice)) : undefined,
        maxPrice: maxPrice ? parseFloat(String(maxPrice)) : undefined,
        inStock: inStock === 'true' || inStock === true,
        userId: req.user?.userId,
        limit: limit ? parseInt(String(limit), 10) : 24,
      });

      ResponseUtil.success(res, visualResult);
    } catch (error) {
      next(error);
    }
  }
);

// ── 7. Admin Diagnostics & Tools ────────────────────────────────────────────
// GET /api/v1/search/analytics/zero-results — Top zero result queries
router.get(
  '/analytics/zero-results',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(String(req.query.limit || '20'), 10);
      const results = await searchService.getZeroResultSearches(limit);
      ResponseUtil.success(res, results);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/v1/search/admin/status — Visual index status & diagnostics
router.get(
  '/admin/status',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = visualSearchService.getIndexingStatus();
      ResponseUtil.success(res, status);
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/search/admin/reindex — Trigger asynchronous reindexing
router.post(
  '/admin/reindex',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Run reindex non-blocking in background
      visualSearchService.triggerReindex(true).catch(err => {
        console.error('[SearchRoutes] Background reindex error:', err);
      });

      ResponseUtil.success(res, {
        message: 'Visual indexing started in background',
        status: visualSearchService.getIndexingStatus(),
      });
    } catch (error) {
      next(error);
    }
  }
);

export const searchRoutes = router;
