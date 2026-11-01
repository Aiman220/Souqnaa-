/**
 * Admin Inter-Governorate Routes & Logistics API
 *
 * Provides full administrative management of inter-governorate routes,
 * road-distance pricing, tiers, methods, hubs, pickup points, and monitoring KPIs.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { interGovernorateRouteService } from '../../services/delivery/inter-governorate-route.service';
import { interGovernorateTrackingService } from '../../services/delivery/inter-governorate-tracking.service';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// 1. Inter-Governorate Routes CRUD
// ──────────────────────────────────────────────────────────────────────────────

/** GET /routes — List routes with search and filters */
router.get('/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { originAreaId, destinationAreaId, isActive, search } = req.query;
    const routes = await interGovernorateRouteService.listRoutes({
      originAreaId: originAreaId ? String(originAreaId) : undefined,
      destinationAreaId: destinationAreaId ? String(destinationAreaId) : undefined,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      search: search ? String(search) : undefined,
    });
    ResponseUtil.success(res, routes);
  } catch (error) {
    next(error);
  }
});

/** POST /seed-routes — Seed default routes for the 9 approved Yemeni governorates */
router.post('/seed-routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await interGovernorateRouteService.seedDefaultRoutes();
    const routes = await interGovernorateRouteService.listRoutes();
    ResponseUtil.created(res, routes, 'تم تهيئة مسارات المحافظات الافتراضية بنجاح (المسارات معطلة افتراضياً بانتظار الاعتماد)');
  } catch (error) {
    next(error);
  }
});

/** GET /routes/:id — Route details with methods and audit log */
router.get('/routes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const route = await prisma.interGovernorateRoute.findUnique({
      where: { id },
      include: {
        routeMethods: true,
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!route) throw new AppError('المسار غير موجود', 404);
    ResponseUtil.success(res, route);
  } catch (error) {
    next(error);
  }
});

/** POST /routes — Create route with validation */
router.post('/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const route = await interGovernorateRouteService.createRoute(req.body, req.user?.userId, ipAddress);
    ResponseUtil.created(res, route, 'تم إنشاء المسار بنجاح');
  } catch (error) {
    next(error);
  }
});

/** PUT /routes/:id — Update route pricing and configuration */
router.put('/routes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const ipAddress = req.ip || req.socket.remoteAddress;
    const updated = await interGovernorateRouteService.updateRoute(id, req.body, req.user?.userId, ipAddress);
    ResponseUtil.success(res, updated, 'تم تحديث تسعيرة وإعدادات المسار بنجاح');
  } catch (error) {
    next(error);
  }
});

/** PATCH /routes/:id/toggle — Toggle route active state with pre-validation */
router.patch('/routes/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') throw new AppError('حالة التفعيل isActive مطلوبة (true/false)', 400);

    const ipAddress = req.ip || req.socket.remoteAddress;
    const updated = await interGovernorateRouteService.toggleRouteActive(id, isActive, req.user?.userId, ipAddress);
    ResponseUtil.success(res, updated, `تم ${isActive ? 'تفعيل' : 'تعطيل'} المسار بنجاح`);
  } catch (error) {
    next(error);
  }
});

/** DELETE /routes/:id — Soft-delete / deactivate route */
router.delete('/routes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const ipAddress = req.ip || req.socket.remoteAddress;
    await interGovernorateRouteService.toggleRouteActive(id, false, req.user?.userId, ipAddress);
    ResponseUtil.success(res, null, 'تم إيقاف تفعيل المسار بنجاح');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Logistics Hubs & Pickup Points CRUD
// ──────────────────────────────────────────────────────────────────────────────

/** GET /hubs — List hubs and pickup points */
router.get('/hubs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { areaId, isPickupPoint } = req.query;
    const hubs = await interGovernorateTrackingService.listHubs({
      areaId: areaId ? String(areaId) : undefined,
      isPickupPoint: isPickupPoint !== undefined ? isPickupPoint === 'true' : undefined,
    });
    ResponseUtil.success(res, hubs);
  } catch (error) {
    next(error);
  }
});

/** POST /hubs — Create a transit hub or pickup point */
router.post('/hubs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hub = await interGovernorateTrackingService.createHub(req.body);
    ResponseUtil.created(res, hub, 'تم إنشاء مركز التوزيع / نقطة الاستلام بنجاح');
  } catch (error) {
    next(error);
  }
});

/** PUT /hubs/:id — Update hub */
router.put('/hubs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const hub = await prisma.interGovernorateHub.update({
      where: { id },
      data: req.body,
    });
    ResponseUtil.success(res, hub, 'تم تحديث المركز بنجاح');
  } catch (error) {
    next(error);
  }
});

/** DELETE /hubs/:id — Deactivate hub */
router.delete('/hubs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.interGovernorateHub.update({
      where: { id },
      data: { isActive: false },
    });
    ResponseUtil.success(res, null, 'تم إلغاء تفعيل المركز بنجاح');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Analytics & Logistics KPIs
// ──────────────────────────────────────────────────────────────────────────────

/** GET /analytics — Comprehensive inter-governorate logistics KPIs */
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const analytics = await interGovernorateRouteService.getLogisticsAnalytics();
    ResponseUtil.success(res, analytics);
  } catch (error) {
    next(error);
  }
});

export const adminInterGovernorateRoutes = router;

