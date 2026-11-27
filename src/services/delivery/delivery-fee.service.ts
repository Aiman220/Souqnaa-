/**
 * DeliveryFeeService — authoritative delivery fee calculation engine.
 *
 * §13: Delivery Fee = Zone Base Fee + Extra Seller Fee + Weight/Size Fee + Express Fee - Discount
 * §33: Flutter NEVER determines delivery fee, distance, zone, or discount.
 *       All authoritative values come from this service.
 */

import { prisma } from '../../database/prisma';
import { config } from '../../config';
import { geoService } from '../geo/geo.service';
import type { GeoCoordinates } from '../geo/providers/map.provider';
import { interGovernorateRouteService } from './inter-governorate-route.service';
import { supportedAreasService } from '../../modules/locations/supported-areas.service';
import {
  heavyDeliveryService,
  type HeavyProductShippingInput,
  type DeliveryCalculationMode,
  type QuoteType,
  type HeavyCargoClassification,
  type DeliverySubShipment,
  type ShipmentPartitionResult,
} from './heavy-delivery.service';
import type { FreightBillingUnitCode } from '../units/unit-conversion.service';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeOptions {
  isExpress?: boolean;
  extraSellerFee?: number;
  weightKg?: number;
  weightFeePerKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  slotFee?: number;          // time-slot surcharge from DeliveryTimeSlot.slotFee
  discountAmount?: number;
  discountFundedBy?: 'MARKETPLACE' | 'SELLER' | 'COUPON';
  deliveryMethodCode?: string;
  originAreaId?: string;
  destinationAreaId?: string;
  isRemoteArea?: boolean;
  isSpecialHandling?: boolean;
  heavyItems?: HeavyProductShippingInput[];
  accessSurcharge?: number;
  isDigital?: boolean;
  freightBillingUnit?: FreightBillingUnitCode;
  freightRatePerUnit?: number;
}

export interface SellerDeliveryQuote {
  sellerId: string;
  sellerLat: number;
  sellerLng: number;
  customerLat: number;
  customerLng: number;
  options?: DeliveryFeeOptions;
}

export interface DeliveryQuoteResult {
  deliveryAvailable: boolean;
  reason?: string; // OUTSIDE_DELIVERY_AREA | NO_ROUTE_FOUND | PROVIDER_UNAVAILABLE | ROUTE_NOT_SERVICEABLE | MANUAL_QUOTE_REQUIRED

  distanceKm: number;
  durationMinutes: number;

  zoneId: string | null;
  zoneName: string;

  baseFee: number;
  extraSellerFee: number;
  weightFee: number;
  slotFee: number;           // time-slot surcharge (0 for ASAP/Express)
  expressFee: number;
  deliveryDiscount: number;
  discountFundedBy?: string;

  deliveryFee: number; // final amount
  currency: string;
  pricingVersion: string;
  isExpress: boolean;
  isDigital?: boolean;

  // Heavy & Bulky Delivery Engine Extensions
  deliveryMode?: DeliveryCalculationMode;
  quoteType?: QuoteType;
  quoteReason?: string;
  requiresManualQuote?: boolean;
  vehicleClass?: string;
  vehicleClassNameAr?: string;
  vehicleClassNameEn?: string;
  palletCount?: number;
  tripsCount?: number;
  loadingFee?: number;
  unloadingFee?: number;
  forkliftFee?: number;
  craneFee?: number;
  accessSurcharge?: number;
  mandatorySpecialHandlingFee?: number;
  cargoClassification?: HeavyCargoClassification;
  cargoDescriptionAr?: string;
  isHeavyDelivery?: boolean;
  hasMixedShipments?: boolean;
  subShipments?: DeliverySubShipment[];
  freightBillingUnit?: FreightBillingUnitCode;
  freightBillingCharge?: number;

  // Inter-Governorate route & pricing details
  isInterGovernorate?: boolean;
  routeId?: string;
  routeKey?: string;
  deliveryMethodCode?: string;
  shippingProviderId?: string;
  shippingProviderName?: string;
  actualWeightKg?: number;
  volumetricWeightKg?: number;
  chargeableWeightKg?: number;
  routeBaseFee?: number;
  distanceCharge?: number;
  weightSurcharge?: number;
  oversizedSurcharge?: number;
  deliveryMethodCharge?: number;
  remoteAreaCharge?: number;
  specialHandlingCharge?: number;
  carrierCost?: number;
  sellerContribution?: number;
  marketplaceSubsidy?: number;
  estimatedHoursMin?: number;
  estimatedHoursMax?: number;
  expressSupported?: boolean;
  expressSurcharge?: number;
  allowedDeliveryMethods?: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    surcharge: number;
    isAvailable?: boolean;
    estimatedHoursMin?: number;
    estimatedHoursMax?: number;
  }>;
}

