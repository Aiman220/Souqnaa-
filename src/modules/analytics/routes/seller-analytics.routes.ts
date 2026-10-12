import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../../middleware/auth.middleware';
import { requireSeller } from '../../../middleware/rbac.middleware';
import { AnalyticsAccessService } from '../services/analytics-access.service';
import { SellerAnalyticsService } from '../services/seller-analytics.service';
import { AnalyticsAuditService } from '../services/analytics-audit.service';
import { ResponseUtil } from '../../../utils/response.util';
import { AnalyticsPeriod } from '../types/analytics.types';

export const sellerAnalyticsRouter = Router();

sellerAnalyticsRouter.use(authenticate, requireSeller);

// Helper to extract and validate period and dates
function parseParams(req: Request) {
  const period = (req.query.period as AnalyticsPeriod) || '30d';
  const from = req.query.from ? String(req.query.from) : (req.query.startDate ? String(req.query.startDate) : undefined);
  const to = req.query.to ? String(req.query.to) : (req.query.endDate ? String(req.query.endDate) : undefined);
  return { period, from, to };
}

// 1. GET /seller/analytics/overview
sellerAnalyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getOverview(sellerId, period, from, to);

    await AnalyticsAuditService.log({
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      sellerId,
      action: 'ANALYTICS_VIEWED',
      resource: 'SELLER_OVERVIEW',
      filters: { period, from, to },
    });

    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 2. GET /seller/analytics/sales
sellerAnalyticsRouter.get('/sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getSales(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 3. GET /seller/analytics/orders
sellerAnalyticsRouter.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getOrders(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 4. GET /seller/analytics/products
sellerAnalyticsRouter.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);
    const sortBy = (req.query.sortBy as any) || 'revenue';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;

    const result = await SellerAnalyticsService.getProducts(sellerId, period, from, to, sortBy, limit);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 5. GET /seller/analytics/inventory
sellerAnalyticsRouter.get('/inventory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getInventory(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 6. GET /seller/analytics/customers
sellerAnalyticsRouter.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getCustomers(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 7. GET /seller/analytics/promotions
sellerAnalyticsRouter.get('/promotions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getPromotions(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 8. GET /seller/analytics/commission
sellerAnalyticsRouter.get('/commission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getCommission(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 9. GET /seller/analytics/settlements
sellerAnalyticsRouter.get('/settlements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getSettlements(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 10. GET /seller/analytics/tax
sellerAnalyticsRouter.get('/tax', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getTax(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 11. GET /seller/analytics/insights
sellerAnalyticsRouter.get('/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);

    const result = await SellerAnalyticsService.getInsights(sellerId, period, from, to);
    ResponseUtil.success(res, result);
  } catch (err) {
    next(err);
  }
});

// 12. GET /seller/analytics/export
sellerAnalyticsRouter.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await AnalyticsAccessService.resolveAuthorizedSellerId(req.user!.userId);
    const { period, from, to } = parseParams(req);
    const format = (req.query.format as 'csv' | 'html') || 'csv';
    const type = (req.query.type as 'sales' | 'products' | 'inventory' | 'financials') || 'sales';

    const content = await SellerAnalyticsService.exportReport(sellerId, format, period, from, to, type);

    await AnalyticsAuditService.log({
      actorId: req.user!.userId,
      actorRole: 'SELLER',
      sellerId,
      action: 'ANALYTICS_EXPORTED',
      resource: 'SELLER_EXPORT',
      filters: { period, from, to, format, type },
    });

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(content);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="souqna_seller_${type}_${period}.csv"`);
    return res.send(content);
  } catch (err) {
    next(err);
  }
});
