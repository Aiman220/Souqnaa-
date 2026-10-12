import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { WishlistService } from './wishlist.service';

const router = Router();
router.use(authenticate);

/**
 * GET /api/v1/wishlist — Paginated customer wishlist with filters, sorting, and dynamic badges
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const cursor = (req.query.cursor as string) || undefined;
    const filter = (req.query.filter as any) || 'all';
    const sortBy = (req.query.sortBy as any) || 'recent';

    const wishlist = await WishlistService.getWishlist(req.user!.userId, {
      page,
      limit,
      cursor,
      filter,
      sortBy,
    });

    ResponseUtil.success(res, wishlist);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/wishlist/count — Lightweight item count for navigation and badges
 */
router.get('/count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await WishlistService.getWishlistCount(req.user!.userId);
    ResponseUtil.success(res, { count });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/wishlist/alerts — Customer's wishlist alerts history (Price drops, restocks, flash sales)
 */
router.get('/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alerts = await WishlistService.getCustomerWishlistAlerts(req.user!.userId);
    ResponseUtil.success(res, { alerts });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/evaluate-alerts — Trigger instant evaluation for price drops, stock, and flash sales
 */
router.post('/evaluate-alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const priceResult = await WishlistService.evaluatePriceDrops();
    const stockResult = await WishlistService.evaluateStockAlerts();
    const flashSaleResult = await WishlistService.evaluateFlashSaleExpiringAlerts();

    ResponseUtil.success(
      res,
      {
        priceDrops: priceResult,
        stockAlerts: stockResult,
        flashSaleAlerts: flashSaleResult,
      },
      'تم تقييم وفحص تنبيهات المفضلة بنجاح'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/check — Check membership for a single product
 */
router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, variantId } = req.body;
    const isWishlisted = await WishlistService.isWishlisted(
      req.user!.userId,
      String(productId),
      variantId ? String(variantId) : undefined
    );
    ResponseUtil.success(res, { isWishlisted });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/check-many — Bulk check membership for product grids
 */
router.post('/check-many', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds)) {
      return ResponseUtil.badRequest(res, 'قائمة معرفات المنتجات productIds مطلوبة');
    }
    const membership = await WishlistService.checkManyWishlist(req.user!.userId, productIds);
    ResponseUtil.success(res, { membership });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/toggle — Authoritative toggle endpoint
 */
router.post('/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, variantId } = req.body;
    if (!productId) {
      return ResponseUtil.badRequest(res, 'معرف المنتج مطلوب');
    }

    const result = await WishlistService.toggleItem(req.user!.userId, {
      productId: String(productId),
      variantId: variantId ? String(variantId) : null,
    });

    ResponseUtil.success(
      res,
      result,
      result.wishlisted ? 'تمت الإضافة للمفضلة' : 'تمت الإزالة من المفضلة'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/move-all-to-cart — Move all eligible in-stock items to cart
 */
router.post('/move-all-to-cart', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await WishlistService.moveAllToCart(req.user!.userId);
    ResponseUtil.success(
      res,
      summary,
      `تم نقل ${summary.moved.length} منتج إلى سلة التسوق بنجاح`
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/items — Add product to wishlist
 */
router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.body.productId);
    const variantId = req.body.variantId ? String(req.body.variantId) : null;
    const alertPreferences = req.body.alertPreferences;

    if (!productId || productId === 'undefined') {
      return ResponseUtil.badRequest(res, 'معرف المنتج مطلوب (Product ID is required)');
    }

    const item = await WishlistService.addItem(req.user!.userId, {
      productId,
      variantId,
      alertPreferences,
    });

    ResponseUtil.created(res, item, 'تمت إضافة المنتج إلى المفضلة بنجاح ❤️');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/items/:id/move-to-cart — Move single item to cart atomically
 */
router.post('/items/:id/move-to-cart', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const itemId = String(req.params.id);
    const quantity = req.body.quantity ? parseInt(String(req.body.quantity), 10) : 1;
    const result = await WishlistService.moveToCart(req.user!.userId, itemId, quantity);
    ResponseUtil.success(res, result, 'تم نقل المنتج بنجاح إلى سلة التسوق 🛒');
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/v1/wishlist/items/:id/alerts — Update item alert preferences
 */
router.patch('/items/:id/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const itemId = String(req.params.id);
    const { priceDropAlertEnabled, backInStockAlertEnabled } = req.body;

    const item = await WishlistService.updateAlertPreferences(req.user!.userId, itemId, {
      priceDropAlertEnabled,
      backInStockAlertEnabled,
    });

    ResponseUtil.success(res, item, 'تم تحديث تفضيلات التنبيهات بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/wishlist/items/:id — Remove item by wishlist item ID
 */
router.delete('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const itemId = String(req.params.id);
    await WishlistService.removeItem(req.user!.userId, itemId);
    ResponseUtil.success(res, null, 'تمت إزالة المنتج من المفضلة');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/wishlist/:productId — Direct add by product ID (Fallback)
 */
router.post('/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.productId);
    const variantId = req.body.variantId ? String(req.body.variantId) : null;
    const alertPreferences = req.body.alertPreferences;

    if (!productId || productId === 'undefined') {
      return ResponseUtil.badRequest(res, 'معرف المنتج مطلوب (Product ID is required)');
    }

    const item = await WishlistService.addItem(req.user!.userId, {
      productId,
      variantId,
      alertPreferences,
    });

    ResponseUtil.created(res, item, 'تمت إضافة المنتج إلى المفضلة بنجاح ❤️');
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/wishlist/:productId — Direct delete by product ID or item ID (Fallback)
 */
router.delete('/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idOrProductId = String(req.params.productId);
    await WishlistService.removeItem(req.user!.userId, idOrProductId);
    ResponseUtil.success(res, null, 'تمت إزالة المنتج من المفضلة');
  } catch (error) {
    next(error);
  }
});

export const wishlistRoutes = router;
