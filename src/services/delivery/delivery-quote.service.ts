/**
 * DeliveryQuoteService — orchestrates a full delivery quote from customer + seller inputs.
 * Also persists the immutable snapshot at checkout confirmation (§16).
 */

import { prisma } from '../../database/prisma';
import { deliveryFeeService, type DeliveryFeeOptions, type DeliveryQuoteResult } from './delivery-fee.service';
import { supportedAreasService, STRICTLY_SUPPORTED_AREAS } from '../../modules/locations/supported-areas.service';
import { RemoteConfigService } from '../../modules/remote-config/remote-config.service';
import { config } from '../../config';
import { deliverySlotService } from './delivery-slot.service';
import { type HeavyProductShippingInput, type DeliverySubShipment } from './heavy-delivery.service';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SellerOrderInput {
  sellerId: string;
  storeId: string;
  deliveryMethod?: string;
  isExpress?: boolean;
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  isRemoteArea?: boolean;
  isSpecialHandling?: boolean;
  extraSellerFee?: number;
  heavyItems?: HeavyProductShippingInput[];
  accessSurcharge?: number;
  isDigital?: boolean;
}

export interface StoreAvailabilityStatus {
  storeId: string;
  storeName: string;
  isOpen: boolean;
  isWithinWorkingHours: boolean;
  isCurrentlyOpen: boolean;
  openingTime: string;
  closingTime: string;
  acceptsExpress: boolean;
  acceptsScheduled: boolean;
  busyMode: boolean;
  expressAvailable: boolean;
  expressDisabledReason?: string;
  warningMessage?: string;
}

export interface QuoteRequest {
  customerAddressId?: string;
  isDigitalOnly?: boolean;
  sellerOrders: SellerOrderInput[];
  deliveryMethod?: string;
  isExpress?: boolean;
  destinationAreaId?: string;
  buyNowItem?: { productId?: string; [key: string]: any };
  // Scheduled delivery
  deliveryScheduleType?: 'ASAP' | 'SCHEDULED' | 'EXPRESS';
  deliveryDate?: string;       // YYYY-MM-DD, required when SCHEDULED
  deliveryTimeSlotId?: string; // required when SCHEDULED
  discountAmount?: number;
  discountFundedBy?: 'MARKETPLACE' | 'SELLER' | 'COUPON';
}

export interface FullQuoteResponse {
  deliveryAvailable: boolean;
  reason?: string;
  isDigitalOnly?: boolean;
  maxDistanceKm?: number;
  maxRadiusKm?: number;
  sellerQuotes: (DeliveryQuoteResult & { sellerId: string; storeId: string; storeName?: string })[];
  totalDeliveryFee: number;
  currency: string;
  policy: string;
  // Scheduled delivery echo
  deliveryScheduleType?: string;
  deliveryDate?: string;
  deliveryTimeSlotId?: string;
  timeSlotNameAr?: string;
  timeSlotStart?: string;
  timeSlotEnd?: string;
  slotFee: number;
  slotWarning?: string;
  // Store operational availability
  storesStatus: StoreAvailabilityStatus[];
  standardAvailable?: boolean;
  scheduledAvailable?: boolean;
  expressAvailable: boolean;
  expressDisabledReason?: string;
  storeWarning?: string;
  // Inter-Governorate top-level metadata
  isInterGovernorate?: boolean;
  routeKey?: string;
  routeNameAr?: string;
  shippingProvider?: string;
  allowedDeliveryMethods?: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    surcharge: number;
    isAvailable?: boolean;
    estimatedHoursMin?: number;
    estimatedHoursMax?: number;
  }>;
  expressSupported?: boolean;
  expressSurcharge?: number;
  carrierCost?: number;
  sellerContribution?: number;
  marketplaceSubsidy?: number;
  estimatedHoursMin?: number;
  estimatedHoursMax?: number;
  // Heavy & Bulky Delivery top-level metadata
  isHeavyDelivery?: boolean;
  deliveryMode?: string;
  quoteType?: string;
  quoteReason?: string;
  requiresManualQuote?: boolean;
  vehicleClass?: string;
  vehicleClassNameAr?: string;
  vehicleClassNameEn?: string;
  palletCount?: number;
  cargoClassification?: string;
  cargoDescriptionAr?: string;
  loadingFee?: number;
  unloadingFee?: number;
  forkliftFee?: number;
  craneFee?: number;
  accessSurcharge?: number;
  requiresForklift?: boolean;
  requiresCrane?: boolean;
  heavyAvailable?: boolean;
  // Product-Driven Shipment Breakdown (§Mixed Cart Compatibility)
  hasMixedShipments?: boolean;
  shipmentCount?: number;
  shipments?: DeliverySubShipment[];
  standardShipmentFee?: number;
  heavyShipmentFee?: number;
  digitalShipmentFee?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