export interface MultiVendorDeliveryResult {
  sellerQuotes: (DeliveryQuoteResult & { sellerId: string })[];
  totalDeliveryFee: number;
  currency: string;
  policy: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Pricing version — updated whenever admin changes zone prices
// ──────────────────────────────────────────────────────────────────────────────

function getPricingVersion(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${today}-v1`;
}

// ──────────────────────────────────────────────────────────────────────────────
// In-memory quote & distance cache
// ──────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: DeliveryQuoteResult;
  expiresAt: number;
}

interface DistanceCacheEntry {
  distanceKm: number;
  durationMinutes: number;
  expiresAt: number;
}

const _quoteCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const _distanceCache = new Map<string, DistanceCacheEntry>();
const DISTANCE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour coordinate distance cache

export function buildCacheKey(
  sellerLat: number, sellerLng: number,
  customerLat: number, customerLng: number,
  isExpress: boolean, pricingVersion: string,
  slotFee: number = 0,
  methodCode: string = '',
  destAreaId: string = '',
  extraSellerFee: number = 0,
  weightKg: number = 0,
  discountAmount: number = 0,
  originAreaId: string = '',
  itemsFingerprint: string = '',
): string {
  return `${sellerLat.toFixed(4)},${sellerLng.toFixed(4)}|${customerLat.toFixed(4)},${customerLng.toFixed(4)}|orig=${originAreaId}|dest=${destAreaId}|m=${methodCode}|express=${isExpress}|slotFee=${slotFee}|extraSellerFee=${extraSellerFee}|w=${weightKg}|disc=${discountAmount}|items=${itemsFingerprint}|v=${pricingVersion}`;
}

function getCached(key: string): DeliveryQuoteResult | null {
  const entry = _quoteCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _quoteCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(key: string, result: DeliveryQuoteResult): void {
  _quoteCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ──────────────────────────────────────────────────────────────────────────────
// Core engine
// ──────────────────────────────────────────────────────────────────────────────

export class DeliveryFeeService {
  public buildCacheKey = buildCacheKey;
  private _zonesCache: { data: any[]; expiresAt: number } | null = null;

  /**
   * Calculate driving distance + duration between two coordinate pairs.
   * Uses high-speed memory cache, bounded Geoapify routing with 1.5s timeout,
   * and geodesic road distance fallback.
   */
  async calculateDistance(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<{ distanceKm: number; durationMinutes: number }> {
    const distKey = `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}->${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
    const cachedDist = _distanceCache.get(distKey);
    if (cachedDist && Date.now() < cachedDist.expiresAt) {
      return { distanceKm: cachedDist.distanceKm, durationMinutes: cachedDist.durationMinutes };
    }

    try {
      if (geoService.isConfigured()) {
        // Strict 1500ms timeout for Geoapify routing so international latency never delays checkout
        const routePromise = geoService.routing().getDrivingRoute(origin, destination);
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('GEO_TIMEOUT')), 1500)
        );

