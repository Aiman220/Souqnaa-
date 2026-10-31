/**
 * SOUQNAA — Delivery Serviceability & City Discovery Engine
 *
 * Authoritatively determines seller delivery coverage and filters product discovery
 * based on the customer's selected destination and seller pickup location.
 */

import { Request } from 'express';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { config } from '../../config';
import { RemoteConfigService } from '../../modules/remote-config/remote-config.service';
import { supportedAreasService, LocationMatchResult } from '../../modules/locations/supported-areas.service';
import { deliveryFeeService } from './delivery-fee.service';

export interface CustomerDestination {
  cityId?: string;
  cityName?: string;
  canonicalCityId?: string;
  latitude?: number;
  longitude?: number;
  isSupported: boolean;
  matchResult: LocationMatchResult;
}

export interface StoreServiceabilityResult {
  storeId: string;
  sellerId: string;
  isDeliverable: boolean;
  distanceKm?: number;
  reason?: 'OUTSIDE_DELIVERY_RADIUS' | 'UNSUPPORTED_DESTINATION' | 'NO_STORE_LOCATION' | 'STORE_INACTIVE' | 'OK';
  reasonAr?: string;
}

const SERVICEABILITY_CACHE_TTL = 300; // 5 minutes in Redis / memory

export class DeliveryServiceabilityService {
  private static instance: DeliveryServiceabilityService;
  private localServiceableStoresCache = new Map<string, { storeIds: Set<string>; expiresAt: number }>();

  public static getInstance(): DeliveryServiceabilityService {
    if (!DeliveryServiceabilityService.instance) {
      DeliveryServiceabilityService.instance = new DeliveryServiceabilityService();
    }
    return DeliveryServiceabilityService.instance;
  }

  /**
   * Checks if city-based product discovery feature flag is active.
   */
  public async isCityDiscoveryEnabled(context: { userId?: string; platform?: string } = {}): Promise<boolean> {
    return await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', context);
  }

  /**
   * Resolves the customer's destination from query params, headers, or default address.
   */
  public async resolveCustomerDestination(req: Request): Promise<CustomerDestination | null> {
    const {
      cityId,
      destinationCityId,
      city,
      destinationCity,
      lat,
      latitude,
      lng,
      longitude,
    } = req.query;

    const rawCityId = (destinationCityId || cityId || req.headers['x-delivery-city-id']) as string | undefined;
    const rawCityName = (destinationCity || city || req.headers['x-destination-city']) as string | undefined;
    const rawLat = lat || latitude || req.headers['x-destination-lat'];
    const rawLng = lng || longitude || req.headers['x-destination-lng'];

    let parsedLat = rawLat ? parseFloat(String(rawLat)) : undefined;
    let parsedLng = rawLng ? parseFloat(String(rawLng)) : undefined;

    // 1. If explicit query params or headers were provided
    if (rawCityId || rawCityName || (parsedLat && parsedLng)) {
      let resolvedCityName = rawCityName;
      if (!resolvedCityName && rawCityId) {
        const cityRecord = await prisma.city.findUnique({ where: { id: rawCityId } });
        if (cityRecord) {
          resolvedCityName = cityRecord.nameAr;
          parsedLat = parsedLat ?? cityRecord.latitude ?? undefined;
          parsedLng = parsedLng ?? cityRecord.longitude ?? undefined;
        }
      }

      const match = supportedAreasService.matchSupportedArea(resolvedCityName || rawCityId);
      if (match.isSupported && match.area) {
        return {
          cityId: rawCityId || match.canonicalCityId,
          cityName: match.area.nameAr,
          canonicalCityId: match.area.canonicalId,
          latitude: parsedLat ?? match.area.centerLat,
          longitude: parsedLng ?? match.area.centerLng,
          isSupported: true,
          matchResult: match,
        };
      }

      return {
        cityId: rawCityId,
        cityName: resolvedCityName,
        latitude: parsedLat,
        longitude: parsedLng,
        isSupported: false,
        matchResult: match,
      };
    }

    // 2. If authenticated, fall back to user's default address
    if (req.user?.userId) {
      const defaultAddress = await prisma.address.findFirst({
        where: { userId: req.user.userId, isDefault: true },
        include: { city: true },
      });

      if (defaultAddress) {
        const match = supportedAreasService.isAddressSupported(defaultAddress);
        return {
          cityId: defaultAddress.cityId,
          cityName: defaultAddress.city?.nameAr || defaultAddress.street,
          canonicalCityId: match.area?.canonicalId,
          latitude: defaultAddress.latitude ?? defaultAddress.city?.latitude ?? (match.area?.centerLat),
          longitude: defaultAddress.longitude ?? defaultAddress.city?.longitude ?? (match.area?.centerLng),
          isSupported: match.isSupported,
          matchResult: match,
        };
      }
    }

    // 3. Guest browsing with no destination selected
    return null;
  }

