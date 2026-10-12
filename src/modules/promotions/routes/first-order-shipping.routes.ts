/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative API Routes
 * Version: 1.0.0
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, optionalAuth } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { FirstOrderShippingConfigService } from '../services/first-order-shipping-config.service';
import { FirstOrderFreeShippingEligibilityService } from '../services/first-order-eligibility.service';
import { FirstOrderPromotionReservationService } from '../services/first-order-reservation.service';
import { FirstOrderAnalyticsService } from '../services/first-order-analytics.service';
import { FirstOrderEligibilityStatus } from '../first-order-shipping.types';

const router = Router();

// ==============================================================================
// 1. ELIGIBILITY API (GET /api/v1/promotions/first-order-free-shipping/eligibility)
// Informational preview for client app. Checkout recalculates authoritatively.
// ==============================================================================
router.get(
  '/first-order-free-shipping/eligibility',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await FirstOrderShippingConfigService.getConfig();

      // If user is not authenticated yet, return public campaign status and requirements
      if (!req.user?.userId) {
        return ResponseUtil.success(res, {
          eligible: false,
          status: config.enabled ? FirstOrderEligibilityStatus.ELIGIBLE : FirstOrderEligibilityStatus.CAMPAIGN_DISABLED,
          messageAr: config.enabled ? 'سجل دخولك لمعرفة مدى أهليتك للحصول على شحن مجاني' : 'العرض غير متاح حالياً',
          messageEn: config.enabled ? 'Log in to check your free shipping eligibility' : 'Promotion currently unavailable',
          minOrderAmount: config.minOrderAmount,
          maxDiscount: config.maxDiscount,
          costBearer: config.costBearer,
          requiresAuth: true,
        });
      }

      const cartSubtotal = req.query.cartSubtotal ? parseFloat(req.query.cartSubtotal as string) : 0;
      const deliveryMethod = req.query.deliveryMethod as string | undefined;
      const deliveryZoneId = req.query.deliveryZoneId as string | undefined;
      const deliveryZoneName = req.query.deliveryZoneName as string | undefined;
      const sellerIds = req.query.sellerIds
        ? (Array.isArray(req.query.sellerIds)
            ? (req.query.sellerIds as string[]).map(String)
            : [String(req.query.sellerIds)])
        : undefined;

      const eligibility = await FirstOrderFreeShippingEligibilityService.evaluateEligibility({
        customerId: req.user.userId,
        cartSubtotal,
        deliveryMethod,
        deliveryZoneId,
        deliveryZoneName,
        sellerIds,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        deviceId: (req.headers['x-device-id'] as string) || undefined,
      });

      return ResponseUtil.success(res, eligibility);
    } catch (err) {
      next(err);
    }
  }
);

// ==============================================================================
// 2. CONFIGURATION RETRIEVAL (GET /api/v1/promotions/first-order-free-shipping/config)
// ==============================================================================
router.get(
  '/first-order-free-shipping/config',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await FirstOrderShippingConfigService.getConfig();
      return ResponseUtil.success(res, config);
    } catch (err) {
      next(err);
    }
  }
);

// ==============================================================================
// 3. ADMIN CONFIGURATION UPDATE (PUT /api/v1/promotions/first-order-free-shipping/config)
// Elevated RBAC: ADMIN only. Requires explicit reason for immutable audit trail.
// ==============================================================================
router.put(
  '/first-order-free-shipping/config',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason, updates } = req.body;
      if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
        throw new AppError('سبب التعديل إلزامي ويجب أن يوضح الغرض من التغيير الإداري', 400);
      }

      const updatedConfig = await FirstOrderShippingConfigService.updateConfig({
        actorId: req.user!.userId,
        reason,
        updates: updates || req.body,
      });

      return ResponseUtil.success(res, updatedConfig, 'تم تحديث إعدادات الشحن المجاني بنجاح');
    } catch (err) {
      next(err);
    }
  }
);

// ==============================================================================
// 4. ADMIN DASHBOARD METRICS (GET /api/v1/promotions/first-order-free-shipping/dashboard)
// High-performance aggregated metrics & analytics
// ==============================================================================
router.get(
  '/first-order-free-shipping/dashboard',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const metrics = await FirstOrderAnalyticsService.getDashboardMetrics();
      return ResponseUtil.success(res, metrics);
    } catch (err) {
      next(err);
    }
  }
);

// ==============================================================================
// 5. ADMIN USAGE RESTORATION (POST /api/v1/promotions/first-order-free-shipping/restore)
// Exceptional customer restoration with audit logging
// ==============================================================================
router.post(
  '/first-order-free-shipping/restore',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { usageId, reason } = req.body;
      if (!usageId) {
        throw new AppError('معرف سجل الاستخدام إلزامي', 400);
      }
      if (!reason || reason.trim().length < 5) {
        throw new AppError('سبب إعادة منح العرض إلزامي ومطلوب للتوثيق المالي', 400);
      }

      const restored = await FirstOrderPromotionReservationService.restorePromotionUsage({
        actorId: req.user!.userId,
        usageId,
        reason,
      });

      return ResponseUtil.success(res, restored, 'تمت إعادة أهلية العرض للعميل بنجاح وتوثيق العملية في سجل التدقيق');
    } catch (err) {
      next(err);
    }
  }
);

export default router;