        const route = await Promise.race([routePromise, timeoutPromise]);
        if (route && route.distanceKm > 0) {
          const res = {
            distanceKm: Math.max(0.3, Math.round(route.distanceKm * 100) / 100),
            durationMinutes: route.durationMinutes,
          };
          _distanceCache.set(distKey, { ...res, expiresAt: Date.now() + DISTANCE_CACHE_TTL_MS });
          return res;
        }
      }
    } catch {
      // Fallback quickly on timeout or error
    }

    // Geodesic driving distance with 1.25x road curvature factor
    const R = 6371; // Earth radius in km
    const dLat = (destination.lat - origin.lat) * (Math.PI / 180);
    const dLon = (destination.lng - origin.lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(origin.lat * (Math.PI / 180)) * Math.cos(destination.lat * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const directKm = R * c;
    const distanceKm = Math.max(0.3, Math.round(directKm * 1.25 * 100) / 100);
    const durationMinutes = Math.round((distanceKm / 25) * 60) + 5;

    const res = { distanceKm, durationMinutes };
    _distanceCache.set(distKey, { ...res, expiresAt: Date.now() + DISTANCE_CACHE_TTL_MS });
    return res;
  }

  /**
   * Determine which pricing zone a given distance falls into.
   * Zones are loaded from DeliveryZonePricing with 60s in-memory caching.
   */
  async determineZone(distanceKm: number): Promise<{
    zoneId: string | null;
    zoneName: string;
    minDistanceKm: number;
    baseFee: number;
    extraFeePerKm: number;
    currency: string;
  } | null> {
    if (!this._zonesCache || Date.now() > this._zonesCache.expiresAt) {
      const zones = await prisma.deliveryZonePricing.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      });
      this._zonesCache = { data: zones, expiresAt: Date.now() + 60_000 };
    }

    const zones = this._zonesCache.data;
    for (const zone of zones) {
      const minOk = distanceKm >= zone.minDistanceKm;
      const maxOk = zone.maxDistanceKm === null || distanceKm < zone.maxDistanceKm;
      if (minOk && maxOk) {
        return {
          zoneId: zone.id,
          zoneName: zone.nameAr || zone.name,
          minDistanceKm: zone.minDistanceKm,
          baseFee: zone.baseFee,
          extraFeePerKm: zone.extraFeePerKm,
          currency: zone.currency,
        };
      }
    }

    return null; // distance exceeds all configured zones
  }

  /**
   * Calculate the full delivery fee for a single seller→customer pair.
   * §33: This is the authoritative calculation. Flutter displays the result.
   */
  async calculateFee(
    sellerLat: number, sellerLng: number,
    customerLat: number, customerLng: number,
    options: DeliveryFeeOptions = {},
  ): Promise<DeliveryQuoteResult> {
    // Authoritative Digital Product Zero-Fee Enforcement (§1, §33)
    // Digital products must NEVER incur shipping or delivery fees, regardless of weight, express, or distance.
    const isDigitalOrder = Boolean(
      options.isDigital ||
      (options.heavyItems && options.heavyItems.length > 0 && options.heavyItems.every((it) => it.isDigital))
    );

    if (isDigitalOrder) {
      return {
        deliveryAvailable: true,
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

    const {
      isExpress = false,
      extraSellerFee = 0,
      weightKg = 0,
      weightFeePerKg = 0,
      slotFee = 0,
      discountAmount = 0,
      discountFundedBy,
    } = options;

    // 1.1 Inter-Governorate Route Check
    let originAreaId = options.originAreaId;
    let destAreaId = options.destinationAreaId;

    if (!originAreaId) {
      const match = supportedAreasService.findSupportedAreaByCoordinates(sellerLat, sellerLng, 60.0);
      originAreaId = match.area?.canonicalId;
    }
    if (!destAreaId) {
      const match = supportedAreasService.findSupportedAreaByCoordinates(customerLat, customerLng, 60.0);
      destAreaId = match.area?.canonicalId;
    }

    const itemsFingerprint = options.heavyItems && options.heavyItems.length > 0
      ? options.heavyItems.map((it) => `${it.productId || ''}:${it.quantity || 1}:${it.weightKg || ''}:${it.lengthCm || ''}x${it.widthCm || ''}x${it.heightCm || ''}:${it.sellingUnit || ''}`).join(';')
      : '';

    const pricingVersion = getPricingVersion();
    const cacheKey = buildCacheKey(
      sellerLat,
      sellerLng,
      customerLat,
      customerLng,
      isExpress,
      pricingVersion,
      slotFee,
      options.deliveryMethodCode || '',
      destAreaId || '',
      extraSellerFee,
      weightKg,
      discountAmount,
      originAreaId || '',
      itemsFingerprint,
    );

    // Check cache (§30)
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const currency = config.marketplace.currency;

    // 1. Calculate route distance
    let distanceKm: number;
    let durationMinutes: number;

    try {
      const route = await this.calculateDistance(
        { lat: sellerLat, lng: sellerLng },
        { lat: customerLat, lng: customerLng },
      );
      distanceKm = route.distanceKm;
      durationMinutes = route.durationMinutes;
    } catch (err: any) {
      // §31 §35: Return controlled error, do not invent a distance
      const isNoRoute = err?.code === 'NO_ROUTE_FOUND';
      return {
        deliveryAvailable: false,
        reason: isNoRoute ? 'NO_ROUTE_FOUND' : 'PROVIDER_UNAVAILABLE',
        distanceKm: 0,
        durationMinutes: 0,
        zoneId: null,
        zoneName: '',
        baseFee: 0,
        extraSellerFee: 0,
        weightFee: 0,
        slotFee: 0,
        expressFee: 0,
        deliveryDiscount: 0,
        deliveryFee: 0,
        currency,
        pricingVersion,
        isExpress,
      };
    }

    const isDifferentAreas = Boolean(originAreaId && destAreaId && originAreaId !== destAreaId);

    // 1.2 Product-Driven Shipment Partitioning & Heavy Cargo Logistics Evaluation (§2 - §6)
    // Filter out any digital items from heavy cargo and weight evaluation
    const physicalHeavyItems = options.heavyItems && options.heavyItems.length > 0
      ? options.heavyItems.filter((it) => !it.isDigital)
      : undefined;

    // Check if shipment has mixed products requiring independent calculation
    if (physicalHeavyItems && physicalHeavyItems.length > 1) {
      const partition = heavyDeliveryService.partitionShipment(physicalHeavyItems);
      if (partition.hasMixedShipments && partition.heavyItems.length > 0 && partition.standardItems.length > 0) {
        // Mixed Cart Detected: Calculate each shipment independently!
        // 1. Heavy sub-shipment
        let mixedRouteObj: any = null;
        let mixedDistanceKm = distanceKm;
        if (isDifferentAreas && originAreaId && destAreaId) {
          mixedRouteObj = await interGovernorateRouteService.resolveRoute(originAreaId, destAreaId);
          if (mixedRouteObj) {
            const roadInfo = await interGovernorateRouteService.getRoadDistance(
              { lat: sellerLat, lng: sellerLng },
              { lat: customerLat, lng: customerLng },
              mixedRouteObj.roadDistanceKm,
            );
            mixedDistanceKm = roadInfo.roadDistanceKm;
          }
        }

        const heavyCargo = heavyDeliveryService.analyzeShipmentCargo(partition.heavyItems);
        const vehicleMatch = await heavyDeliveryService.matchVehicle(heavyCargo);
        const heavyPricing = await heavyDeliveryService.calculateHeavyPricing(heavyCargo, vehicleMatch, {
          distanceKm: mixedDistanceKm,
          isInterGovernorate: isDifferentAreas,
          originGovernorate: originAreaId,
          destinationGovernorate: destAreaId,
          route: mixedRouteObj,
          accessSurcharge: options.accessSurcharge,
          extraSellerFee: 0,
          discountAmount: 0,
          freightBillingUnit: options.freightBillingUnit,
          freightRatePerUnit: options.freightRatePerUnit,
        });

        // 2. Standard sub-shipment (call calculateFee for standard items)
        const standardResult = await this.calculateFee(
          sellerLat, sellerLng,
          customerLat, customerLng,
          {
            ...options,
            heavyItems: partition.standardItems,
            weightKg: partition.standardItems.reduce((s, it) => s + ((it.weightKg || it.packageWeightKg || 0) * (it.quantity || 1)), 0),
          }
        );

        const standardSubShipment: DeliverySubShipment = {
          id: `sub_std_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          shipmentType: 'STANDARD',
          titleAr: 'شحنة الطرود العادية',
          titleEn: 'Standard Parcel Shipment',
          items: partition.standardItems.map((it) => ({
            productId: it.productId,
            name: it.name,
            quantity: it.quantity,
            weightKg: it.weightKg || undefined,
            sellingUnit: it.sellingUnit || undefined,
            isDigital: false,
          })),
          totalWeightKg: partition.standardItems.reduce((s, it) => s + ((it.weightKg || it.packageWeightKg || 0) * (it.quantity || 1)), 0),
          deliveryFee: standardResult.deliveryFee,
          baseFee: standardResult.baseFee,
          distanceCharge: standardResult.extraSellerFee,
          handlingFee: standardResult.weightFee,
          deliveryMode: standardResult.deliveryMode || 'STANDARD_PARCEL',
          allowedDeliveryMethods: standardResult.allowedDeliveryMethods || [
            { code: 'standard', nameAr: 'توصيل عادي', nameEn: 'Standard Delivery', surcharge: 0, isAvailable: true },
          ],
        };

        const heavySubShipment: DeliverySubShipment = {
          id: `sub_hvy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          shipmentType: 'HEAVY',
          titleAr: `شحنة النقل الثقيل والخاص (${heavyPricing.vehicleNameAr})`,
          titleEn: `Heavy & Special Freight (${heavyPricing.vehicleNameEn})`,
          items: partition.heavyItems.map((it) => ({
            productId: it.productId,
            name: it.name,
            quantity: it.quantity,
            weightKg: it.weightKg || undefined,
            sellingUnit: it.sellingUnit || undefined,
            isDigital: false,
          })),
          totalWeightKg: heavyCargo.totalActualWeightKg,
          deliveryFee: heavyPricing.finalDeliveryFee,
          baseFee: heavyPricing.baseFee,
          distanceCharge: heavyPricing.distanceCharge,
          handlingFee: heavyPricing.loadingFee + heavyPricing.unloadingFee + heavyPricing.forkliftFee + heavyPricing.craneFee + heavyPricing.specialHandlingFee,
          deliveryMode: heavyPricing.deliveryMode,
          quoteType: heavyPricing.quoteType,
          requiresManualQuote: heavyPricing.requiresManualQuote,
          quoteReason: heavyPricing.quoteReason,
          vehicleCode: heavyPricing.vehicleCode,
          vehicleNameAr: heavyPricing.vehicleNameAr,
          vehicleNameEn: heavyPricing.vehicleNameEn,
          palletCount: heavyPricing.palletCount,
          requiresForklift: heavyCargo.requiresForklift,
          requiresCrane: heavyCargo.requiresCrane,
          allowedDeliveryMethods: [
            { code: 'heavy_transport', nameAr: heavyPricing.vehicleNameAr, nameEn: heavyPricing.vehicleNameEn, surcharge: 0, isAvailable: !heavyPricing.requiresManualQuote },
          ],
        };

        const totalMixedFee = standardResult.deliveryFee + heavyPricing.finalDeliveryFee;

        const mixedResult: DeliveryQuoteResult = {
          deliveryAvailable: standardResult.deliveryAvailable && (heavyPricing.requiresManualQuote || heavyPricing.finalDeliveryFee >= 0),
          reason: heavyPricing.requiresManualQuote ? (heavyPricing.quoteReason || 'MANUAL_QUOTE_REQUIRED') : standardResult.reason,
          distanceKm,
          durationMinutes: Math.max(standardResult.durationMinutes, isDifferentAreas ? Math.round((distanceKm / 45) * 60) + 15 : durationMinutes),
          zoneId: standardResult.zoneId,
          zoneName: isDifferentAreas
            ? `${originAreaId || 'المصدر'} إلى ${destAreaId || 'الوجهة'} (${heavyPricing.vehicleNameAr} + شحن قياسي)`
            : `${standardResult.zoneName || 'توصيل قياسي'} + ${heavyPricing.vehicleNameAr}`,
          baseFee: standardResult.baseFee + heavyPricing.baseFee,
          extraSellerFee: standardResult.extraSellerFee + heavyPricing.distanceCharge,
          weightFee: standardResult.weightFee + heavyPricing.specialHandlingFee,
          slotFee: standardResult.slotFee,
          expressFee: standardResult.expressFee,
          deliveryDiscount: standardResult.deliveryDiscount + heavyPricing.deliveryDiscount,
          discountFundedBy,
          deliveryFee: totalMixedFee,
          currency,
          pricingVersion,
          isExpress: false,
          isInterGovernorate: isDifferentAreas,
          deliveryMode: heavyPricing.deliveryMode,
          quoteType: heavyPricing.quoteType,
          quoteReason: heavyPricing.quoteReason,
          requiresManualQuote: heavyPricing.requiresManualQuote,
          vehicleClass: heavyPricing.vehicleCode,
          vehicleClassNameAr: heavyPricing.vehicleNameAr,
          vehicleClassNameEn: heavyPricing.vehicleNameEn,
          palletCount: heavyPricing.palletCount,
          loadingFee: heavyPricing.loadingFee,
          unloadingFee: heavyPricing.unloadingFee,
          forkliftFee: heavyPricing.forkliftFee,
          craneFee: heavyPricing.craneFee,
          accessSurcharge: heavyPricing.accessSurcharge,
          cargoClassification: heavyCargo.classification,
          cargoDescriptionAr: `${standardSubShipment.titleAr} + ${heavySubShipment.titleAr}`,
          hasMixedShipments: true,
          subShipments: [standardSubShipment, heavySubShipment],
          freightBillingUnit: heavyPricing.freightBillingUnit,
          freightBillingCharge: heavyPricing.freightBillingCharge,
        };

        setCached(cacheKey, mixedResult);
        return mixedResult;
      }
    }

    const itemsToAnalyze: HeavyProductShippingInput[] = physicalHeavyItems && physicalHeavyItems.length > 0
      ? physicalHeavyItems
      : [
          {
            quantity: 1,
            weightKg: options.weightKg || 0,
            lengthCm: options.lengthCm || 0,
            widthCm: options.widthCm || 0,
            heightCm: options.heightCm || 0,
            isSpecialHandling: options.isSpecialHandling,
          },
        ];

    const cargo = heavyDeliveryService.analyzeShipmentCargo(itemsToAnalyze);

    if (cargo.isHeavyOrBulky) {
      let routeObj: any = null;
      let effectiveDistanceKm = distanceKm;
      if (isDifferentAreas && originAreaId && destAreaId) {
        routeObj = await interGovernorateRouteService.resolveRoute(originAreaId, destAreaId);
        if (routeObj) {
          const roadInfo = await interGovernorateRouteService.getRoadDistance(
            { lat: sellerLat, lng: sellerLng },
            { lat: customerLat, lng: customerLng },
            routeObj.roadDistanceKm,
          );
          effectiveDistanceKm = roadInfo.roadDistanceKm;
        }
      }

      const vehicleMatch = await heavyDeliveryService.matchVehicle(cargo);
      const heavyPricing = await heavyDeliveryService.calculateHeavyPricing(cargo, vehicleMatch, {
        distanceKm: effectiveDistanceKm,
        isInterGovernorate: isDifferentAreas,
        originGovernorate: originAreaId,
        destinationGovernorate: destAreaId,
        route: routeObj,
        accessSurcharge: options.accessSurcharge,
        extraSellerFee,
        discountAmount,
        freightBillingUnit: options.freightBillingUnit,
        freightRatePerUnit: options.freightRatePerUnit,
      });

      const heavySubShipment: DeliverySubShipment = {
        id: `sub_hvy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        shipmentType: 'HEAVY',
        titleAr: `شحنة النقل الثقيل والخاص (${heavyPricing.vehicleNameAr})`,
        titleEn: `Heavy & Special Freight (${heavyPricing.vehicleNameEn})`,
        items: itemsToAnalyze.map((it) => ({
          productId: it.productId,
          name: it.name,
          quantity: it.quantity,
          weightKg: it.weightKg || undefined,
          sellingUnit: it.sellingUnit || undefined,
          isDigital: false,
        })),
        totalWeightKg: cargo.totalActualWeightKg,
        deliveryFee: heavyPricing.finalDeliveryFee,
        baseFee: heavyPricing.baseFee,
        distanceCharge: heavyPricing.distanceCharge,
        handlingFee: heavyPricing.loadingFee + heavyPricing.unloadingFee + heavyPricing.forkliftFee + heavyPricing.craneFee + heavyPricing.specialHandlingFee,
        deliveryMode: heavyPricing.deliveryMode,
        quoteType: heavyPricing.quoteType,
        requiresManualQuote: heavyPricing.requiresManualQuote,
        quoteReason: heavyPricing.quoteReason,
        vehicleCode: heavyPricing.vehicleCode,
        vehicleNameAr: heavyPricing.vehicleNameAr,
        vehicleNameEn: heavyPricing.vehicleNameEn,
        palletCount: heavyPricing.palletCount,
        requiresForklift: cargo.requiresForklift,
        requiresCrane: cargo.requiresCrane,
        allowedDeliveryMethods: [
          { code: 'heavy_transport', nameAr: heavyPricing.vehicleNameAr, nameEn: heavyPricing.vehicleNameEn, surcharge: 0, isAvailable: !heavyPricing.requiresManualQuote },
        ],
      };

      const heavyResult: DeliveryQuoteResult = {
        deliveryAvailable: !heavyPricing.requiresManualQuote,
        reason: heavyPricing.requiresManualQuote ? (heavyPricing.quoteReason || 'MANUAL_QUOTE_REQUIRED') : undefined,
        distanceKm: effectiveDistanceKm,
        durationMinutes: isDifferentAreas ? Math.round((effectiveDistanceKm / 45) * 60) + 15 : durationMinutes,
        zoneId: null,
        zoneName: isDifferentAreas
          ? `${originAreaId || 'المصدر'} إلى ${destAreaId || 'الوجهة'} (${heavyPricing.vehicleNameAr})`
          : heavyPricing.vehicleNameAr,
        baseFee: heavyPricing.baseFee,
        distanceCharge: heavyPricing.distanceCharge,
        extraSellerFee: extraSellerFee || 0,
        weightFee: heavyPricing.specialHandlingFee,
        slotFee,
        expressFee: 0,
        deliveryDiscount: heavyPricing.deliveryDiscount,
        discountFundedBy,
        deliveryFee: heavyPricing.finalDeliveryFee,
        currency,
        pricingVersion,
        isExpress: false,
        isInterGovernorate: isDifferentAreas,
        routeId: isDifferentAreas ? (heavyPricing.routeId || routeObj?.id) : undefined,
        routeKey: isDifferentAreas && originAreaId && destAreaId ? `${originAreaId}:${destAreaId}` : undefined,
        deliveryMode: heavyPricing.deliveryMode,
        quoteType: heavyPricing.quoteType,
        quoteReason: heavyPricing.quoteReason,
        requiresManualQuote: heavyPricing.requiresManualQuote,
        vehicleClass: heavyPricing.vehicleCode,
        vehicleClassNameAr: heavyPricing.vehicleNameAr,
        vehicleClassNameEn: heavyPricing.vehicleNameEn,
        palletCount: heavyPricing.palletCount,
        tripsCount: heavyPricing.tripsCount,
        loadingFee: heavyPricing.loadingFee,
        unloadingFee: heavyPricing.unloadingFee,
        forkliftFee: heavyPricing.forkliftFee,
        craneFee: heavyPricing.craneFee,
        accessSurcharge: heavyPricing.accessSurcharge,
        mandatorySpecialHandlingFee: heavyPricing.mandatorySpecialHandlingFee,
        cargoClassification: cargo.classification,
        cargoDescriptionAr: cargo.cargoDescriptionAr,
        isHeavyDelivery: true,
        allowedDeliveryMethods: [
          {
            code: 'heavy_transport',
            nameAr: heavyPricing.vehicleNameAr,
            nameEn: heavyPricing.vehicleNameEn,
            surcharge: 0,
            isAvailable: !heavyPricing.requiresManualQuote,
          },
        ],
        hasMixedShipments: false,
        subShipments: [heavySubShipment],
        freightBillingUnit: heavyPricing.freightBillingUnit,
        freightBillingCharge: heavyPricing.freightBillingCharge,
      };

      setCached(cacheKey, heavyResult);
      return heavyResult;
    }

    if (isDifferentAreas) {
      const isInterEnabled = await interGovernorateRouteService.isInterGovernorateEnabled();
      if (!isInterEnabled) {
        return {
          deliveryAvailable: false,
          reason: 'INTER_GOVERNORATE_DISABLED',
          distanceKm,
          durationMinutes,
          zoneId: null,
          zoneName: 'الشحن بين المحافظات غير مفعل حالياً',
          baseFee: 0,
          extraSellerFee: 0,
          weightFee: 0,
          slotFee: 0,
          expressFee: 0,
          deliveryDiscount: 0,
          deliveryFee: 0,
          currency,
          pricingVersion,
          isExpress,
        };
      }

      try {
        const interPricing = await interGovernorateRouteService.calculatePricing({
          originAreaId: originAreaId!,
          destinationAreaId: destAreaId!,
          originCoords: { lat: sellerLat, lng: sellerLng },
          destinationCoords: { lat: customerLat, lng: customerLng },
          deliveryMethodCode: options.deliveryMethodCode,
          isExpress,
          actualWeightKg: options.weightKg || 1.0,
          packageDimensions: {
            lengthCm: options.lengthCm,
            widthCm: options.widthCm,
            heightCm: options.heightCm,
          },
          isRemoteArea: options.isRemoteArea,
          isSpecialHandling: options.isSpecialHandling,
          discountAmount,
          discountFundedBy,
        });

        const stdSubShipment: DeliverySubShipment = {
          id: `sub_std_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          shipmentType: 'STANDARD',
          titleAr: 'شحنة الطرود بين المحافظات',
          titleEn: 'Inter-Governorate Parcel Shipment',
          items: itemsToAnalyze.map((it) => ({
            productId: it.productId,
            name: it.name,
            quantity: it.quantity,
            weightKg: it.weightKg || undefined,
            sellingUnit: it.sellingUnit || undefined,
            isDigital: false,
          })),
          totalWeightKg: interPricing.actualWeightKg,
          deliveryFee: interPricing.finalDeliveryFee,
          baseFee: interPricing.routeBaseFee,
          distanceCharge: interPricing.distanceCharge,
          handlingFee: interPricing.weightSurcharge + interPricing.oversizedSurcharge + interPricing.specialHandlingCharge,
          deliveryMode: 'STANDARD_PARCEL',
          allowedDeliveryMethods: (interPricing.allowedDeliveryMethods || []).map((m: any) => ({
            code: m.code,
            nameAr: m.nameAr,
            nameEn: m.nameEn,
            surcharge: m.surcharge,
            isAvailable: true,
          })),
        };

        const result: DeliveryQuoteResult = {
          deliveryAvailable: true,
          distanceKm: interPricing.roadDistanceKm,
          durationMinutes: Math.round((interPricing.roadDistanceKm / 45) * 60) + 15,
          zoneId: null,
          zoneName: interPricing.routeNameAr,
          baseFee: interPricing.routeBaseFee,
          extraSellerFee: interPricing.deliveryMethodCharge,
          weightFee: interPricing.weightSurcharge,
          slotFee,
          expressFee: interPricing.expressCharge,
          deliveryDiscount: interPricing.deliveryDiscount,
          discountFundedBy,
          deliveryFee: interPricing.finalDeliveryFee,
          currency,
          pricingVersion: interPricing.pricingVersion,
          isExpress,
          isInterGovernorate: true,
          routeId: interPricing.routeId,
          routeKey: interPricing.routeKey,
          deliveryMethodCode: interPricing.deliveryMethodCode,
          shippingProviderId: interPricing.shippingProviderId,
          shippingProviderName: interPricing.shippingProviderName,
          actualWeightKg: interPricing.actualWeightKg,
          volumetricWeightKg: interPricing.volumetricWeightKg,
          chargeableWeightKg: interPricing.chargeableWeightKg,
          routeBaseFee: interPricing.routeBaseFee,
          distanceCharge: interPricing.distanceCharge,
          weightSurcharge: interPricing.weightSurcharge,
          oversizedSurcharge: interPricing.oversizedSurcharge,
          deliveryMethodCharge: interPricing.deliveryMethodCharge,
          remoteAreaCharge: interPricing.remoteAreaCharge,
          specialHandlingCharge: interPricing.specialHandlingCharge,
          carrierCost: interPricing.carrierCost,
          sellerContribution: interPricing.sellerContribution,
          marketplaceSubsidy: interPricing.marketplaceSubsidy,
          allowedDeliveryMethods: interPricing.allowedDeliveryMethods,
          estimatedHoursMin: interPricing.estimatedHoursMin,
          estimatedHoursMax: interPricing.estimatedHoursMax,
          expressSupported: interPricing.expressSupported,
          expressSurcharge: interPricing.expressSurcharge,
          hasMixedShipments: false,
          subShipments: [stdSubShipment],
        };

        setCached(cacheKey, result);
        return result;
      } catch (err: any) {
        return {
          deliveryAvailable: false,
          reason: err?.code || 'ROUTE_NOT_SERVICEABLE',
          distanceKm,
          durationMinutes,
          zoneId: null,
          zoneName: err?.message || 'المسار بين هذه المحافظات غير متاح حالياً',
          baseFee: 0,
          extraSellerFee: 0,
          weightFee: 0,
          slotFee: 0,
          expressFee: 0,
          deliveryDiscount: 0,
          deliveryFee: 0,
          currency,
          pricingVersion,
          isExpress,
        };
      }
    }

    // 2. Check max delivery radius (§32)
    const settings = await this._getSettings();
    const maxRadius = settings.maxDeliveryRadiusKm ?? config.marketplace.maxDeliveryRadiusKm;

    if (distanceKm > maxRadius) {
      return {
        deliveryAvailable: false,
        reason: 'OUTSIDE_DELIVERY_AREA',
        distanceKm,
        durationMinutes,
        zoneId: null,
        zoneName: 'خارج نطاق التوصيل',
        baseFee: 0,
        extraSellerFee: 0,
        weightFee: 0,
        slotFee: 0,
        expressFee: 0,
        deliveryDiscount: 0,
        deliveryFee: 0,
        currency,
        pricingVersion,
        isExpress,
      };
    }


    // 3. Determine pricing zone
    const zone = await this.determineZone(distanceKm);
    if (!zone) {
      return {
        deliveryAvailable: false,
        reason: 'OUTSIDE_DELIVERY_AREA',
        distanceKm,
        durationMinutes,
        zoneId: null,
        zoneName: '',
        baseFee: 0,
        extraSellerFee: 0,
        weightFee: 0,
        slotFee: 0,
        expressFee: 0,
        deliveryDiscount: 0,
        deliveryFee: 0,
        currency,
        pricingVersion,
        isExpress,
      };
    }

    // 4. Compute base fee & distance fee (authoritative separation)
    const baseFee = zone.baseFee;
    let distanceCharge = 0;
    if (zone.extraFeePerKm > 0) {
      const extraKm = Math.max(0, distanceKm - zone.minDistanceKm);
      distanceCharge = Math.round(extraKm * zone.extraFeePerKm);
    }

    // 5. Weight/size fee
    let effectiveWeightKg = weightKg;
    if (options.heavyItems && options.heavyItems.length > 0) {
      const physicalItems = options.heavyItems.filter((it) => !it.isDigital);
      effectiveWeightKg = physicalItems.reduce((sum, it) => sum + ((it.weightKg || it.packageWeightKg || 0) * (it.quantity || 1)), 0);
    }
    const weightFee = Math.round(effectiveWeightKg * weightFeePerKg);

    // 6. Express fee (§19)
    const expressFee = (isExpress && settings.expressEnabled) ? settings.expressFeeFixed : 0;

    // 7. Special handling & remote area charges (if applicable)
    const specialHandlingCharge = options.isSpecialHandling ? 500 : 0;
    const remoteAreaCharge = options.isRemoteArea ? 500 : 0;

    // 8. Raw Subtotal before discounts
    let rawCityFee =
      baseFee +
      distanceCharge +
      extraSellerFee +
      weightFee +
      slotFee +
      expressFee +
      specialHandlingCharge +
      remoteAreaCharge;

    // 9. Enforce Minimum & Maximum delivery fee bounds
    const minFee = settings.minDeliveryFee ?? 0;
    const maxFee = settings.maxDeliveryFee ?? null;
    if (minFee > 0 && rawCityFee < minFee) {
      rawCityFee = minFee;
    }
    if (maxFee !== null && maxFee > 0 && rawCityFee > maxFee) {
      rawCityFee = maxFee;
    }

    // 10. Delivery discount
    const deliveryDiscount = Math.min(Math.max(0, discountAmount), rawCityFee);

    // 11. Final authoritative fee
    const deliveryFee = Math.max(0, Math.round(rawCityFee - deliveryDiscount));

    const stdSubShipment: DeliverySubShipment = {
      id: `sub_std_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      shipmentType: 'STANDARD',
      titleAr: 'شحنة الطرود العادية (توصيل محلي)',
      titleEn: 'Standard Local Parcel Shipment',
      items: itemsToAnalyze.map((it) => ({
        productId: it.productId,
        name: it.name,
        quantity: it.quantity,
        weightKg: it.weightKg || undefined,
        sellingUnit: it.sellingUnit || undefined,
        isDigital: false,
      })),
      totalWeightKg: effectiveWeightKg,
      deliveryFee,
      baseFee,
      distanceCharge,
      handlingFee: weightFee + specialHandlingCharge,
      deliveryMode: 'STANDARD_PARCEL',
      allowedDeliveryMethods: [
        { code: 'standard', nameAr: 'توصيل عادي', nameEn: 'Standard Delivery', surcharge: 0, isAvailable: true },
        ...(isExpress ? [{ code: 'express', nameAr: 'توصيل سريع', nameEn: 'Express Delivery', surcharge: expressFee, isAvailable: true }] : []),
      ],
    };

    const result: DeliveryQuoteResult = {
      deliveryAvailable: true,
      distanceKm,
      durationMinutes,
      zoneId: zone.zoneId,
      zoneName: zone.zoneName,
      baseFee,
      distanceCharge,
      extraSellerFee,
      weightFee,
      slotFee,
      expressFee,
      specialHandlingCharge,
      remoteAreaCharge,
      deliveryDiscount,
      ...(discountFundedBy ? { discountFundedBy } : {}),
      deliveryFee,
      currency: zone.currency || currency,
      pricingVersion,
      isExpress,
      hasMixedShipments: false,
      subShipments: [stdSubShipment],
    };

    setCached(cacheKey, result);
    return result;
  }

  /**
   * Compute multi-vendor delivery fee applying the configured policy.
   * §15: Each seller has an independent location and fee.
   */
  async calculateMultiVendorFee(
    quotes: (DeliveryQuoteResult & { sellerId: string })[],
    policy?: string,
  ): Promise<MultiVendorDeliveryResult> {
    const activePolicy = policy ?? config.marketplace.multiVendorPolicy;
    const currency = config.marketplace.currency;
    const availableQuotes = quotes.filter((q) => q.deliveryAvailable);

    let totalDeliveryFee = 0;

    switch (activePolicy) {
      case 'PER_SELLER':
        // Each seller's fee is charged separately — total is the sum
        totalDeliveryFee = availableQuotes.reduce((sum, q) => sum + q.deliveryFee, 0);
        break;

      case 'MAXIMUM_FEE':
        // Customer pays only the highest fee
        totalDeliveryFee = availableQuotes.reduce((max, q) => Math.max(max, q.deliveryFee), 0);
        break;

      case 'COMBINED': {
        // Combined multi-seller delivery policy: Highest single delivery fee + incremental consolidation fee (500 YER) per extra physical seller
        const physicalQuotes = availableQuotes.filter((q) => !q.isDigital);
        if (physicalQuotes.length === 0) {
          totalDeliveryFee = 0;
        } else if (physicalQuotes.length === 1) {
          totalDeliveryFee = physicalQuotes[0].deliveryFee;
        } else {
          const maxFee = physicalQuotes.reduce((max, q) => Math.max(max, q.deliveryFee), 0);
          const additionalSellers = physicalQuotes.length - 1;
          const incrementalFee = additionalSellers * 500.0;
          totalDeliveryFee = Math.round(maxFee + incrementalFee);
        }
        break;
      }

      case 'FREE_ABOVE_ORDER_VALUE':
        // Handled at checkout level — fee is zero if order value threshold is met
        totalDeliveryFee = 0;
        break;

      default:
        totalDeliveryFee = availableQuotes.reduce((sum, q) => sum + q.deliveryFee, 0);
    }

    return { sellerQuotes: quotes, totalDeliveryFee, currency, policy: activePolicy };
  }

  private _settingsCache: { data: any; expiresAt: number } | null = null;

  private async _getSettings() {
    if (this._settingsCache && Date.now() < this._settingsCache.expiresAt) {
      return this._settingsCache.data;
    }
    let settings = await prisma.deliverySettings.findFirst();
    if (!settings) {
      settings = {
        multiVendorPolicy: config.marketplace.multiVendorPolicy,
        expressEnabled: true,
        expressFeeFixed: config.marketplace.expressFeeFixed,
        maxDeliveryRadiusKm: config.marketplace.maxDeliveryRadiusKm,
        freeDeliveryThreshold: config.marketplace.freeDeliveryThreshold,
        currency: config.marketplace.currency,
      } as any;
    }
    this._settingsCache = { data: settings, expiresAt: Date.now() + 60_000 };
    return settings!;
  }

  clearCache(): void {
    _quoteCache.clear();
    _distanceCache.clear();
    this._zonesCache = null;
    this._settingsCache = null;
  }
}

// Singleton
export const deliveryFeeService = new DeliveryFeeService();
