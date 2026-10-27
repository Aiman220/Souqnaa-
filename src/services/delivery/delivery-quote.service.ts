/**
 * DeliveryQuoteService — orchestrates a full delivery quote from customer + seller inputs.
 * Also persists the immutable snapshot at checkout confirmation (§16).
 */

import { prisma } from '../../database/prisma';
import { deliveryFeeService, type DeliveryFeeOptions, type DeliveryQuoteResult } from './delivery-fee.service';
import { deliverySlotService } from './delivery-slot.service';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SellerOrderInput {
  sellerId: string;
  storeId: string;
  deliveryMethod?: string;
  isExpress?: boolean;
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
  customerAddressId: string;
  sellerOrders: SellerOrderInput[];
  deliveryMethod?: string;
  isExpress?: boolean;
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
  expressAvailable: boolean;
  expressDisabledReason?: string;
  storeWarning?: string;
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
      isExpress = false,
      deliveryScheduleType = 'ASAP',
      deliveryDate,
      deliveryTimeSlotId,
      discountAmount = 0,
      discountFundedBy,
    } = request;

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

    const customerLat = address.latitude ?? address.city?.latitude ?? 15.3694;
    const customerLng = address.longitude ?? address.city?.longitude ?? 44.1910;

    // 2. For each seller, get store coordinates + evaluate availability + calculate quote
    const storesStatusList: StoreAvailabilityStatus[] = [];

    const sellerQuotePromises = sellerOrders.map(async ({ sellerId, storeId, deliveryMethod: itemDeliveryMethod, isExpress: itemExpress }) => {
      let store = storeId ? await prisma.store.findUnique({ where: { id: storeId } }) : null;
      if (!store && sellerId) {
        store = await prisma.store.findFirst({ where: { sellerId } });
      }

      if (store) {
        const status = evaluateStoreAvailability(store);
        storesStatusList.push(status);
      }

      let storeLat = store?.latitude;
      let storeLng = store?.longitude;

      if ((!storeLat || !storeLng) && store) {
        const storeAddr = await prisma.address.findFirst({ where: { storeId: store.id } });
        if (storeAddr?.latitude && storeAddr?.longitude) {
          storeLat = storeAddr.latitude;
          storeLng = storeAddr.longitude;
        }
      }

      // Default to city center coordinates if not configured
      storeLat = storeLat ?? 15.3500;
      storeLng = storeLng ?? 44.2000;

      const sellerIsExpress = typeof itemExpress === 'boolean'
        ? itemExpress
        : (itemDeliveryMethod?.toLowerCase() === 'express' || isExpress);

      const options: DeliveryFeeOptions = {
        isExpress: sellerIsExpress,
        discountAmount,
        discountFundedBy,
        slotFee, // applied per seller quote
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

    // Check if requested method violates store constraints
    let isAvailable = !anyDistanceUnavailable;
    let unavailableReason: string | undefined;

    if (anyDistanceUnavailable) {
      unavailableReason = outsideAreaQuote?.reason || sellerQuotes.find((q) => !q.deliveryAvailable)?.reason || 'DELIVERY_UNAVAILABLE';
    } else if (deliveryScheduleType === 'EXPRESS' && !allStoresExpressAvailable) {
      isAvailable = false;
      unavailableReason = 'EXPRESS_UNAVAILABLE';
    }

    return {
      deliveryAvailable: isAvailable,
      reason: unavailableReason,
      maxDistanceKm: Math.max(...sellerQuotes.map((q) => q.distanceKm || 0), 0),
      sellerQuotes,
      totalDeliveryFee: multiResult.totalDeliveryFee,
      currency: multiResult.currency,
      policy: multiResult.policy,
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
      expressAvailable: allStoresExpressAvailable,
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
      ? (quote.deliveryDiscount + scheduleInfo.promotionalDiscount)
      : quote.deliveryDiscount;

    const effectiveFundedBy = scheduleInfo?.discountFundedBy || quote.discountFundedBy;

    await prisma.deliveryQuoteSnapshot.upsert({
      where: { sellerOrderId },
      update: {
        distanceKm: quote.distanceKm,
        durationMinutes: quote.durationMinutes,
        zoneName: quote.zoneName,
        baseFee: quote.baseFee,
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
      },
      create: {
        sellerOrderId,
        distanceKm: quote.distanceKm,
        durationMinutes: quote.durationMinutes,
        zoneName: quote.zoneName,
        baseFee: quote.baseFee,
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
        ...(scheduleInfo?.actualCustomerDeliveryFee !== undefined
          ? { deliveryFee: scheduleInfo.actualCustomerDeliveryFee }
          : {}),
      },
    });
  }
}

export const deliveryQuoteService = new DeliveryQuoteService();
