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
      schedulingEnabled,
      deliveryScheduleScope,
      schedulingAdvanceDays,
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
      ...(schedulingEnabled !== undefined ? { schedulingEnabled: Boolean(schedulingEnabled) } : {}),
      ...(deliveryScheduleScope !== undefined ? { deliveryScheduleScope } : {}),
      ...(schedulingAdvanceDays !== undefined ? { schedulingAdvanceDays: parseInt(String(schedulingAdvanceDays), 10) } : {}),
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

// ──────────────────────────────────────────────────────────────────────────────
// Heavy & Bulky Vehicle Classes Admin Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/admin/delivery/heavy-vehicles */
router.get('/heavy-vehicles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const vehicles = await prisma.heavyVehicleClass.findMany({
      orderBy: { priority: 'asc' },
    });
    ResponseUtil.success(res, vehicles);
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/admin/delivery/heavy-vehicles */
router.post('/heavy-vehicles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      code,
      nameAr,
      nameEn,
      maxWeightKg,
      maxVolumeCbm,
      maxLengthCm,
      maxWidthCm,
      maxHeightCm,
      baseFee,
      ratePerKm = 0,
      interGovernorateHireRate = 0,
      loadingFee = 0,
      unloadingFee = 0,
      supportedCargoTypes,
      requiresCrane = false,
      requiresForklift = false,
      isActive = true,
      priority = 0,
      notes,
    } = req.body;

    if (!code || !nameAr || maxWeightKg === undefined || baseFee === undefined) {
      throw new AppError('code, nameAr, maxWeightKg, and baseFee are required', 400);
    }

    const vehicle = await prisma.heavyVehicleClass.create({
      data: {
        code: String(code).trim().toUpperCase(),
        nameAr: String(nameAr).trim(),
        nameEn: String(nameEn || code).trim(),
        maxWeightKg: parseFloat(String(maxWeightKg)),
        maxVolumeCbm: parseFloat(String(maxVolumeCbm || 10.0)),
        maxLengthCm: parseFloat(String(maxLengthCm || 300.0)),
        maxWidthCm: parseFloat(String(maxWidthCm || 180.0)),
        maxHeightCm: parseFloat(String(maxHeightCm || 180.0)),
        baseFee: parseFloat(String(baseFee)),
        ratePerKm: parseFloat(String(ratePerKm)),
        interGovernorateHireRate: parseFloat(String(interGovernorateHireRate)),
        loadingFee: parseFloat(String(loadingFee)),
        unloadingFee: parseFloat(String(unloadingFee)),
        supportedCargoTypes: supportedCargoTypes ? String(supportedCargoTypes) : null,
        requiresCrane: Boolean(requiresCrane),
        requiresForklift: Boolean(requiresForklift),
        isActive: Boolean(isActive),
        priority: parseInt(String(priority || 0), 10),
        notes: notes ? String(notes) : null,
      },
    });

    ResponseUtil.created(res, vehicle, 'تم إضافة فئة مركبة النقل الثقيل بنجاح');
  } catch (error) {
    next(error);
  }
});

/** PUT /api/v1/admin/delivery/heavy-vehicles/:id */
router.put('/heavy-vehicles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updateData: any = {};

    const fields = [
      'nameAr', 'nameEn', 'maxWeightKg', 'maxVolumeCbm', 'maxLengthCm',
      'maxWidthCm', 'maxHeightCm', 'baseFee', 'ratePerKm',
      'interGovernorateHireRate', 'loadingFee', 'unloadingFee',
      'supportedCargoTypes', 'requiresCrane', 'requiresForklift',
      'isActive', 'priority', 'notes',
    ];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        if (['maxWeightKg', 'maxVolumeCbm', 'maxLengthCm', 'maxWidthCm', 'maxHeightCm', 'baseFee', 'ratePerKm', 'interGovernorateHireRate', 'loadingFee', 'unloadingFee'].includes(f)) {
          updateData[f] = parseFloat(String(req.body[f]));
        } else if (['requiresCrane', 'requiresForklift', 'isActive'].includes(f)) {
          updateData[f] = Boolean(req.body[f]);
        } else if (f === 'priority') {
          updateData[f] = parseInt(String(req.body[f]), 10);
        } else {
          updateData[f] = req.body[f];
        }
      }
    }

    const vehicle = await prisma.heavyVehicleClass.update({
      where: { id },
      data: updateData,
    });

    ResponseUtil.success(res, vehicle, 'تم تحديث فئة المركبة بنجاح');
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/v1/admin/delivery/heavy-vehicles/:id */
router.delete('/heavy-vehicles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.heavyVehicleClass.delete({ where: { id } });
    ResponseUtil.success(res, null, 'تم حذف فئة المركبة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Heavy Delivery Quotes Admin Endpoints (§7 Manual Quote Workflow)
// ──────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/admin/delivery/heavy-quotes */
router.get('/heavy-quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    const quotes = await prisma.heavyDeliveryQuote.findMany({
      where: status ? { status: String(status) } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    ResponseUtil.success(res, quotes);
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/admin/delivery/heavy-quotes/:id/offer */
router.post('/heavy-quotes/:id/offer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { quotedFee, notes, validityHours = 48 } = req.body;

    if (quotedFee === undefined || isNaN(parseFloat(String(quotedFee)))) {
      throw new AppError('quotedFee is required and must be a number', 400);
    }

    const validUntil = new Date(Date.now() + validityHours * 3600 * 1000);

    const quote = await prisma.heavyDeliveryQuote.update({
      where: { id },
      data: {
        quotedFee: parseFloat(String(quotedFee)),
        status: 'OFFERED',
        notes: notes ? String(notes) : undefined,
        validUntil,
        reviewedBy: req.user?.userId || 'ADMIN',
        reviewedAt: new Date(),
      },
    });

    ResponseUtil.success(res, quote, 'تم تقديم عرض سعر الشحن الثقيل للعميل بنجاح');
  } catch (error) {
    next(error);
  }
});

export const adminDeliveryRoutes = router;
