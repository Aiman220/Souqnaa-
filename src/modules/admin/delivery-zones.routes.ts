/**
 * Admin Delivery Management Routes
 *
 * §22: Admin can manage distance zones, pricing, rules, discounts, methods, and settings.
 * §23: Zone table with full CRUD.
 * §26: Admin API endpoints.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { config } from '../../config';

const router = Router();
// Note: authenticate + requireAdmin is applied by the parent admin.routes.ts

// ──────────────────────────────────────────────────────────────────────────────
// Distance-Based Delivery Pricing Zones CRUD
// Mounted on /api/v1/admin/delivery/pricing-zones (and aliases)
// ──────────────────────────────────────────────────────────────────────────────

/** GET pricing zones */
const getPricingZonesHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await prisma.deliveryZonePricing.findMany({
      orderBy: { priority: 'asc' },
    });
    ResponseUtil.success(res, zones);
  } catch (error) {
    next(error);
  }
};

/** POST create pricing zone */
const createPricingZoneHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      nameAr,
      minDistanceKm,
      maxDistanceKm,
      baseFee,
      extraFeePerKm = 0,
      currency,
      isActive = true,
      priority = 0,
    } = req.body;

    const zoneName = String(name || nameAr || '').trim();
    const zoneNameAr = String(nameAr || name || '').trim();

    if (!zoneName || minDistanceKm === undefined || baseFee === undefined) {
      throw new AppError('name (or nameAr), minDistanceKm, and baseFee are required', 400);
    }

    const zone = await prisma.deliveryZonePricing.create({
      data: {
        name: zoneName,
        nameAr: zoneNameAr,
        minDistanceKm: parseFloat(String(minDistanceKm)),
        maxDistanceKm: maxDistanceKm !== undefined && maxDistanceKm !== null && String(maxDistanceKm).trim() !== ''
          ? parseFloat(String(maxDistanceKm))
          : null,
        baseFee: parseFloat(String(baseFee)),
        extraFeePerKm: parseFloat(String(extraFeePerKm || 0)),
        currency: String(currency || config.marketplace.currency),
        isActive: Boolean(isActive),
        priority: parseInt(String(priority || 0), 10),
      },
    });

    ResponseUtil.created(res, zone, 'تم إنشاء المنطقة بنجاح');
  } catch (error) {
    next(error);
  }
};

/** PUT update pricing zone */
const updatePricingZoneHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const {
      name, nameAr, minDistanceKm, maxDistanceKm,
      baseFee, extraFeePerKm, currency, isActive, priority,
    } = req.body;

    const zone = await prisma.deliveryZonePricing.findUnique({ where: { id } });
    if (!zone) throw new AppError('المنطقة غير موجودة', 404);

    const updated = await prisma.deliveryZonePricing.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(nameAr !== undefined ? { nameAr: String(nameAr) } : {}),
        ...(minDistanceKm !== undefined ? { minDistanceKm: parseFloat(String(minDistanceKm)) } : {}),
        ...(maxDistanceKm !== undefined ? {
          maxDistanceKm: (maxDistanceKm === null || String(maxDistanceKm).trim() === '')
            ? null
            : parseFloat(String(maxDistanceKm)),
        } : {}),
        ...(baseFee !== undefined ? { baseFee: parseFloat(String(baseFee)) } : {}),
        ...(extraFeePerKm !== undefined ? { extraFeePerKm: parseFloat(String(extraFeePerKm)) } : {}),
        ...(currency !== undefined ? { currency: String(currency) } : {}),
        ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
        ...(priority !== undefined ? { priority: parseInt(String(priority), 10) } : {}),
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث المنطقة بنجاح');
  } catch (error) {
    next(error);
  }
};

/** DELETE soft-deactivate pricing zone */
const deletePricingZoneHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const zone = await prisma.deliveryZonePricing.findUnique({ where: { id } });
    if (!zone) throw new AppError('المنطقة غير موجودة', 404);

    await prisma.deliveryZonePricing.update({
      where: { id },
      data: { isActive: false },
    });

    ResponseUtil.success(res, null, 'تم إلغاء تفعيل المنطقة بنجاح');
  } catch (error) {
    next(error);
  }
};

// Register routes for both /pricing-zones, /distance-pricing-zones, and legacy /zones
router.get('/pricing-zones', getPricingZonesHandler);
router.post('/pricing-zones', createPricingZoneHandler);
router.put('/pricing-zones/:id', updatePricingZoneHandler);
router.delete('/pricing-zones/:id', deletePricingZoneHandler);

router.get('/distance-pricing-zones', getPricingZonesHandler);
router.post('/distance-pricing-zones', createPricingZoneHandler);
router.put('/distance-pricing-zones/:id', updatePricingZoneHandler);
router.delete('/distance-pricing-zones/:id', deletePricingZoneHandler);

// ──────────────────────────────────────────────────────────────────────────────
// Delivery Settings
// ──────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/admin/delivery/settings */
router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await prisma.deliverySettings.findFirst();
    if (!settings) {
      settings = await prisma.deliverySettings.create({
        data: {
          multiVendorPolicy: 'PER_SELLER',
          expressEnabled: true,
          expressFeeFixed: config.marketplace.expressFeeFixed,
          maxDeliveryRadiusKm: config.marketplace.maxDeliveryRadiusKm,
          freeDeliveryThreshold: null,
          currency: config.marketplace.currency,
        },
      });
    }
    ResponseUtil.success(res, settings);
  } catch (error) {
    next(error);
  }
});

/** PUT /api/v1/admin/delivery/settings */
router.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      multiVendorPolicy,
      expressEnabled,
      expressFeeFixed,
      maxDeliveryRadiusKm,
      freeDeliveryThreshold,
      currency,
    } = req.body;

    const validPolicies = ['PER_SELLER', 'MAXIMUM_FEE', 'COMBINED', 'FREE_ABOVE_ORDER_VALUE'];
    if (multiVendorPolicy && !validPolicies.includes(multiVendorPolicy)) {
      throw new AppError(`multiVendorPolicy must be one of: ${validPolicies.join(', ')}`, 400);
    }

    const existing = await prisma.deliverySettings.findFirst();

    const data: any = {
      ...(multiVendorPolicy !== undefined ? { multiVendorPolicy } : {}),
      ...(expressEnabled !== undefined ? { expressEnabled: Boolean(expressEnabled) } : {}),
      ...(expressFeeFixed !== undefined ? { expressFeeFixed: parseFloat(String(expressFeeFixed)) } : {}),
      ...(maxDeliveryRadiusKm !== undefined ? { maxDeliveryRadiusKm: parseFloat(String(maxDeliveryRadiusKm)) } : {}),
      ...(freeDeliveryThreshold !== undefined ? {
        freeDeliveryThreshold: freeDeliveryThreshold === null ? null : parseFloat(String(freeDeliveryThreshold)),
      } : {}),
      ...(currency !== undefined ? { currency: String(currency) } : {}),
    };

    let settings;
    if (existing) {
      settings = await prisma.deliverySettings.update({ where: { id: existing.id }, data });
    } else {
      settings = await prisma.deliverySettings.create({ data });
    }

    ResponseUtil.success(res, settings, 'تم تحديث إعدادات التوصيل بنجاح');
  } catch (error) {
    next(error);
  }
});

export const adminDeliveryRoutes = router;