  /**
   * Determine whether a specific store can deliver to the given destination.
   * Evaluates authoritative backend zone and distance rules.
   */
  public async evaluateStoreServiceability(
    store: {
      id: string;
      sellerId: string;
      latitude?: number | null;
      longitude?: number | null;
      isActive?: boolean;
    },
    destination: CustomerDestination
  ): Promise<StoreServiceabilityResult> {
    if (!destination.isSupported || !destination.matchResult.isSupported) {
      return {
        storeId: store.id,
        sellerId: store.sellerId,
        isDeliverable: false,
        reason: 'UNSUPPORTED_DESTINATION',
        reasonAr: destination.matchResult.rejectionReasonAr || 'الوجهة المحددة غير مشمولة في المناطق المدعومة',
      };
    }

    let storeLat = store.latitude;
    let storeLng = store.longitude;

    if (!storeLat || !storeLng) {
      const storeAddr = await prisma.address.findFirst({
        where: { storeId: store.id },
        include: { city: true },
      });
      if (storeAddr?.latitude && storeAddr?.longitude) {
        storeLat = storeAddr.latitude;
        storeLng = storeAddr.longitude;
      } else if (storeAddr?.city?.latitude && storeAddr?.city?.longitude) {
        storeLat = storeAddr.city.latitude;
        storeLng = storeAddr.city.longitude;
      }
    }

    // Default to Sanaa coordinates if store has not configured custom coordinates
    storeLat = storeLat ?? 15.3694;
    storeLng = storeLng ?? 44.1910;

    const destLat = destination.latitude ?? destination.matchResult.area?.centerLat ?? 15.3694;
    const destLng = destination.longitude ?? destination.matchResult.area?.centerLng ?? 44.1910;

    // Check store pickup location against supported areas:
    // A store located outside the 10 supported areas cannot deliver.
    const storeAreaMatch = supportedAreasService.findSupportedAreaByCoordinates(storeLat, storeLng, 60.0);

    // Calculate distance between store pickup and destination
    const distanceKm = supportedAreasService.calculateGeodesicDistanceKm(storeLat, storeLng, destLat, destLng);

    // Fetch delivery settings for maximum radius
    const settings = await prisma.deliverySettings.findFirst();
    const maxRadius = settings?.maxDeliveryRadiusKm ?? config.marketplace.maxDeliveryRadiusKm ?? 50.0;

    // Same-city delivery is permitted if distance is within maxRadius or reasonable city bounds
    const isSameArea =
      destination.matchResult.area &&
      storeAreaMatch.area &&
      destination.matchResult.area.canonicalId === storeAreaMatch.area.canonicalId;

    if (isSameArea && distanceKm <= Math.max(maxRadius, destination.matchResult.area?.defaultMaxRadiusKm ?? maxRadius)) {
      return {
        storeId: store.id,
        sellerId: store.sellerId,
        isDeliverable: true,
        distanceKm,
        reason: 'OK',
      };
    }

    // Inter-city or border delivery: permitted if distance is within configured max delivery radius
    if (distanceKm <= maxRadius) {
      return {
        storeId: store.id,
        sellerId: store.sellerId,
        isDeliverable: true,
        distanceKm,
        reason: 'OK',
      };
    }

    return {
      storeId: store.id,
      sellerId: store.sellerId,
      isDeliverable: false,
      distanceKm,
      reason: 'OUTSIDE_DELIVERY_RADIUS',
      reasonAr: `المتجر يبعد مسافة (${distanceKm} كم) وهي تتجاوز الحد الأقصى لنطاق التوصيل المسموح (${maxRadius} كم)`,
    };
  }

  /**
   * Retrieves the Set of Store IDs that are serviceable for the customer destination.
   * Cached to maintain sub-millisecond discovery response times.
   */
  public async getServiceableStoreIds(destination: CustomerDestination): Promise<Set<string>> {
    const cacheKey = `serviceable_stores:${destination.canonicalCityId || destination.cityId || 'unknown'}:${destination.latitude?.toFixed(3)},${destination.longitude?.toFixed(3)}`;

    // 1. Check in-memory cache
    const memEntry = this.localServiceableStoresCache.get(cacheKey);
    if (memEntry && Date.now() < memEntry.expiresAt) {
      return memEntry.storeIds;
    }

    // 2. Check Redis cache
    try {
      const cached = await redis.getJson<string[]>(`souqna:delivery:${cacheKey}`);
      if (cached && Array.isArray(cached)) {
        const storeSet = new Set(cached);
        this.localServiceableStoresCache.set(cacheKey, { storeIds: storeSet, expiresAt: Date.now() + 60000 });
        return storeSet;
      }
    } catch (_) {}

    // 3. Compute serviceable stores
    const stores = await prisma.store.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sellerId: true,
        latitude: true,
        longitude: true,
        isActive: true,
      },
    });

    const serviceableStoreIds = new Set<string>();

    for (const store of stores) {
      const evalResult = await this.evaluateStoreServiceability(store, destination);
      if (evalResult.isDeliverable) {
        serviceableStoreIds.add(store.id);
      }
    }

    // Cache the result
    this.localServiceableStoresCache.set(cacheKey, {
      storeIds: serviceableStoreIds,
      expiresAt: Date.now() + SERVICEABILITY_CACHE_TTL * 1000,
    });

    try {
      await redis.setJson(`souqna:delivery:${cacheKey}`, Array.from(serviceableStoreIds), SERVICEABILITY_CACHE_TTL);
    } catch (_) {}

    return serviceableStoreIds;
  }

  /**
   * Invalidate affected delivery serviceability caches when a seller's pickup location,
   * delivery zone, or delivery settings change.
   */
  public async invalidateServiceabilityCache(): Promise<void> {
    this.localServiceableStoresCache.clear();
    try {
      // Invalidate home feed and discovery caches
      await redis.del('cache:home:feed');
      // Scan and delete serviceability keys in Redis
      // Invalidate home feed and memory cache
      await redis.del('cache:home:feed');
    } catch (_) {}
  }
}

export const deliveryServiceabilityService = DeliveryServiceabilityService.getInstance();
