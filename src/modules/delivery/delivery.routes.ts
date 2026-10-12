import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { config } from '../../config';
import { authenticate } from '../../middleware/auth.middleware';
import { deliveryFeeService } from '../../services/delivery/delivery-fee.service';
import { deliveryQuoteService } from '../../services/delivery/delivery-quote.service';
import { deliverySlotService } from '../../services/delivery/delivery-slot.service';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// Public endpoints (no auth required)
// ──────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/delivery/zones — legacy city-based zones (preserved) */
router.get('/zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await prisma.deliveryZone.findMany({
      where: { isActive: true },
      include: { rules: true, city: true },
    });
    ResponseUtil.success(res, zones);
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/delivery/pricing-zones — distance-based pricing zones */
router.get('/pricing-zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await prisma.deliveryZonePricing.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });
    ResponseUtil.success(res, zones);
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/delivery/methods */
router.get('/methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const methods = await prisma.deliveryMethod.findMany({
      where: { isActive: true },
    });
    ResponseUtil.success(res, methods);
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/delivery/settings */
router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await prisma.deliverySettings.findFirst();
    ResponseUtil.success(res, settings ?? {
      multiVendorPolicy: config.marketplace.multiVendorPolicy,
      expressEnabled: true,
      expressFeeFixed: config.marketplace.expressFeeFixed,
      maxDeliveryRadiusKm: config.marketplace.maxDeliveryRadiusKm,
      currency: config.marketplace.currency,
      schedulingEnabled: true,
      schedulingAdvanceDays: 7,
    });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Scheduled Delivery endpoints (public — no auth needed for discovery)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/delivery/available-dates
 * Returns schedulable delivery dates for the next N days.
 * Query param: daysAhead (default from DeliverySettings.schedulingAdvanceDays)
 */
router.get('/available-dates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const daysAhead = req.query.daysAhead ? parseInt(req.query.daysAhead as string, 10) : undefined;
    const dates = await deliverySlotService.getAvailableDates(daysAhead);
    ResponseUtil.success(res, dates);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/delivery/time-slots?date=YYYY-MM-DD
 * Returns active time slots for a given delivery date with booked capacity.
 */
router.get('/time-slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date } = req.query;
    if (!date || typeof date !== 'string') throw new AppError('date query param is required (YYYY-MM-DD)', 400);
    const slots = await deliverySlotService.getSlotsForDate(date);
    ResponseUtil.success(res, slots);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/delivery/validate-slot
 * Validates whether a specific slot is available on a given date.
 * Does NOT reserve the slot.
 */
router.post('/validate-slot', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { timeSlotId, deliveryDate } = req.body;
    if (!timeSlotId || !deliveryDate) throw new AppError('timeSlotId and deliveryDate are required', 400);
    const result = await deliverySlotService.validateSlot(timeSlotId, deliveryDate);
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/delivery/calculate — legacy flat-fee (preserved for backward compat)
// ──────────────────────────────────────────────────────────────────────────────

router.post('/calculate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { addressId, cityId, cartSubtotal = 0, deliveryMethodCode = 'standard' } = req.body;

    let targetCityId = cityId;
    if (addressId && !targetCityId) {
      const address = await prisma.address.findUnique({ where: { id: addressId } });
      if (address) targetCityId = address.cityId;
    }

    const method = await prisma.deliveryMethod.findFirst({
      where: { code: deliveryMethodCode, isActive: true },
      include: {
        rules: {
          where: { isActive: true, ...(targetCityId ? { deliveryZone: { cityId: targetCityId } } : {}) },
        },
      },
    });

    let deliveryFee = method?.basePrice ?? config.marketplace.baseDeliveryFee;
    const subtotal = parseFloat(String(cartSubtotal));

    if (subtotal >= config.marketplace.freeDeliveryThreshold) {
      deliveryFee = 0.0;
    } else if (method && method.rules.length > 0) {
      const rule = method.rules[0];
      if (rule.freeDeliveryThreshold && subtotal >= rule.freeDeliveryThreshold) {
        deliveryFee = 0.0;
      } else {
        deliveryFee = rule.fee;
      }
    }

    ResponseUtil.success(res, {
      deliveryMethod: method?.code || 'standard',
      deliveryFee,
      currency: config.marketplace.currency,
      isFreeDelivery: deliveryFee === 0,
      estimatedHours: {
        min: method?.estimatedHoursMin ?? 24,
        max: method?.estimatedHoursMax ?? 48,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/delivery/quote — authoritative distance-based delivery quote
// §14: Full quote flow
// §33: Flutter never trusts client-provided fee/distance/zone
// ──────────────────────────────────────────────────────────────────────────────

router.post('/quote', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      customerAddressId,
      sellerOrders, // [{ sellerId, storeId }]
      deliveryMethod = 'standard',
      isExpress = false,
      deliveryScheduleType = 'ASAP',
      deliveryDate,
      deliveryTimeSlotId,
      discountAmount = 0,
      discountFundedBy,
    } = req.body;

    if (!customerAddressId) throw new AppError('customerAddressId is required', 400);
    if (!Array.isArray(sellerOrders) || sellerOrders.length === 0) {
      throw new AppError('sellerOrders must be a non-empty array of { sellerId, storeId }', 400);
    }

    // Validate address belongs to the requesting user
    const address = await prisma.address.findFirst({
      where: { id: customerAddressId, userId: req.user!.userId },
    });
    if (!address) throw new AppError('Address not found or does not belong to you', 404);

    const result = await deliveryQuoteService.createQuote({
      customerAddressId,
      sellerOrders,
      deliveryMethod,
      isExpress,
      deliveryScheduleType,
      deliveryDate,
      deliveryTimeSlotId,
      discountAmount: parseFloat(String(discountAmount)) || 0,
      discountFundedBy,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

export const deliveryRoutes = router;