export function evaluateStoreAvailability(store: {
  id: string;
  name: string;
  isOpen?: boolean | null;
  openingTime?: string | null;
  closingTime?: string | null;
  acceptsExpress?: boolean | null;
  acceptsScheduled?: boolean | null;
  busyMode?: boolean | null;
  closedReason?: string | null;
}): StoreAvailabilityStatus {
  const isOpen = store.isOpen !== false;
  const openingTime = store.openingTime || '08:00';
  const closingTime = store.closingTime || '23:00';
  const acceptsExpress = store.acceptsExpress !== false;
  const acceptsScheduled = store.acceptsScheduled !== false;
  const busyMode = store.busyMode === true;

  // Check working hours against current time (UTC+3 Sanaa/Riyadh timezone)
  const now = new Date();
  const utcHours = now.getUTCHours() + 3;
  const currentMinutes = (utcHours % 24) * 60 + now.getUTCMinutes();

  const [openH, openM] = openingTime.split(':').map(Number);
  const [closeH, closeM] = closingTime.split(':').map(Number);
  const openMinutes = (openH || 8) * 60 + (openM || 0);
  const closeMinutes = (closeH || 23) * 60 + (closeM || 0);

  let isWithinWorkingHours = true;
  if (closeMinutes > openMinutes) {
    isWithinWorkingHours = currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  } else {
    isWithinWorkingHours = currentMinutes >= openMinutes || currentMinutes < closeMinutes;
  }

  const isCurrentlyOpen = isOpen && isWithinWorkingHours;

  let expressAvailable = isCurrentlyOpen && acceptsExpress && !busyMode;
  let expressDisabledReason: string | undefined;

  if (!isOpen) {
    expressDisabledReason = store.closedReason || `المتجر "${store.name}" مغلق حالياً مؤقتاً`;
  } else if (!isWithinWorkingHours) {
    expressDisabledReason = `المتجر "${store.name}" خارج أوقات العمل الرسمية (${openingTime} - ${closingTime})`;
  } else if (busyMode) {
    expressDisabledReason = `المتجر "${store.name}" في حالة ذروة وانشغال عالي مؤقتاً`;
  } else if (!acceptsExpress) {
    expressDisabledReason = `المتجر "${store.name}" لا يدعم التوصيل السريع الفوري`;
  }

  let warningMessage: string | undefined;
  if (!isCurrentlyOpen) {
    warningMessage = `المتجر "${store.name}" مغلق حالياً (ساعات العمل: ${openingTime} - ${closingTime}). يمكنك جدولة موعد التوصيل أو اختيار التوصيل العادي.`;
  } else if (busyMode) {
    warningMessage = `المتجر "${store.name}" يشهد طلباً متزايداً قد يستغرق بعض الوقت الإضافي.`;
  }

  return {
    storeId: store.id,
    storeName: store.name,
    isOpen,
    isWithinWorkingHours,
    isCurrentlyOpen,
    openingTime,
    closingTime,
    acceptsExpress,
    acceptsScheduled,
    busyMode,
    expressAvailable,
    expressDisabledReason,
    warningMessage,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

export class DeliveryQuoteService {
  /**
   * Create a full delivery quote.
   */
  async createQuote(request: QuoteRequest): Promise<FullQuoteResponse> {
    const {
      customerAddressId,
      sellerOrders,
      deliveryMethod = 'standard',
      isExpress = false,
      destinationAreaId: requestedDestAreaId,
      deliveryScheduleType = 'ASAP',
      deliveryDate,
      deliveryTimeSlotId,
      discountAmount = 0,
      discountFundedBy,
    } = request;

    // 0. Handle digital-only orders (no physical delivery fees, no address/distance checks)
    const getOrderItems = (so: any): any[] => so.items || so.heavyItems || [];
    let isDigitalOnlyOrder = Boolean(
      request.isDigitalOnly ||
      (sellerOrders.length > 0 && sellerOrders.every((so) =>
        so.isDigital ||
        (getOrderItems(so).length > 0 && getOrderItems(so).every((it: any) => it.isDigital || it.fulfillmentType === 'DIGITAL' || it.fulfillmentType === 'NO_PHYSICAL_DELIVERY'))
      ))
    );

    if (!isDigitalOnlyOrder && sellerOrders.length > 0) {
      const allProductIds: string[] = [];
      for (const so of sellerOrders) {
        for (const item of getOrderItems(so)) {
          if (item.productId) allProductIds.push(item.productId);
        }
      }
      if (allProductIds.length > 0) {
        try {
          const products = await prisma.product.findMany({
            where: { id: { in: allProductIds } },
            select: { id: true, fulfillmentType: true, digitalDeliveryType: true },
          });
          if (products.length === allProductIds.length && products.every((p) => p.fulfillmentType === 'DIGITAL' || Boolean(p.digitalDeliveryType))) {
            isDigitalOnlyOrder = true;
          }
        } catch (_) {}
      }
    }

    if (!isDigitalOnlyOrder && request.buyNowItem?.productId) {
      try {
        const p = await prisma.product.findUnique({
          where: { id: request.buyNowItem.productId },
          select: { id: true, fulfillmentType: true, digitalDeliveryType: true },
        });
        if (p && (p.fulfillmentType === 'DIGITAL' || Boolean(p.digitalDeliveryType))) {
          isDigitalOnlyOrder = true;
        }
      } catch (_) {}
    }

    if (isDigitalOnlyOrder) {
      return {
        deliveryAvailable: true,
        isDigitalOnly: true,
        maxDistanceKm: 0,
        maxRadiusKm: 0,
        sellerQuotes: sellerOrders.map((so) => ({
          deliveryAvailable: true,
          sellerId: so.sellerId,
          storeId: so.storeId,
          storeName: 'التسليم الرقمي',
          distanceKm: 0,
          durationMinutes: 0,
          zoneId: null,
          zoneName: 'التسليم الرقمي',
          baseFee: 0,
          extraSellerFee: 0,
          weightFee: 0,
          slotFee: 0,
          expressFee: 0,
          deliveryDiscount: 0,
          deliveryFee: 0,
          currency: config.marketplace.currency || 'YER',
          pricingVersion: 'digital-v1',
          isExpress: false,
          isDigital: true,
        })),
        totalDeliveryFee: 0,
        currency: config.marketplace.currency || 'YER',
        policy: 'DIGITAL_DELIVERY',
        slotFee: 0,
        storesStatus: [],
        standardAvailable: true,
        scheduledAvailable: false,
        expressAvailable: false,
      };
    }

    // 0. Resolve slot fee for scheduled deliveries
    let slotFee = 0;
    let timeSlot: { id: string; nameAr: string; startTime: string; endTime: string } | null = null;
    let slotWarning: string | undefined;

    if (deliveryScheduleType === 'SCHEDULED') {
      if (deliveryTimeSlotId) {
        const slot = await prisma.deliveryTimeSlot.findUnique({
          where: { id: deliveryTimeSlotId },
          select: { id: true, nameAr: true, startTime: true, endTime: true, slotFee: true },
        });
        if (slot) {
          slotFee = slot.slotFee;
          timeSlot = slot;
        }
        if (deliveryDate) {
          const validation = await deliverySlotService.validateSlot(deliveryTimeSlotId, deliveryDate);
          if (!validation.valid) {
            slotWarning = validation.reason === 'SLOT_FULL'
              ? 'الموعد المحدد ممتلئ لهذا اليوم. يرجى اختيار موعد آخر.'
              : 'هذا الموعد غير متاح لهذا اليوم (قد فات وقته).';
          }
        }
      } else {
        // Fallback: If no specific slot ID is specified yet in preview, resolve the first active scheduled slot fee configured by admin
        const defaultSlot = await prisma.deliveryTimeSlot.findFirst({
          where: { isActive: true },
          orderBy: { priority: 'asc' },
          select: { id: true, nameAr: true, startTime: true, endTime: true, slotFee: true },
        });
        if (defaultSlot) {
          slotFee = defaultSlot.slotFee;
          timeSlot = defaultSlot;
        }
      }
    }

    // 1. Validate customer address
    const address = await prisma.address.findUnique({
      where: { id: customerAddressId },
      include: { city: true },
    });

    if (!address) {
      throw Object.assign(new Error('Customer address not found'), { statusCode: 404 });
    }

    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery');

    const customerAreaMatch = supportedAreasService.isAddressSupported(address);
    let destinationAreaId = requestedDestAreaId || customerAreaMatch.area?.canonicalId;

    if (!destinationAreaId) {
      if (address.latitude && address.longitude) {
        const coordMatch = supportedAreasService.findSupportedAreaByCoordinates(address.latitude, address.longitude, 100.0);
        if (coordMatch.area) {
          destinationAreaId = coordMatch.area.canonicalId;
        }
      }
      if (!destinationAreaId) {
        const cityName = address.city?.nameAr || address.city?.nameEn || (typeof address.city === 'string' ? address.city : '') || '';
        const street = address.street || '';
        const combined = `${cityName} ${street}`.trim();
        if (combined.includes('تعز') || combined.toLowerCase().includes('taiz')) {
          destinationAreaId = 'loc-ye-taiz-al-hawban';
        } else {
          const match = supportedAreasService.matchSupportedArea(combined);
          if (match.area) {
            destinationAreaId = match.area.canonicalId;
          }
        }
      }
    }

    let customerLat = address.latitude ?? address.city?.latitude ?? 15.3694;
    let customerLng = address.longitude ?? address.city?.longitude ?? 44.1910;

    if (destinationAreaId) {
      const explicitArea = STRICTLY_SUPPORTED_AREAS.find((a: any) => a.canonicalId === destinationAreaId);
      if (explicitArea) {
        // If destination area is explicitly requested or differs from the address's native area, use destination coordinates
        if (!address.latitude || !address.longitude || (requestedDestAreaId && requestedDestAreaId !== customerAreaMatch.area?.canonicalId) || (customerAreaMatch.area && customerAreaMatch.area.canonicalId !== destinationAreaId)) {
          customerLat = explicitArea.centerLat;
          customerLng = explicitArea.centerLng;
        }
      }
    }

    if (isCityDiscoveryEnabled && !destinationAreaId) {
      const match = supportedAreasService.isAddressSupported(address);
      if (!match.isSupported) {
        return {
          deliveryAvailable: false,
          reason: 'OUTSIDE_DELIVERY_AREA',
          sellerQuotes: [],
          totalDeliveryFee: 0,
          currency: config.marketplace.currency,
          policy: config.marketplace.multiVendorPolicy,
          slotFee,
          storesStatus: [],
          expressAvailable: false,
          storeWarning: match.rejectionReasonAr || 'عنوان التوصيل المحدد خارج نطاق التوصيل المعتمد حالياً',
        };
      }
    }

    // 2. Batch fetch stores and coordinates to eliminate N+1 database queries
    const storeIds = Array.from(new Set(sellerOrders.map((so) => so.storeId).filter(Boolean)));
    const sellerIds = Array.from(new Set(sellerOrders.map((so) => so.sellerId).filter(Boolean)));

    const stores = await prisma.store.findMany({
      where: {
        OR: [
          ...(storeIds.length > 0 ? [{ id: { in: storeIds } }] : []),
          ...(sellerIds.length > 0 ? [{ sellerId: { in: sellerIds } }] : []),
        ],
      },
      select: {
        id: true,
        sellerId: true,
        name: true,
        latitude: true,
        longitude: true,
        isOpen: true,
        openingTime: true,
        closingTime: true,
        acceptsExpress: true,
        acceptsScheduled: true,
        busyMode: true,
        closedReason: true,
      },
    });

    const storeMap = new Map<string, any>();
    for (const s of stores) {
      storeMap.set(s.id, s);
      if (s.sellerId) storeMap.set(s.sellerId, s);
    }

    const storesStatusList: StoreAvailabilityStatus[] = [];

    const sellerQuotePromises = sellerOrders.map(async (soInput, index) => {
      const {
        sellerId,
        storeId,
        deliveryMethod: itemDeliveryMethod,
        isExpress: itemExpress,
        weightKg,
        lengthCm,
        widthCm,
        heightCm,
        isRemoteArea,
        isSpecialHandling,
        extraSellerFee,
      } = soInput;

      // Authoritative Digital Seller Check (§1, §2):
      // If this seller sub-order only contains digital products, delivery fee is strictly zero.
      const isSellerDigitalOnly = Boolean(
        soInput.isDigital ||
        (soInput.heavyItems && soInput.heavyItems.length > 0 && soInput.heavyItems.every((it) => it.isDigital))
      );

      if (isSellerDigitalOnly) {
        return {
          deliveryAvailable: true,
          sellerId: sellerId || storeMap.get(storeId)?.sellerId || storeMap.get(sellerId)?.sellerId || 'seller',
          storeId: storeId || 'store',
          storeName: storeMap.get(storeId)?.name || 'التسليم الرقمي',
          distanceKm: 0,
          durationMinutes: 0,
          zoneId: null,
          zoneName: 'التسليم الرقمي',
          baseFee: 0,
          extraSellerFee: 0,
          weightFee: 0,
          slotFee: 0,
          expressFee: 0,
          deliveryDiscount: 0,
          deliveryFee: 0,
          currency: config.marketplace.currency || 'YER',
          pricingVersion: 'digital-v1',
          isExpress: false,
          isDigital: true,
        };
      }

      const store = (storeId ? storeMap.get(storeId) : null) || (sellerId ? storeMap.get(sellerId) : null);

      if (store) {
        const status = evaluateStoreAvailability(store);
        storesStatusList.push(status);
      }

      let storeLat = store?.latitude;
      let storeLng = store?.longitude;

      // Default to city center coordinates if not configured
      storeLat = storeLat ?? 15.3500;
      storeLng = storeLng ?? 44.2000;

      const storeAreaMatch = supportedAreasService.findSupportedAreaByCoordinates(storeLat, storeLng, 60.0);
      const originAreaId = storeAreaMatch.area?.canonicalId;

      const sellerIsExpress = typeof itemExpress === 'boolean'
        ? itemExpress
        : (itemDeliveryMethod?.toLowerCase() === 'express' || isExpress);

      // In mixed orders, filter out digital items so only physical items contribute weight and volume
      const physicalHeavyItems = soInput.heavyItems
        ? soInput.heavyItems.filter((it) => !it.isDigital)
        : undefined;

      let effectiveWeightKg = weightKg;
      if (soInput.heavyItems && soInput.heavyItems.length > 0) {
        const physicalWeight = (physicalHeavyItems || []).reduce(
          (sum, it) => sum + ((it.weightKg || it.packageWeightKg || 0) * (it.quantity || 1)),
          0
        );
        effectiveWeightKg = physicalWeight;
      }

      // Slot fee applies once per order when scheduling scope is ORDER (prevent multi-seller duplicate charges)
      const sellerSlotFee = index === 0 ? slotFee : 0;

      const options: DeliveryFeeOptions = {
        isExpress: sellerIsExpress,
        discountAmount,
        discountFundedBy,
        slotFee: sellerSlotFee,
        extraSellerFee: extraSellerFee || 0,
        deliveryMethodCode: itemDeliveryMethod || deliveryMethod || 'intercity_transport',
        originAreaId,
        destinationAreaId,
        weightKg: effectiveWeightKg,
        lengthCm,
        widthCm,
        heightCm,
        isRemoteArea,
        isSpecialHandling,
        heavyItems: physicalHeavyItems,
        accessSurcharge: soInput.accessSurcharge,
        isDigital: false,
      };

      const quote = await deliveryFeeService.calculateFee(
        storeLat, storeLng,
        customerLat, customerLng,
        options,
      );

      return {
        ...quote,
        sellerId: sellerId || store?.sellerId || 'seller',
        storeId: store?.id || storeId || 'store',
        storeName: store?.name || 'مستودع المتجر',
      };
    });

    const sellerQuotes = await Promise.all(sellerQuotePromises);

    // 3. Apply multi-vendor policy
    const multiResult = await deliveryFeeService.calculateMultiVendorFee(
      sellerQuotes,
    );

    // 4. Overall Express and Scheduling availability across participating stores
    const allStoresExpressAvailable = storesStatusList.every((s) => s.expressAvailable);
    const expressDisabledStore = storesStatusList.find((s) => !s.expressAvailable);
    const overallExpressDisabledReason = expressDisabledStore?.expressDisabledReason;

    // Warnings from stores (e.g. store is closed or busy)
    const storeWarnings = storesStatusList.map((s) => s.warningMessage).filter(Boolean);
    const combinedStoreWarning = storeWarnings.length > 0 ? storeWarnings.join(' • ') : undefined;

    const anyDistanceUnavailable = sellerQuotes.some((q) => !q.deliveryAvailable);
    const outsideAreaQuote = sellerQuotes.find((q) => q.reason === 'OUTSIDE_DELIVERY_AREA');

    // Query feature flags in parallel to evaluate isolated method availability
    const [isStandardActive, isScheduledActive, isExpressActive] = await Promise.all([
      RemoteConfigService.getInstance().isFeatureActive('standard_delivery').catch(() => true),
      RemoteConfigService.getInstance().isFeatureActive('scheduled_delivery').catch(() => true),
      RemoteConfigService.getInstance().isFeatureActive('express_delivery').catch(() => true),
    ]);

    const firstInterQuote = sellerQuotes.find((q) => q.isInterGovernorate);
    const isInterGov = Boolean(firstInterQuote);

    const heavyQuotes = sellerQuotes.filter((q) => q.deliveryMode && q.deliveryMode !== 'STANDARD_PARCEL');
    const isHeavyDelivery = heavyQuotes.length > 0;
    const firstHeavyQuote = heavyQuotes[0];
    const requiresManualQuote = sellerQuotes.some((q) => q.requiresManualQuote === true || q.deliveryMode === 'MANUAL_QUOTE');

    // Aggregate sub-shipments across all participating stores for transparent checkout display
    const allSubShipments: DeliverySubShipment[] = [];
    for (const sq of sellerQuotes) {
      if (sq.subShipments && sq.subShipments.length > 0) {
        for (const sub of sq.subShipments) {
          allSubShipments.push({
            ...sub,
            sellerId: sq.sellerId,
            storeId: sq.storeId,
            storeName: sq.storeName,
          });
        }
      }
    }

    const standardShipmentFee = allSubShipments
      .filter((s) => s.shipmentType === 'STANDARD')
      .reduce((sum, s) => sum + s.deliveryFee, 0);

    const heavyShipmentFee = allSubShipments
      .filter((s) => s.shipmentType === 'HEAVY')
      .reduce((sum, s) => sum + s.deliveryFee, 0);

    const hasMixedShipments =
      (standardShipmentFee > 0 && heavyShipmentFee > 0) ||
      sellerQuotes.some((sq) => sq.hasMixedShipments);

    // Isolated method availabilities
    const isPureHeavy = isHeavyDelivery && !hasMixedShipments;
    const isStandardMethodAvailable = !isPureHeavy && !anyDistanceUnavailable && isStandardActive;
    const isScheduledMethodAvailable = !isPureHeavy && !anyDistanceUnavailable && isScheduledActive && storesStatusList.every((s) => s.acceptsScheduled !== false);
    const isExpressMethodAvailable = !isPureHeavy && !anyDistanceUnavailable && isExpressActive && allStoresExpressAvailable;

    // Delivery is available overall as long as address is within service radius
    // and at least one delivery option (or inter-gov route or heavy transport) is available
    const isAvailable = isHeavyDelivery
      ? !anyDistanceUnavailable
      : (isInterGov
          ? !anyDistanceUnavailable
          : (!anyDistanceUnavailable && (isStandardMethodAvailable || isScheduledMethodAvailable || isExpressMethodAvailable)));

    let unavailableReason: string | undefined;

    if (anyDistanceUnavailable) {
      unavailableReason = outsideAreaQuote?.reason || sellerQuotes.find((q) => !q.deliveryAvailable)?.reason || 'DELIVERY_UNAVAILABLE';
    } else if (deliveryScheduleType === 'EXPRESS' && !isExpressMethodAvailable) {
      unavailableReason = overallExpressDisabledReason || 'EXPRESS_UNAVAILABLE';
    } else if (deliveryScheduleType === 'SCHEDULED' && !isScheduledMethodAvailable) {
      unavailableReason = 'SCHEDULED_UNAVAILABLE';
    } else if (!isAvailable) {
      unavailableReason = 'NO_DELIVERY_METHODS_AVAILABLE';
    }

    return {
      deliveryAvailable: isAvailable,
      reason: unavailableReason,
      maxDistanceKm: Math.max(...sellerQuotes.map((q) => q.distanceKm || 0), 0),
      sellerQuotes,
      totalDeliveryFee: multiResult.totalDeliveryFee,
      currency: multiResult.currency,
      policy: multiResult.policy,
      standardAvailable: isStandardMethodAvailable,
      scheduledAvailable: isScheduledMethodAvailable,
      // Heavy & Bulky Delivery top-level metadata
      isHeavyDelivery,
      deliveryMode: firstHeavyQuote?.deliveryMode || 'STANDARD_PARCEL',
      quoteType: firstHeavyQuote?.quoteType || (isHeavyDelivery ? 'AUTOMATIC_QUOTE' : undefined),
      quoteReason: firstHeavyQuote?.quoteReason,
      requiresManualQuote,
      vehicleClass: firstHeavyQuote?.vehicleClass,
      vehicleClassNameAr: firstHeavyQuote?.vehicleClassNameAr,
      vehicleClassNameEn: firstHeavyQuote?.vehicleClassNameEn,
      palletCount: sellerQuotes.reduce((sum, q) => sum + (q.palletCount || 0), 0),
      cargoClassification: firstHeavyQuote?.cargoClassification,
      cargoDescriptionAr: firstHeavyQuote?.cargoDescriptionAr,
      loadingFee: sellerQuotes.reduce((sum, q) => sum + (q.loadingFee || 0), 0),
      unloadingFee: sellerQuotes.reduce((sum, q) => sum + (q.unloadingFee || 0), 0),
      forkliftFee: sellerQuotes.reduce((sum, q) => sum + (q.forkliftFee || 0), 0),
      craneFee: sellerQuotes.reduce((sum, q) => sum + (q.craneFee || 0), 0),
      accessSurcharge: sellerQuotes.reduce((sum, q) => sum + (q.accessSurcharge || 0), 0),
      requiresForklift: sellerQuotes.some((q) => (q.forkliftFee || 0) > 0),
      requiresCrane: sellerQuotes.some((q) => (q.craneFee || 0) > 0),
      heavyAvailable: isHeavyDelivery && !anyDistanceUnavailable,
      // Product-Driven Shipment Breakdown (§Mixed Cart Compatibility)
      hasMixedShipments,
      shipmentCount: allSubShipments.length,
      shipments: allSubShipments,
      standardShipmentFee,
      heavyShipmentFee,
      digitalShipmentFee: 0,
      // Inter-Governorate top-level metadata
      isInterGovernorate: isInterGov,
      routeKey: firstInterQuote?.routeKey,
      routeNameAr: firstInterQuote?.zoneName,
      shippingProvider: firstInterQuote?.shippingProviderName || firstInterQuote?.shippingProviderId,
      allowedDeliveryMethods: isPureHeavy
        ? [
            {
              code: 'heavy_transport',
              nameAr: firstHeavyQuote?.vehicleClassNameAr || 'نقل ثقيل وبضائع ضخمة',
              nameEn: firstHeavyQuote?.vehicleClassNameEn || 'Heavy & Bulky Cargo Transport',
              surcharge: 0,
              isAvailable: !requiresManualQuote,
            },
          ]
        : (firstInterQuote?.allowedDeliveryMethods || []),
      expressSupported: isPureHeavy ? false : (firstInterQuote?.expressSupported ?? false),
      expressSurcharge: firstInterQuote?.expressSurcharge ?? 0,
      carrierCost: firstInterQuote?.carrierCost,
      sellerContribution: firstInterQuote?.sellerContribution,
      marketplaceSubsidy: firstInterQuote?.marketplaceSubsidy,
      estimatedHoursMin: firstInterQuote?.estimatedHoursMin,
      estimatedHoursMax: firstInterQuote?.estimatedHoursMax,
      // Echo scheduled delivery data back to Flutter
      deliveryScheduleType,
      deliveryDate: deliveryDate ?? undefined,
      deliveryTimeSlotId: timeSlot?.id ?? undefined,
      timeSlotNameAr: timeSlot?.nameAr ?? undefined,
      timeSlotStart: timeSlot?.startTime ?? undefined,
      timeSlotEnd: timeSlot?.endTime ?? undefined,
      slotFee,
      slotWarning,
      // Store operational availability metadata
      storesStatus: storesStatusList,
      expressAvailable: isExpressMethodAvailable,
      expressDisabledReason: overallExpressDisabledReason,
      storeWarning: combinedStoreWarning,
    };
  }

  /**

   * Save an immutable delivery quote snapshot at checkout time.
   * §16: Historical orders always use the snapshot — never recalculate.
   */
  async saveSnapshot(
    sellerOrderId: string,
    quote: DeliveryQuoteResult & { sellerId: string },
    scheduleInfo?: {
      deliveryScheduleType?: string;
      deliveryDate?: string;
      timeSlotId?: string;
      timeSlotNameAr?: string;
      timeSlotStart?: string;
      timeSlotEnd?: string;
      actualCustomerDeliveryFee?: number;
      promotionalDiscount?: number;
      discountFundedBy?: string;
    },
  ): Promise<void> {
    if (!quote.deliveryAvailable) return;

    const slotData = scheduleInfo ? {
      deliveryScheduleType: scheduleInfo.deliveryScheduleType,
      deliveryDate: scheduleInfo.deliveryDate ? new Date(scheduleInfo.deliveryDate) : undefined,
      timeSlotId: scheduleInfo.timeSlotId,
      timeSlotNameAr: scheduleInfo.timeSlotNameAr,
      timeSlotStart: scheduleInfo.timeSlotStart,
      timeSlotEnd: scheduleInfo.timeSlotEnd,
    } : {};

    const effectiveFee = scheduleInfo?.actualCustomerDeliveryFee !== undefined
      ? scheduleInfo.actualCustomerDeliveryFee
      : quote.deliveryFee;

    const effectiveDiscount = scheduleInfo?.promotionalDiscount !== undefined && scheduleInfo.promotionalDiscount > 0
      ? Math.max(scheduleInfo.promotionalDiscount, quote.deliveryDiscount)
      : quote.deliveryDiscount;

    const effectiveFundedBy = scheduleInfo?.discountFundedBy || quote.discountFundedBy;

    const interGovSnapshotData = quote.isInterGovernorate ? {
      isInterGovernorate: true,
      routeId: quote.routeId,
      routeKey: quote.routeKey,
      deliveryMethodCode: quote.deliveryMethodCode,
      shippingProvider: quote.shippingProviderName || quote.shippingProviderId,
      actualWeightKg: quote.actualWeightKg,
      volumetricWeightKg: quote.volumetricWeightKg,
      chargeableWeightKg: quote.chargeableWeightKg,
      roadDistanceKm: quote.distanceKm,
      routeBaseFee: quote.routeBaseFee ?? quote.baseFee,
      distanceCharge: quote.distanceCharge ?? 0,
      weightSurcharge: quote.weightSurcharge ?? quote.weightFee,
      oversizedSurcharge: quote.oversizedSurcharge ?? 0,
      deliveryMethodCharge: quote.deliveryMethodCharge ?? quote.extraSellerFee,
      expressCharge: quote.expressFee,
      remoteAreaCharge: quote.remoteAreaCharge ?? 0,
      specialHandlingCharge: quote.specialHandlingCharge ?? 0,
      carrierCost: quote.carrierCost ?? 0,
      sellerContribution: quote.sellerContribution ?? 0,
      marketplaceSubsidy: quote.marketplaceSubsidy ?? 0,
      pricingBreakdownJson: JSON.stringify({
        routeKey: quote.routeKey,
        roadDistanceKm: quote.distanceKm,
        chargeableWeightKg: quote.chargeableWeightKg,
        routeBaseFee: quote.routeBaseFee ?? quote.baseFee,
        distanceCharge: quote.distanceCharge ?? 0,
        weightSurcharge: quote.weightSurcharge ?? quote.weightFee,
        oversizedSurcharge: quote.oversizedSurcharge ?? 0,
        deliveryMethodCharge: quote.deliveryMethodCharge ?? quote.extraSellerFee,
        expressCharge: quote.expressFee,
        remoteAreaCharge: quote.remoteAreaCharge ?? 0,
        specialHandlingCharge: quote.specialHandlingCharge ?? 0,
        carrierCost: quote.carrierCost ?? 0,
        deliveryDiscount: effectiveDiscount,
        finalDeliveryFee: effectiveFee,
      }),
    } : {};

    const heavySnapshotData = {
      deliveryMode: quote.deliveryMode || (quote.isInterGovernorate ? 'HEAVY_INTER_GOVERNORATE' : 'STANDARD_PARCEL'),
      vehicleClass: quote.vehicleClass,
      vehicleClassNameAr: quote.vehicleClassNameAr,
      vehicleClassNameEn: quote.vehicleClassNameEn,
      quoteType: quote.quoteType || 'AUTOMATIC_QUOTE',
      quoteReason: quote.quoteReason,
      palletCount: quote.palletCount,
      loadingFee: quote.loadingFee ?? 0,
      unloadingFee: quote.unloadingFee ?? 0,
      forkliftFee: quote.forkliftFee ?? 0,
      craneFee: quote.craneFee ?? 0,
      accessSurcharge: quote.accessSurcharge ?? 0,
      requiresManualQuote: Boolean(quote.requiresManualQuote),
    };

    await prisma.deliveryQuoteSnapshot.upsert({
      where: { sellerOrderId },
      update: {
        distanceKm: quote.distanceKm,
        durationMinutes: quote.durationMinutes,
        zoneName: quote.zoneName,
        baseFee: quote.baseFee,
        distanceCharge: quote.distanceCharge ?? 0,
        extraSellerFee: quote.extraSellerFee,
        weightFee: quote.weightFee,
        expressFee: quote.expressFee,
        slotFee: quote.slotFee ?? 0,
        deliveryDiscount: effectiveDiscount,
        discountFundedBy: effectiveFundedBy as any,
        deliveryFee: effectiveFee,
        currency: quote.currency,
        pricingVersion: quote.pricingVersion,
        isExpress: quote.isExpress,
        calculatedAt: new Date(),
        zonePricingId: quote.zoneId,
        ...slotData,
        ...interGovSnapshotData,
        ...heavySnapshotData,
      },
      create: {
        sellerOrderId,
        distanceKm: quote.distanceKm,
        durationMinutes: quote.durationMinutes,
        zoneName: quote.zoneName,
        baseFee: quote.baseFee,
        distanceCharge: quote.distanceCharge ?? 0,
        extraSellerFee: quote.extraSellerFee,
        weightFee: quote.weightFee,
        expressFee: quote.expressFee,
        slotFee: quote.slotFee ?? 0,
        deliveryDiscount: effectiveDiscount,
        discountFundedBy: effectiveFundedBy as any,
        deliveryFee: effectiveFee,
        currency: quote.currency,
        pricingVersion: quote.pricingVersion,
        isExpress: quote.isExpress,
        zonePricingId: quote.zoneId,
        ...slotData,
        ...interGovSnapshotData,
        ...heavySnapshotData,
      },
    });

    // Update SellerOrder with distance snapshot and authoritative customer charge (§16)
    // Never overwrite an already discounted customer delivery charge with undiscounted quote.deliveryFee
    await prisma.sellerOrder.update({
      where: { id: sellerOrderId },
      data: {
        distanceKm: quote.distanceKm,
        durationMinutes: quote.durationMinutes,
        deliveryZoneName: quote.zoneName,
        isInterGovernorate: Boolean(quote.isInterGovernorate),
        ...(quote.routeKey ? { interGovernorateRouteKey: quote.routeKey } : {}),
        ...(quote.carrierCost !== undefined ? { carrierCost: quote.carrierCost } : {}),
        ...(quote.shippingProviderName ? { carrierName: quote.shippingProviderName } : {}),
        ...(scheduleInfo?.actualCustomerDeliveryFee !== undefined
          ? { deliveryFee: scheduleInfo.actualCustomerDeliveryFee }
          : {}),
      },
    });
  }
}

export const deliveryQuoteService = new DeliveryQuoteService();
