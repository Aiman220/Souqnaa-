import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
import { requireSeller, requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { SellerPerformanceService } from './seller-performance.service';
import { SellerPerformanceConfigService } from './seller-performance.config';
import { PerformanceGrade, PerformanceDataStatus } from './seller-performance.types';

// ============================================================================
// 1. PUBLIC / CUSTOMER-FACING ROUTES
// ============================================================================
export const publicSellerPerformanceRouter = Router();

/**
 * GET /api/v1/sellers/:sellerId/performance
 * Public, sanitized seller performance summary for customers in storefront / store details.
 */
publicSellerPerformanceRouter.get(
  '/:sellerId/performance',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const publicData = await SellerPerformanceService.getPublicSellerPerformance(sellerId);
      ResponseUtil.success(res, publicData);
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// 2. SELLER-FACING ROUTES (Seller App)
// ============================================================================
export const sellerPerformanceRouter = Router();
sellerPerformanceRouter.use(authenticate, requireSeller);

/**
 * Helper to get the authenticated seller record.
 */
async function resolveCurrentSeller(userId: string) {
  const seller = await prisma.seller.findUnique({
    where: { userId },
  });
  if (!seller) {
    throw new AppError('حساب التاجر غير موجود', 404);
  }
  return seller;
}

/**
 * GET /api/v1/seller/me/performance or /api/v1/sellers/me/performance
 * Returns detailed performance scorecard for the logged-in seller.
 */
sellerPerformanceRouter.get('/performance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await resolveCurrentSeller(req.user!.userId);
    const performance = await SellerPerformanceService.getSellerPerformance(seller.id);
    ResponseUtil.success(res, performance);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/seller/me/performance/history
 * Returns historical snapshots for trend tracking in Seller App.
 */
sellerPerformanceRouter.get('/performance/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await resolveCurrentSeller(req.user!.userId);
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const history = await SellerPerformanceService.getSellerPerformanceHistory(seller.id, limit);
    ResponseUtil.success(res, history);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 3. ADMIN ROUTES (Admin Portal)
// ============================================================================
export const adminSellerPerformanceRouter = Router();
adminSellerPerformanceRouter.use(authenticate, requireAdmin);

/**
 * GET /api/v1/admin/sellers/performance
 * List all sellers with performance scores, grades, and filters.
 */
adminSellerPerformanceRouter.get(
  '/sellers/performance',
  requirePermission('sellers:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        grade,
        dataStatus,
        search,
        sortBy,
        sortOrder,
        page = '1',
        limit = '25',
      } = req.query as Record<string, string>;

      const result = await SellerPerformanceService.listSellerPerformances({
        grade: grade as PerformanceGrade,
        dataStatus: dataStatus as PerformanceDataStatus,
        search,
        sortBy: sortBy as any,
        sortOrder: (sortOrder === 'asc' ? 'asc' : 'desc') as any,
        page: Math.max(1, parseInt(page, 10)),
        limit: Math.max(1, Math.min(100, parseInt(limit, 10))),
      });

      ResponseUtil.paginated(res, result.items, result.total, result.page, result.limit);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/admin/sellers/:sellerId/performance
 * Full authoritative performance audit for a specific seller.
 */
adminSellerPerformanceRouter.get(
  '/sellers/:sellerId/performance',
  requirePermission('sellers:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const [performance, history] = await Promise.all([
        SellerPerformanceService.getSellerPerformance(sellerId),
        SellerPerformanceService.getSellerPerformanceHistory(sellerId, 30),
      ]);

      ResponseUtil.success(res, {
        performance,
        history,
        ...performance,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/admin/sellers/:sellerId/performance/recalculate
 * Manually trigger authoritative backend recalculation with audit logging.
 */
adminSellerPerformanceRouter.post(
  '/sellers/:sellerId/performance/recalculate',
  requirePermission('seller_performance:recalculate'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const { reason = 'Admin manual verification' } = req.body || {};
      const adminUserId = req.user!.userId;

      const updated = await SellerPerformanceService.recalculateManual(sellerId, adminUserId, reason);
      ResponseUtil.success(res, updated, 'تمت إعادة احتساب مؤشرات أداء المتجر بنجاح');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/admin/seller-performance/config
 * View current performance engine weights & SLA configuration.
 */
adminSellerPerformanceRouter.get(
  '/seller-performance/config',
  requirePermission('settings:manage'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await SellerPerformanceConfigService.getConfig();
      ResponseUtil.success(res, config);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/v1/admin/seller-performance/config
 * Update performance engine weights & thresholds with validation.
 */
adminSellerPerformanceRouter.put(
  '/seller-performance/config',
  requirePermission('seller_performance:manage_config'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await SellerPerformanceConfigService.updateConfig(req.body);
      ResponseUtil.success(res, updated, 'تم تحديث إعدادات محرك أداء التجار بنجاح');
    } catch (err) {
      next(err);
    }
  }
);
