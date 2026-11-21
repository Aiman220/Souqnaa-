import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { config } from '../../config';
import { authenticate } from '../../middleware/auth.middleware';
import { deliveryFeeService } from '../../services/delivery/delivery-fee.service';
import { deliveryQuoteService } from '../../services/delivery/delivery-quote.service';
import { deliverySlotService } from '../../services/delivery/delivery-slot.service';
import { interGovernorateRouteService } from '../../services/delivery/inter-governorate-route.service';
import { interGovernorateTrackingService } from '../../services/delivery/inter-governorate-tracking.service';

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

    // Digital product delivery fee is strictly zero (§1)
    if (req.body.isDigitalOnly || req.body.isDigital) {
      return ResponseUtil.success(res, {
        deliveryMethod: 'digital',
        deliveryFee: 0,
        currency: config.marketplace.currency,
        isFreeDelivery: true,
        estimatedHours: { min: 0, max: 0 },
      });
    }

    if (req.body.productId) {
      const prod = await prisma.product.findUnique({
        where: { id: String(req.body.productId) },
        select: { fulfillmentType: true },
      });
      if (prod?.fulfillmentType === 'DIGITAL') {
        return ResponseUtil.success(res, {
          deliveryMethod: 'digital',
          deliveryFee: 0,
          currency: config.marketplace.currency,
          isFreeDelivery: true,
          estimatedHours: { min: 0, max: 0 },
        });
      }
    }

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
      destinationAreaId,
    } = req.body;

    let isDigitalOnly = Boolean(req.body.isDigitalOnly);

    if (!Array.isArray(sellerOrders) || sellerOrders.length === 0) {
      throw new AppError('sellerOrders must be a non-empty array of { sellerId, storeId }', 400);
    }

    const rawSellerMethodOverrides = (req.body.sellerDeliveryMethods && typeof req.body.sellerDeliveryMethods === 'object')
      ? req.body.sellerDeliveryMethods
      : {};

    const userCart = req.user?.userId
      ? await prisma.cart.findUnique({
          where: { userId: req.user.userId },
          include: {
            items: {
              include: {
                product: { include: { category: true, store: true } },
              },
            },
          },
        })
      : null;

    // Authoritative Server-Side Digital Classification (§4)
    if (userCart && userCart.items.length > 0) {
      const hasPhysicalInCart = userCart.items.some(
        (it) => it.product?.fulfillmentType !== 'DIGITAL'
      );
      if (!hasPhysicalInCart) {
        isDigitalOnly = true;
      }
    }

    if (req.body.productId) {
      const prod = await prisma.product.findUnique({
        where: { id: String(req.body.productId) },
        select: { fulfillmentType: true },
      });
      if (prod?.fulfillmentType === 'DIGITAL') {
        isDigitalOnly = true;
      }
    }

    if (!isDigitalOnly) {
      if (!customerAddressId) throw new AppError('customerAddressId is required', 400);

      // Validate address belongs to the requesting user
      const address = await prisma.address.findFirst({
        where: { id: customerAddressId, userId: req.user!.userId },
      });
      if (!address) throw new AppError('Address not found or does not belong to you', 404);
    }

    // Collect explicit product IDs from sellerOrders and buyNowItem
    const explicitProductIds: string[] = [];
    for (const so of sellerOrders) {
      if (Array.isArray(so.items)) {
        for (const it of so.items) {
          if (it.productId) explicitProductIds.push(String(it.productId));
        }
      }
    }
    if (req.body.buyNowItem?.productId) {
      explicitProductIds.push(String(req.body.buyNowItem.productId));
    }
    if (req.body.productId) {
      explicitProductIds.push(String(req.body.productId));
    }

    const fetchedProducts = explicitProductIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: Array.from(new Set(explicitProductIds)) } },
          include: { category: true, store: true },
        })
      : [];
    const productMap = new Map(fetchedProducts.map((p) => [p.id, p]));

    const enrichedSellerOrders = sellerOrders.map((so: any) => {
      const customMethod = so.deliveryMethod || rawSellerMethodOverrides[so.sellerId];
      const isSellerExpress = typeof so.isExpress === 'boolean'
        ? so.isExpress
        : (customMethod?.toLowerCase() === 'express' || isExpress);

      let isSellerDigital = Boolean(so.isDigital);
      let heavyItems = so.heavyItems;

      // 1. If explicit items passed in this sellerOrder
      if (!heavyItems && Array.isArray(so.items) && so.items.length > 0) {
        heavyItems = so.items.map((it: any) => {
          const prod = productMap.get(String(it.productId));
          return {
            productId: it.productId,
            name: it.name || prod?.nameAr || prod?.nameEn || 'منتج',
            quantity: it.quantity || 1,
            weightKg: prod?.weight ?? it.weightKg ?? null,
            lengthCm: prod?.lengthCm ?? it.lengthCm ?? null,
            widthCm: prod?.widthCm ?? it.widthCm ?? null,
            heightCm: prod?.heightCm ?? it.heightCm ?? null,
            packageWeightKg: prod?.packageWeightKg ?? it.packageWeightKg ?? null,
            packageLengthCm: prod?.packageLengthCm ?? null,
            packageWidthCm: prod?.packageWidthCm ?? null,
            packageHeightCm: prod?.packageHeightCm ?? null,
            sellingUnit: prod?.sellingUnit ?? null,
            unitDimensionsJson: prod?.unitDimensionsJson ?? null,
            palletCount: prod?.palletCount ?? null,
            packagingType: prod?.packagingType ?? null,
            isFragile: prod?.isFragile ?? false,
            isOversized: prod?.isOversized ?? false,
            requiresForklift: prod?.requiresForklift ?? false,
            requiresCrane: prod?.requiresCrane ?? false,
            requiresSpecialVehicle: prod?.requiresSpecialVehicle ?? false,
            specialVehicleType: prod?.specialVehicleType ?? null,
            categorySlug: prod?.category?.slug ?? null,
            categoryNameAr: prod?.category?.nameAr ?? null,
            categoryNameEn: prod?.category?.nameEn ?? null,
            isDigital: prod?.fulfillmentType === 'DIGITAL' || it.fulfillmentType === 'DIGITAL',
          };
        });
      }

      // 2. If Buy Now item
      if (!heavyItems && req.body.buyNowItem?.productId) {
        const prod = productMap.get(String(req.body.buyNowItem.productId));
        if (prod) {
          heavyItems = [{
            productId: prod.id,
            name: prod.nameAr || prod.nameEn,
            quantity: req.body.buyNowItem.quantity || 1,
            weightKg: prod.weight ?? null,
            lengthCm: prod.lengthCm ?? null,
            widthCm: prod.widthCm ?? null,
            heightCm: prod.heightCm ?? null,
            packageWeightKg: prod.packageWeightKg ?? null,
            packageLengthCm: prod.packageLengthCm ?? null,
            packageWidthCm: prod.packageWidthCm ?? null,
            packageHeightCm: prod.packageHeightCm ?? null,
            sellingUnit: prod.sellingUnit ?? null,
            unitDimensionsJson: prod.unitDimensionsJson ?? null,
            palletCount: prod.palletCount ?? null,
            packagingType: prod.packagingType ?? null,
            isFragile: prod.isFragile ?? false,
            isOversized: prod.isOversized ?? false,
            requiresForklift: prod.requiresForklift ?? false,
            requiresCrane: prod.requiresCrane ?? false,
            requiresSpecialVehicle: prod.requiresSpecialVehicle ?? false,
            specialVehicleType: prod.specialVehicleType ?? null,
            categorySlug: prod.category?.slug ?? null,
            categoryNameAr: prod.category?.nameAr ?? null,
            categoryNameEn: prod.category?.nameEn ?? null,
            isDigital: prod.fulfillmentType === 'DIGITAL',
          }];
        }
      }

      // 3. Fallback to userCart in DB
      if (!heavyItems && userCart) {
        let storeCartItems = userCart.items.filter(
          (it) => it.product?.storeId === so.storeId || it.product?.store?.sellerId === so.sellerId || (it.product as any)?.sellerId === so.sellerId
        );
        if (storeCartItems.length === 0 && sellerOrders.length === 1) {
          storeCartItems = userCart.items;
        }
        if (storeCartItems.length > 0) {
          const sellerHasPhysical = storeCartItems.some(
            (it) => it.product?.fulfillmentType !== 'DIGITAL'
          );
          if (!sellerHasPhysical) {
            isSellerDigital = true;
          }
          heavyItems = storeCartItems.map((it) => ({
            productId: it.product?.id,
            name: it.product?.nameAr || it.product?.nameEn,
            quantity: it.quantity || 1,
            weightKg: it.product?.weight ?? null,
            lengthCm: it.product?.lengthCm ?? null,
            widthCm: it.product?.widthCm ?? null,
            heightCm: it.product?.heightCm ?? null,
            packageWeightKg: it.product?.packageWeightKg ?? null,
            packageLengthCm: it.product?.packageLengthCm ?? null,
            packageWidthCm: it.product?.packageWidthCm ?? null,
            packageHeightCm: it.product?.packageHeightCm ?? null,
            sellingUnit: it.product?.sellingUnit ?? null,
            unitDimensionsJson: it.product?.unitDimensionsJson ?? null,
            palletCount: it.product?.palletCount ?? null,
            packagingType: it.product?.packagingType ?? null,
            isFragile: it.product?.isFragile ?? false,
            isOversized: it.product?.isOversized ?? false,
            requiresForklift: it.product?.requiresForklift ?? false,
            requiresCrane: it.product?.requiresCrane ?? false,
            requiresSpecialVehicle: it.product?.requiresSpecialVehicle ?? false,
            specialVehicleType: it.product?.specialVehicleType ?? null,
            categorySlug: it.product?.category?.slug ?? null,
            categoryNameAr: it.product?.category?.nameAr ?? null,
            categoryNameEn: it.product?.category?.nameEn ?? null,
            isDigital: it.product?.fulfillmentType === 'DIGITAL',
          }));
        }
      }

      if (isDigitalOnly || isSellerDigital) {
        return {
          sellerId: so.sellerId,
          storeId: so.storeId,
          deliveryMethod: 'digital',
          isExpress: false,
          isDigital: true,
          weightKg: 0,
          lengthCm: 0,
          widthCm: 0,
          heightCm: 0,
          heavyItems: [],
        };
      }

      return {
        sellerId: so.sellerId,
        storeId: so.storeId,
        deliveryMethod: customMethod || deliveryMethod,
        isExpress: isSellerExpress,
        weightKg: so.weightKg,
        lengthCm: so.lengthCm,
        widthCm: so.widthCm,
        heightCm: so.heightCm,
        isRemoteArea: so.isRemoteArea,
        isSpecialHandling: so.isSpecialHandling,
        heavyItems,
        accessSurcharge: so.accessSurcharge,
        isDigital: false,
      };
    });

    const result = await deliveryQuoteService.createQuote({
      customerAddressId,
      isDigitalOnly,
      sellerOrders: enrichedSellerOrders,
      deliveryMethod,
      isExpress,
      deliveryScheduleType,
      deliveryDate,
      deliveryTimeSlotId,
      discountAmount: parseFloat(String(discountAmount)) || 0,
      discountFundedBy,
      destinationAreaId,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Inter-Governorate Public Discovery & Tracking Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/delivery/inter-governorate/routes
 * Discovers active, approved inter-governorate routes and supported delivery methods.
 */
router.get('/inter-governorate/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isEnabled = await interGovernorateRouteService.isInterGovernorateEnabled();
    if (!isEnabled) {
      return ResponseUtil.success(res, {
        enabled: false,
        routes: [],
        message: 'خدمة الشحن بين المحافظات غير مفعلة حالياً',
      });
    }

    const routes = await interGovernorateRouteService.listRoutes({ isActive: true });
    ResponseUtil.success(res, {
      enabled: true,
      routes,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/delivery/inter-governorate/pickup-points
 * Lists designated pickup hubs in destination areas.
 */
router.get('/inter-governorate/pickup-points', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { areaId } = req.query;
    const hubs = await interGovernorateTrackingService.listHubs({
      areaId: areaId ? String(areaId) : undefined,
      isPickupPoint: true,
    });
    ResponseUtil.success(res, hubs);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/delivery/tracking/:trackingNumber
 * Returns authoritative shipment tracking timeline and checkpoints.
 */
router.get('/tracking/:trackingNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackingNumber = String(req.params.trackingNumber || '');
    if (!trackingNumber) throw new AppError('رقم التتبع مطلوب', 400);

    const timeline = await interGovernorateTrackingService.getTrackingTimeline(trackingNumber);
    ResponseUtil.success(res, timeline);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/delivery/tracking/:trackingNumber/checkpoint
 * Updates checkpoint (requires authentication: Carrier, Hub Staff, Seller, or Admin).
 */
router.post('/tracking/:trackingNumber/checkpoint', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackingNumber = String(req.params.trackingNumber || '');
    const {
      status,
      locationName,
      descriptionAr,
      descriptionEn,
      hubId,
      hubName,
      failedReason,
      rescheduledDate,
      notes,
    } = req.body;

    if (!trackingNumber || !status || !locationName || !descriptionAr) {
      throw new AppError('بيانات التتبع المطلوبة غير مكتملة', 400);
    }

    const checkpoint = await interGovernorateTrackingService.recordCheckpoint({
      trackingNumber,
      status,
      locationName,
      descriptionAr,
      descriptionEn,
      hubId,
      hubName,
      actorType: (req.user?.role as any) || 'SYSTEM',
      actorId: req.user?.userId,
      actorName: req.user?.email || 'مشرف النظام',
      failedReason,
      rescheduledDate: rescheduledDate ? new Date(rescheduledDate) : undefined,
      notes,
    });

    ResponseUtil.created(res, checkpoint, 'تم تسجيل نقطة التتبع بنجاح');
  } catch (error) {
    next(error);
  }
});

export const deliveryRoutes = router;
