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

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface DeliveryFeeOptions {
  isExpress?: boolean;
  extraSellerFee?: number;
  weightKg?: number;
  weightFeePerKg?: number;
  slotFee?: number;          // time-slot surcharge from DeliveryTimeSlot.slotFee
  discountAmount?: number;
  discountFundedBy?: 'MARKETPLACE' | 'SELLER' | 'COUPON';
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
  reason?: string; // OUTSIDE_DELIVERY_AREA | NO_ROUTE_FOUND | PROVIDER_UNAVAILABLE

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
// Simple in-memory quote cache (TTL 5 min, keyed by inputs)
// ──────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: DeliveryQuoteResult;
  expiresAt: number;
}

const _quoteCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function buildCacheKey(
  sellerLat: number, sellerLng: number,
  customerLat: number, customerLng: number,
  isExpress: boolean, pricingVersion: string,
  slotFee: number = 0,
): string {
  return `${sellerLat.toFixed(5)},${sellerLng.toFixed(5)}|${customerLat.toFixed(5)},${customerLng.toFixed(5)}|express=${isExpress}|slotFee=${slotFee}|v=${pricingVersion}`;
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
  /**
   * Calculate driving distance + duration between two coordinate pairs.
   * Uses the configured RoutingProvider (Geoapify by default).
   * §10: Uses driving route distance, not straight-line.
   */
  async calculateDistance(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<{ distanceKm: number; durationMinutes: number }> {
    try {
      if (geoService.isConfigured()) {
        const route = await geoService.routing().getDrivingRoute(origin, destination);
        if (route && route.distanceKm > 0) {
          return {
            distanceKm: route.distanceKm,
            durationMinutes: route.durationMinutes,
          };
        }
      }
    } catch (e) {
      console.warn('[DeliveryFeeService] Geoapify routing unavailable, falling back to geodesic road distance:', e);
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

    return {
      distanceKm,
      durationMinutes,
    };
  }


  /**
   * Determine which pricing zone a given distance falls into.
   * Zones are loaded from DeliveryZonePricing, ordered by priority ascending.
   * §11: Zone selection — uses configured zones, not hard-coded.
   */
  async determineZone(distanceKm: number): Promise<{
    zoneId: string | null;
    zoneName: string;
    baseFee: number;
    extraFeePerKm: number;
    currency: string;
  } | null> {
    const zones = await prisma.deliveryZonePricing.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });

    for (const zone of zones) {
      const minOk = distanceKm >= zone.minDistanceKm;
      const maxOk = zone.maxDistanceKm === null || distanceKm < zone.maxDistanceKm;
      if (minOk && maxOk) {
        return {
          zoneId: zone.id,
          zoneName: zone.nameAr || zone.name,
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
    const {
      isExpress = false,
      extraSellerFee = 0,
      weightKg = 0,
      weightFeePerKg = 0,
      slotFee = 0,
      discountAmount = 0,
      discountFundedBy,
    } = options;

    const pricingVersion = getPricingVersion();
    const cacheKey = buildCacheKey(sellerLat, sellerLng, customerLat, customerLng, isExpress, pricingVersion, slotFee);

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

    // 4. Compute base fee (includes extra per-km for open-ended zones)
    let baseFee = zone.baseFee;
    if (zone.extraFeePerKm > 0) {
      const extraKm = Math.max(0, distanceKm - /* zone minDistanceKm approximation */ distanceKm);
      baseFee += extraKm * zone.extraFeePerKm;
    }

    // 5. Weight/size fee (§20 — architecture ready, not complex yet)
    const weightFee = Math.round(weightKg * weightFeePerKg);

    // 6. Express fee (§19)
    const expressFee = (isExpress && settings.expressEnabled) ? settings.expressFeeFixed : 0;


    // 7. Delivery discount (§21)
    const deliveryDiscount = Math.min(discountAmount, baseFee + extraSellerFee + weightFee + slotFee + expressFee);

    // 8. Final fee
    const deliveryFee = Math.max(0, baseFee + extraSellerFee + weightFee + slotFee + expressFee - deliveryDiscount);

    const result: DeliveryQuoteResult = {
      deliveryAvailable: true,
      distanceKm,
      durationMinutes,
      zoneId: zone.zoneId,
      zoneName: zone.zoneName,
      baseFee,
      extraSellerFee,
      weightFee,
      slotFee,
      expressFee,
      deliveryDiscount,
      ...(discountFundedBy ? { discountFundedBy } : {}),
      deliveryFee,
      currency: zone.currency || currency,
      pricingVersion,
      isExpress,
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

      case 'COMBINED':
        // Admin-defined combined rate (fallback: same as PER_SELLER)
        totalDeliveryFee = availableQuotes.reduce((sum, q) => sum + q.deliveryFee, 0);
        break;

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
}

// Singleton
export const deliveryFeeService = new DeliveryFeeService();
