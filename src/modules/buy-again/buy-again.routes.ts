import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { BuyAgainService } from './buy-again.service';

const router = Router();

// ==============================================================================
// 1. GET /api/v1/buy-again — Paginated Customer Buy Again List
// ==============================================================================
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = parseInt(String(req.query.limit), 10) || 20;
    const sortBy = req.query.sortBy === 'frequent' ? 'frequent' : 'recent';
    const search = req.query.search ? String(req.query.search) : undefined;

    const result = await BuyAgainService.getBuyAgainItems(req.user!.userId, {
      page,
      limit,
      sortBy,
      search,
    });

    ResponseUtil.success(res, result, 'تم استرجاع قائمة إعادة الشراء بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 2. GET /api/v1/buy-again/summary — Quick Home Screen Summary & Preview
// ==============================================================================
router.get('/summary', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await BuyAgainService.getBuyAgainSummary(req.user!.userId);
    ResponseUtil.success(res, summary, 'ملخص إعادة الشراء');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3. POST /api/v1/buy-again/add-to-cart — One-Tap Authoritative Reorder
// ==============================================================================
router.post('/add-to-cart', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, variantId, quantity = 1 } = req.body;
    const result = await BuyAgainService.validateAndAddToCart(req.user!.userId, {
      productId,
      variantId,
      quantity,
    });

    ResponseUtil.success(res, result, result.messageAr);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 4. POST /api/v1/buy-again/reorder-order/:orderId — Reorder Historical Order
// ==============================================================================
router.post('/reorder-order/:orderId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = String(req.params.orderId);
    const result = await BuyAgainService.reorderEntireOrder(
      req.user!.userId,
      orderId
    );

    ResponseUtil.success(res, result, 'تمت معالجة إعادة طلب الشحنة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 5. GET /api/v1/buy-again/admin/analytics — Admin Buy Again Analytics
// ==============================================================================
router.get('/admin/analytics', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const metrics = await BuyAgainService.getAdminMetrics();
    ResponseUtil.success(res, metrics, 'إحصائيات محرك إعادة الشراء');
  } catch (error) {
    next(error);
  }
});

export const buyAgainRoutes = router;
