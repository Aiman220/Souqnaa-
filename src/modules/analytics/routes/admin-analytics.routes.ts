import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../../middleware/auth.middleware';
import { requireAdmin } from '../../../middleware/rbac.middleware';
import { AdminAnalyticsService } from '../services/admin-analytics.service';
import { AnalyticsAuditService } from '../services/analytics-audit.service';
import { DataQualityService } from '../services/data-quality.service';
import { ResponseUtil } from '../../../utils/response.util';
import { AnalyticsPeriod } from '../types/analytics.types';
import { cartAbandonmentService } from '../../cart/abandonment/cart-abandonment.service';

export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.use(authenticate, requireAdmin);

function parseParams(req: Request) {
  const period = (req.query.period as AnalyticsPeriod) || '30d';
  const from = req.query.from ? String(req.query.from) : (req.query.startDate ? String(req.query.startDate) : undefined);
  const to = req.query.to ? String(req.query.to) : (req.query.endDate ? String(req.query.endDate) : undefined);
  return { period, from, to };
}

// 1. GET /admin/analytics/overview (and / for aliases)
adminAnalyticsRouter.get(['/', '/overview'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getOverview(period, from, to);

    await AnalyticsAuditService.log({
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: 'ANALYTICS_VIEWED',
      resource: 'ADMIN_MARKETPLACE_OVERVIEW',
      filters: { period, from, to },
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 2. GET /admin/analytics/sales
adminAnalyticsRouter.get('/sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getSales(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 3. GET /admin/analytics/orders
adminAnalyticsRouter.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getOrders(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 4. GET /admin/analytics/sellers
adminAnalyticsRouter.get('/sellers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const sortBy = (req.query.sortBy as any) || 'sales';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;

    const result = await AdminAnalyticsService.getSellers(period, from, to, sortBy, limit);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 5. GET /admin/analytics/products
adminAnalyticsRouter.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const sortBy = (req.query.sortBy as any) || 'revenue';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;

    const result = await AdminAnalyticsService.getProducts(period, from, to, sortBy, limit);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 6. GET /admin/analytics/categories
adminAnalyticsRouter.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getCategories(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 7. GET /admin/analytics/customers
adminAnalyticsRouter.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getCustomers(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 8. GET /admin/analytics/inventory
adminAnalyticsRouter.get('/inventory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getInventory(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 9. GET /admin/analytics/promotions
adminAnalyticsRouter.get('/promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getPromotions(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 10. GET /admin/analytics/commission
adminAnalyticsRouter.get('/commission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getCommission(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 11. GET /admin/analytics/settlements
adminAnalyticsRouter.get('/settlements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getSettlements(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 12. GET /admin/analytics/tax
adminAnalyticsRouter.get('/tax', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getTax(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 13. GET /admin/analytics/delivery
adminAnalyticsRouter.get('/delivery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getDelivery(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 14. GET /admin/analytics/anomalies
adminAnalyticsRouter.get('/anomalies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await AdminAnalyticsService.getAnomalies(period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 15. GET /admin/analytics/quality
adminAnalyticsRouter.get('/quality', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DataQualityService.runQualityAudit();
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 16. GET /admin/analytics/export
adminAnalyticsRouter.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const format = (req.query.format as 'csv' | 'html') || 'csv';
    const type = (req.query.type as 'sales' | 'commission' | 'leaderboard') || 'sales';

    const content = await AdminAnalyticsService.exportReport(format, period, from, to, type);

    await AnalyticsAuditService.log({
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: 'ANALYTICS_EXPORTED',
      resource: 'ADMIN_MARKETPLACE_EXPORT',
      filters: { period, from, to, format, type },
    });

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(content);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="souqna_${type}_report_${period}.csv"`);
    return res.send(content);
  } catch (err) {
    next(err);
  }
});

// 17. GET /admin/analytics/cart-recovery (Cart Recovery Reporting & Analytics)
adminAnalyticsRouter.get('/cart-recovery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period, from, to } = parseParams(req);
    const result = await cartAbandonmentService.getAdminCartRecoveryMetrics(period, from, to);

    await AnalyticsAuditService.log({
      actorId: req.user!.userId,
      actorRole: 'ADMIN',
      action: 'ANALYTICS_VIEWED',
      resource: 'ADMIN_CART_RECOVERY_ANALYTICS',
      filters: { period, from, to },
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});
