/**
 * SOUQNA — Inter-Governorate Route & Logistics Engine
 *
 * Provides backend-authoritative route management, road-distance pricing,
 * package weight/volumetric surcharges, delivery methods, carrier cost separation,
 * and immutable pricing snapshots for Yemeni inter-governorate delivery.
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { RemoteConfigService } from '../../modules/remote-config/remote-config.service';
import { supportedAreasService, STRICTLY_SUPPORTED_AREAS } from '../../modules/locations/supported-areas.service';
import { geoService } from '../geo/geo.service';
import type { GeoCoordinates } from '../geo/providers/map.provider';

export interface RoutePricingBreakdown {
  isInterGovernorate: true;
  routeId: string;
  routeKey: string;
  routeNameAr: string;
  routeNameEn: string;
  pricingMode: 'FIXED' | 'DISTANCE_BASED';
  routeBaseFee: number;
  distanceCharge: number;
  roadDistanceKm: number;
  isRoadDistanceEstimated: boolean;
  actualWeightKg: number;
  volumetricWeightKg: number;
  chargeableWeightKg: number;
  weightSurcharge: number;
  oversizedSurcharge: number;
  deliveryMethodCode: string;
  deliveryMethodCharge: number;
  expressCharge: number;
  isExpress: boolean;
  remoteAreaCharge: number;
  specialHandlingCharge: number;
  rawTotalFee: number;
  deliveryDiscount: number;
  finalDeliveryFee: number;
  carrierCost: number;
  sellerContribution: number;
  marketplaceSubsidy: number;
  pricingVersion: string;
  estimatedHoursMin: number;
  estimatedHoursMax: number;
  shippingProviderId?: string;
  shippingProviderName?: string;
  allowedDeliveryMethods: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    surcharge: number;
    estimatedHoursMin?: number;
    estimatedHoursMax?: number;
  }>;
}

export interface RouteCalculationInput {
  originAreaId: string;
  destinationAreaId: string;
  originCoords?: GeoCoordinates;
  destinationCoords?: GeoCoordinates;
  deliveryMethodCode?: string;
  isExpress?: boolean;
  actualWeightKg?: number;
  packageDimensions?: {
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
  };
  isRemoteArea?: boolean;
  isSpecialHandling?: boolean;
  discountAmount?: number;
  discountFundedBy?: 'MARKETPLACE' | 'SELLER' | 'COUPON';
}

export const APPROVED_YEMEN_GOVERNORATES = [
  'loc-ye-sanaa',
  'loc-ye-saada',
  'loc-ye-amran',
  'loc-ye-hajjah',
  'loc-ye-al-mahwit',
  'loc-ye-raymah',
  'loc-ye-dhamar',
  'loc-ye-al-bayda',
  'loc-ye-taiz-al-hawban',
];

export const STANDARD_DELIVERY_METHODS = [
  {
    code: 'seller_managed',
    nameAr: 'توصيل بإدارة البائع',
    nameEn: 'Seller-Managed Delivery',
    defaultSurcharge: 0,
  },
  {
    code: 'third_party_courier',
    nameAr: 'شركة توصيل وسيطة',
    nameEn: 'Third-Party Courier',
    defaultSurcharge: 200,
  },
  {
    code: 'marketplace_managed',
    nameAr: 'شحن بإدارة سوقنا',
    nameEn: 'SOUQNA Marketplace Shipping',
    defaultSurcharge: 0,
  },
  {
    code: 'intercity_transport',
    nameAr: 'شحن ونقل بين المحافظات',
    nameEn: 'Intercity Transport',
    defaultSurcharge: 300,
  },
  {
    code: 'pickup_point',
    nameAr: 'استلام من نقطة محددة',
    nameEn: 'Designated Pickup Point',
    defaultSurcharge: -100, // Small discount for customer pickup
  },
  {
    code: 'hub_to_hub',
    nameAr: 'شحن بين المراكز / المحطات',
    nameEn: 'Hub-to-Hub Transport',
    defaultSurcharge: 150,
  },
];

export class InterGovernorateRouteService {
  private static instance: InterGovernorateRouteService;

  public static getInstance(): InterGovernorateRouteService {
    if (!InterGovernorateRouteService.instance) {
      InterGovernorateRouteService.instance = new InterGovernorateRouteService();
    }
    return InterGovernorateRouteService.instance;
  }

  /**
   * Builds canonical route key from origin and destination area IDs.
   */
  public buildRouteKey(originAreaId: string, destinationAreaId: string): string {
    return `${originAreaId}:${destinationAreaId}`;
  }

  /**
   * Checks whether a feature flag is enabled.
   */
  public async isInterGovernorateEnabled(): Promise<boolean> {
    try {
      return await RemoteConfigService.getInstance().isFeatureActive('inter_governorate_delivery');
    } catch (_) {
      return false; // Default disabled until properly configured
    }
  }

  /**
   * Resolves the active approved route between two canonical areas.
   * If route is configured as BIDIRECTIONAL, origin and destination can be reversed.
   */
  public async resolveRoute(originAreaId: string, destinationAreaId: string): Promise<any | null> {
    // 1. Direct route lookup
    let route = await prisma.interGovernorateRoute.findFirst({
      where: {
        originAreaId,
        destinationAreaId,
        isActive: true,
      },
      include: {
        routeMethods: {
          where: { isAvailable: true },
        },
      },
    });

    if (route) return route;

    // 2. Return / Reverse lookup for BIDIRECTIONAL routes
    route = await prisma.interGovernorateRoute.findFirst({
      where: {
        originAreaId: destinationAreaId,
        destinationAreaId: originAreaId,
        direction: 'BIDIRECTIONAL',
        isActive: true,
      },
      include: {
        routeMethods: {
          where: { isAvailable: true },
        },
      },
    });

    return route;
  }

  /**
   * Measures or estimates actual road distance between origin and destination.
   * Never substitutes straight-line distance. Uses live routing provider or configured route distance.
   */
  public async getRoadDistance(
    originCoords?: GeoCoordinates,
    destCoords?: GeoCoordinates,
    configuredRouteKm?: number | null,
  ): Promise<{ roadDistanceKm: number; durationMinutes: number; isEstimated: boolean }> {
    // 1. Try live road routing via configured routing provider (e.g. Geoapify)
    if (originCoords && destCoords && geoService.isConfigured()) {
      try {
        const route = await geoService.routing().getDrivingRoute(originCoords, destCoords);
        if (route && route.distanceKm > 0) {
          return {
            roadDistanceKm: Math.round(route.distanceKm * 100) / 100,
            durationMinutes: Math.round(route.durationMinutes),
            isEstimated: false,
          };
        }
      } catch (err) {
        console.warn('[InterGovernorateRouteService] Live road routing call failed:', err);
      }
    }

    // 2. Fallback to configured road distance on the route
    if (configuredRouteKm && configuredRouteKm > 0) {
      return {
        roadDistanceKm: configuredRouteKm,
        durationMinutes: Math.round((configuredRouteKm / 45) * 60), // Avg road speed ~45 km/h for Yemeni mountainous highways
        isEstimated: true,
      };
    }

    // 3. Fallback to canonical area-to-area distance estimation (never straight-line directly; applies 1.45x highway curvature)
    if (originCoords && destCoords) {
      const directKm = supportedAreasService.calculateGeodesicDistanceKm(
        originCoords.lat,
        originCoords.lng,
        destCoords.lat,
        destCoords.lng,
      );
      const roadEstimate = Math.round(directKm * 1.45 * 10) / 10;
      return {
        roadDistanceKm: roadEstimate,
        durationMinutes: Math.round((roadEstimate / 45) * 60),
        isEstimated: true,
      };
    }

    return {
      roadDistanceKm: 0,
      durationMinutes: 0,
      isEstimated: true,
    };
  }

  /**
   * Authoritative calculation of inter-governorate delivery fees.
   * Strict adherence to formula:
   * Final Delivery Fee = Route Charge + Distance Charge (when enabled) + Weight Surcharge
   *                    + Size Surcharge + Delivery Method Charge + Express Charge
   *                    + Remote Area Charge + Special Handling Charge − Applicable Delivery Discounts.
   */
  public async calculatePricing(input: RouteCalculationInput): Promise<RoutePricingBreakdown> {
    const {
      originAreaId,
      destinationAreaId,
      originCoords,
      destinationCoords,
      deliveryMethodCode = 'intercity_transport',
      isExpress = false,
      actualWeightKg = 1.0,
      packageDimensions,
      isRemoteArea = false,
      isSpecialHandling = false,
      discountAmount = 0,
      discountFundedBy = 'MARKETPLACE',
    } = input;

    // 1. Resolve approved active route
    const route = await this.resolveRoute(originAreaId, destinationAreaId);
    if (!route) {
      throw new AppError(
        'خط الشحن بين هذه المحافظات غير مفعل حالياً أو بانتظار اعتماد الإدارة',
        400,
        'ROUTE_NOT_SERVICEABLE',
      );
    }

    // 2. Calculate Road Distance
    const roadInfo = await this.getRoadDistance(originCoords, destinationCoords, route.roadDistanceKm);
    const roadDistanceKm = roadInfo.roadDistanceKm;

    // 3. Base Route Charge & Distance Charge
    let routeBaseFee = route.baseFee;
    let distanceCharge = 0;

    if (route.pricingMode === 'DISTANCE_BASED') {
      const isDistancePricingActive = await RemoteConfigService.getInstance()
        .isFeatureActive('inter_governorate_distance_pricing')
        .catch(() => true);

      if (isDistancePricingActive && route.ratePerKm > 0) {
        if (roadDistanceKm > 0) {
          distanceCharge = Math.round(roadDistanceKm * route.ratePerKm);
        } else if (routeBaseFee <= 0) {
          throw new AppError(
            'تعذر حساب المسافة البرية الدقيقة للمسار ولا يوجد سعر ثابت محدد',
            400,
            'ROAD_DISTANCE_UNAVAILABLE',
          );
        }
      }
    }

    // 4. Weight & Volumetric Weight Surcharges
    const isWeightPricingActive = await RemoteConfigService.getInstance()
      .isFeatureActive('inter_governorate_weight_pricing')
      .catch(() => true);

    const lengthCm = packageDimensions?.lengthCm ?? 20;
    const widthCm = packageDimensions?.widthCm ?? 15;
    const heightCm = packageDimensions?.heightCm ?? 10;
    const volumetricDivisor = route.volumetricDivisor || 5000.0;
    const volumetricWeightKg = Math.round(((lengthCm * widthCm * heightCm) / volumetricDivisor) * 100) / 100;

    const chargeableWeightKg = Math.max(actualWeightKg, volumetricWeightKg);
    let weightSurcharge = 0;

    if (isWeightPricingActive && route.extraWeightRatePerKg > 0) {
      const includedWeight = route.includedWeightKg ?? 5.0;
      if (chargeableWeightKg > includedWeight) {
        const extraWeight = chargeableWeightKg - includedWeight;
        weightSurcharge = Math.round(extraWeight * route.extraWeightRatePerKg);
      }
    }

    // 5. Oversized Package Surcharge
    let oversizedSurcharge = 0;
    const maxDimension = Math.max(lengthCm, widthCm, heightCm);
    const isOversized =
      (route.oversizedMaxWeightKg && chargeableWeightKg > route.oversizedMaxWeightKg) ||
      (route.oversizedMaxDimensionCm && maxDimension > route.oversizedMaxDimensionCm);

    if (isOversized && route.oversizedSurcharge > 0) {
      oversizedSurcharge = route.oversizedSurcharge;
    }

    // 6. Delivery Method Validation & Surcharge
    const allowedCodes: string[] = Array.isArray(route.allowedMethodCodes)
      ? route.allowedMethodCodes
      : (() => {
          try {
            return JSON.parse(route.allowedMethodCodes);
          } catch (_) {
            return ['intercity_transport', 'seller_managed', 'third_party_courier', 'marketplace_managed'];
          }
        })();

    const effectiveMethodCode = allowedCodes.includes(deliveryMethodCode)
      ? deliveryMethodCode
      : (allowedCodes[0] || 'intercity_transport');

    const methodRule = route.routeMethods?.find((rm: any) => rm.methodCode === effectiveMethodCode);
    const deliveryMethodCharge = methodRule?.methodSurcharge ?? 0;

    // 7. Express Surcharge
    let expressCharge = 0;
    let effectiveHoursMin = route.estimatedHoursMin ?? 24;
    let effectiveHoursMax = route.estimatedHoursMax ?? 72;

    if (isExpress) {
      const isExpressEnabled = await RemoteConfigService.getInstance()
        .isFeatureActive('inter_governorate_express')
        .catch(() => true);

      if (!isExpressEnabled || !route.expressSupported) {
        throw new AppError('خدمة التوصيل السريع غير مفعلة لهذا المسار حالياً', 400, 'EXPRESS_UNAVAILABLE');
      }

      expressCharge = route.expressSurcharge ?? 500;
      effectiveHoursMin = route.expressHoursMin ?? 12;
      effectiveHoursMax = route.expressHoursMax ?? 24;
    }

    // 8. Remote Area & Special Handling Charges
    const remoteAreaCharge = isRemoteArea ? (route.remoteAreaSurcharge ?? 0) : 0;
    const specialHandlingCharge = isSpecialHandling ? (route.specialHandlingSurcharge ?? 0) : 0;

    // 9. Raw Total & Cap Bounds
    let rawTotalFee =
      routeBaseFee +
      distanceCharge +
      weightSurcharge +
      oversizedSurcharge +
      deliveryMethodCharge +
      expressCharge +
      remoteAreaCharge +
      specialHandlingCharge;

    if (route.minDeliveryFee != null && rawTotalFee < route.minDeliveryFee) {
      rawTotalFee = route.minDeliveryFee;
    }
    if (route.maxDeliveryFee != null && rawTotalFee > route.maxDeliveryFee) {
      rawTotalFee = route.maxDeliveryFee;
    }

    // 10. Discounts & Final Customer Delivery Fee
    const finalDeliveryFee = Math.max(0, rawTotalFee - (discountAmount || 0));

    // 11. Carrier Cost & Separation of Financial Obligations
    const providerBaseCost = route.providerBaseCost ?? 0;
    const providerDistanceCost = (route.providerPerKmCost ?? 0) * roadDistanceKm;
    const providerWeightCost = (route.providerPerKgCost ?? 0) * chargeableWeightKg;
    const carrierCost = Math.round(providerBaseCost + providerDistanceCost + providerWeightCost);

    let sellerContribution = 0;
    let marketplaceSubsidy = 0;

    if (discountAmount > 0) {
      if (discountFundedBy === 'SELLER') {
        sellerContribution = discountAmount;
      } else {
        marketplaceSubsidy = discountAmount;
      }
    }

    // 12. Allowed Delivery Methods List for Customer/UI selection
    const allowedMethodsList = STANDARD_DELIVERY_METHODS.filter((m) => allowedCodes.includes(m.code)).map((m) => {
      const rm = route.routeMethods?.find((r: any) => r.methodCode === m.code);
      return {
        code: m.code,
        nameAr: rm?.methodNameAr || m.nameAr,
        nameEn: rm?.methodNameEn || m.nameEn,
        surcharge: rm?.methodSurcharge ?? m.defaultSurcharge,
        estimatedHoursMin: rm?.estimatedHoursMin ?? effectiveHoursMin,
        estimatedHoursMax: rm?.estimatedHoursMax ?? effectiveHoursMax,
      };
    });

    const pricingVersion = `route-v${route.version || 1}-${new Date().toISOString().slice(0, 10)}`;

    return {
      isInterGovernorate: true,
      routeId: route.id,
      routeKey: route.routeKey,
      routeNameAr: route.nameAr,
      routeNameEn: route.nameEn,
      pricingMode: route.pricingMode,
      routeBaseFee,
      distanceCharge,
      roadDistanceKm,
      isRoadDistanceEstimated: roadInfo.isEstimated,
      actualWeightKg,
      volumetricWeightKg,
      chargeableWeightKg,
      weightSurcharge,
      oversizedSurcharge,
      deliveryMethodCode: effectiveMethodCode,
      deliveryMethodCharge,
      expressCharge,
      isExpress,
      remoteAreaCharge,
      specialHandlingCharge,
      rawTotalFee,
      deliveryDiscount: discountAmount || 0,
      finalDeliveryFee,
      carrierCost,
      sellerContribution,
      marketplaceSubsidy,
      pricingVersion,
      estimatedHoursMin: effectiveHoursMin,
      estimatedHoursMax: effectiveHoursMax,
      shippingProviderId: route.approvedProviderId ?? undefined,
      shippingProviderName: route.approvedProviderName ?? undefined,
      allowedDeliveryMethods: allowedMethodsList,
    };
  }

  /**
   * Initializes default database records for the 6 core DeliveryMethods if they do not exist.
   */
  public async ensureDeliveryMethods(): Promise<void> {
    try {
      for (const m of STANDARD_DELIVERY_METHODS) {
        await prisma.deliveryMethod.upsert({
          where: { code: m.code },
          update: {
            nameAr: m.nameAr,
            nameEn: m.nameEn,
            isActive: true,
          },
          create: {
            code: m.code,
            nameAr: m.nameAr,
            nameEn: m.nameEn,
            description: `Inter-governorate method: ${m.nameEn}`,
            basePrice: m.defaultSurcharge >= 0 ? m.defaultSurcharge : 0,
            isActive: true,
          },
        });
      }
    } catch (err) {
      console.warn('[InterGovernorateRouteService] Error syncing DeliveryMethods:', err);
    }
  }

  /**
   * Seeds default inactive routes between the 9 supported Yemeni governorates.
   * Routes default to inactive until configured and approved by an administrator.
   */
  public async seedDefaultRoutes(): Promise<void> {
    await this.ensureDeliveryMethods();

    const sanaa = STRICTLY_SUPPORTED_AREAS.find((a: any) => a.canonicalId === 'loc-ye-sanaa')!;
    const otherAreas = STRICTLY_SUPPORTED_AREAS.filter(
      (a: any) => a.canonicalId !== 'loc-ye-sanaa' && APPROVED_YEMEN_GOVERNORATES.includes(a.canonicalId),
    );

    for (const dest of otherAreas) {
      const routeKey = this.buildRouteKey(sanaa.canonicalId, dest.canonicalId);
      const existing = await prisma.interGovernorateRoute.findUnique({ where: { routeKey } });
      if (!existing) {
        const directKm = supportedAreasService.calculateGeodesicDistanceKm(
          sanaa.centerLat,
          sanaa.centerLng,
          dest.centerLat,
          dest.centerLng,
        );
        const roadDistanceEstimate = Math.round(directKm * 1.4);

        await prisma.interGovernorateRoute.create({
          data: {
            originAreaId: sanaa.canonicalId,
            destinationAreaId: dest.canonicalId,
            originGovernorate: sanaa.governorateAr,
            destinationGovernorate: dest.governorateAr,
            originCityName: sanaa.nameAr,
            destinationCityName: dest.nameAr,
            routeKey,
            nameAr: `صنعاء — ${dest.nameAr}`,
            nameEn: `Sanaa — ${dest.nameEn}`,
            direction: 'BIDIRECTIONAL',
            isActive: false, // Default inactive until approved by admin
            pricingMode: 'FIXED',
            baseFee: 2500.0,
            ratePerKm: 10.0,
            roadDistanceKm: roadDistanceEstimate,
            minDeliveryFee: 1500.0,
            maxDeliveryFee: 6000.0,
            includedWeightKg: 5.0,
            extraWeightRatePerKg: 150.0,
            volumetricDivisor: 5000.0,
            oversizedMaxDimensionCm: 100.0,
            oversizedMaxWeightKg: 30.0,
            oversizedSurcharge: 1000.0,
            expressSupported: true,
            expressSurcharge: 1000.0,
            estimatedHoursMin: 24,
            estimatedHoursMax: 48,
            approvedProviderId: 'yemen_post',
            approvedProviderName: 'البريد اليمني / خطوط النقل المعتمدة',
            providerBaseCost: 1800.0,
          },
        });
      }
    }
  }

  /**
   * Admin: Creates a new route with full audit logging and validation.
   */
  public async createRoute(data: any, adminUserId?: string, ipAddress?: string): Promise<any> {
    const {
      originAreaId,
      destinationAreaId,
      nameAr,
      nameEn,
      direction = 'BIDIRECTIONAL',
      pricingMode = 'FIXED',
      baseFee,
      ratePerKm = 0,
      roadDistanceKm,
      minDeliveryFee,
      maxDeliveryFee,
      includedWeightKg = 5.0,
      extraWeightRatePerKg = 100.0,
      volumetricDivisor = 5000.0,
      oversizedSurcharge = 0,
      expressSupported = true,
      expressSurcharge = 500.0,
      allowedMethodCodes,
      approvedProviderId,
      approvedProviderName,
      providerBaseCost = 0,
      providerPerKmCost = 0,
      providerPerKgCost = 0,
      isActive = false,
    } = data;

    if (!originAreaId || !destinationAreaId) {
      throw new AppError('يرجى تحديد نقطة الانطلاق ونقطة الوصول للمسار', 400);
    }

    if (originAreaId === destinationAreaId) {
      throw new AppError('لا يمكن إنشاء مسار بين محافظات لنفس المنطقة', 400);
    }

    if (baseFee === undefined || baseFee === null || isNaN(Number(baseFee)) || Number(baseFee) < 0) {
      throw new AppError('يرجى تحديد السعر الأساسي للمسار بشكل صحيح', 400);
    }

    const originArea = STRICTLY_SUPPORTED_AREAS.find((a: any) => a.canonicalId === originAreaId);
    const destArea = STRICTLY_SUPPORTED_AREAS.find((a: any) => a.canonicalId === destinationAreaId);

    if (!originArea || !destArea) {
      throw new AppError('المحافظات المحددة غير مدعومة في نظام الشحن المعتمد', 400);
    }

    const routeKey = this.buildRouteKey(originAreaId, destinationAreaId);
    const existing = await prisma.interGovernorateRoute.findUnique({ where: { routeKey } });
    if (existing) {
      throw new AppError('هذا المسار مسجل بالفعل في النظام', 400);
    }

    const route = await prisma.interGovernorateRoute.create({
      data: {
        originAreaId,
        destinationAreaId,
        originGovernorate: originArea.governorateAr,
        destinationGovernorate: destArea.governorateAr,
        originCityName: originArea.nameAr,
        destinationCityName: destArea.nameAr,
        routeKey,
        nameAr: nameAr || `${originArea.nameAr} إلى ${destArea.nameAr}`,
        nameEn: nameEn || `${originArea.nameEn} to ${destArea.nameEn}`,
        direction,
        isActive: Boolean(isActive),
        pricingMode,
        baseFee: parseFloat(String(baseFee)),
        ratePerKm: parseFloat(String(ratePerKm || 0)),
        roadDistanceKm: roadDistanceKm ? parseFloat(String(roadDistanceKm)) : null,
        minDeliveryFee: minDeliveryFee ? parseFloat(String(minDeliveryFee)) : null,
        maxDeliveryFee: maxDeliveryFee ? parseFloat(String(maxDeliveryFee)) : null,
        includedWeightKg: parseFloat(String(includedWeightKg || 5)),
        extraWeightRatePerKg: parseFloat(String(extraWeightRatePerKg || 100)),
        volumetricDivisor: parseFloat(String(volumetricDivisor || 5000)),
        oversizedSurcharge: parseFloat(String(oversizedSurcharge || 0)),
        expressSupported: Boolean(expressSupported),
        expressSurcharge: parseFloat(String(expressSurcharge || 500)),
        allowedMethodCodes: typeof allowedMethodCodes === 'string'
          ? allowedMethodCodes
          : JSON.stringify(allowedMethodCodes || ['intercity_transport', 'seller_managed', 'third_party_courier', 'marketplace_managed']),
        approvedProviderId,
        approvedProviderName,
        providerBaseCost: parseFloat(String(providerBaseCost || 0)),
        providerPerKmCost: parseFloat(String(providerPerKmCost || 0)),
        providerPerKgCost: parseFloat(String(providerPerKgCost || 0)),
        updatedBy: adminUserId,
      },
    });

    // Write audit log
    await prisma.interGovernorateAuditLog.create({
      data: {
        routeId: route.id,
        action: 'ROUTE_CREATED',
        newValue: JSON.stringify(route),
        changedBy: adminUserId,
        ipAddress,
        reason: 'Administrator created route',
      },
    });

    return route;
  }

  /**
   * Admin: Updates route pricing and configuration.
   */
  public async updateRoute(id: string, data: any, adminUserId?: string, ipAddress?: string): Promise<any> {
    const existing = await prisma.interGovernorateRoute.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('المسار غير موجود', 404);
    }

    const updatePayload: any = {
      version: { increment: 1 },
      updatedBy: adminUserId,
    };

    const floatFields = [
      'baseFee',
      'ratePerKm',
      'roadDistanceKm',
      'minDeliveryFee',
      'maxDeliveryFee',
      'includedWeightKg',
      'extraWeightRatePerKg',
      'volumetricDivisor',
      'oversizedMaxDimensionCm',
      'oversizedMaxWeightKg',
      'oversizedSurcharge',
      'expressSurcharge',
      'remoteAreaSurcharge',
      'specialHandlingSurcharge',
      'providerBaseCost',
      'providerPerKmCost',
      'providerPerKgCost',
    ];

    for (const f of floatFields) {
      if (data[f] !== undefined) {
        updatePayload[f] = data[f] === null ? null : parseFloat(String(data[f]));
      }
    }

    const intFields = ['estimatedHoursMin', 'estimatedHoursMax', 'expressHoursMin', 'expressHoursMax'];
    for (const f of intFields) {
      if (data[f] !== undefined) {
        updatePayload[f] = data[f] === null ? null : parseInt(String(data[f]), 10);
      }
    }

    if (data.nameAr !== undefined) updatePayload.nameAr = String(data.nameAr);
    if (data.nameEn !== undefined) updatePayload.nameEn = String(data.nameEn);
    if (data.direction !== undefined) updatePayload.direction = data.direction;
    if (data.pricingMode !== undefined) updatePayload.pricingMode = data.pricingMode;
    if (data.isActive !== undefined) updatePayload.isActive = Boolean(data.isActive);
    if (data.expressSupported !== undefined) updatePayload.expressSupported = Boolean(data.expressSupported);
    if (data.allowedMethodCodes !== undefined) {
      updatePayload.allowedMethodCodes = typeof data.allowedMethodCodes === 'string'
        ? data.allowedMethodCodes
        : JSON.stringify(data.allowedMethodCodes);
    }
    if (data.approvedProviderId !== undefined) updatePayload.approvedProviderId = data.approvedProviderId;
    if (data.approvedProviderName !== undefined) updatePayload.approvedProviderName = data.approvedProviderName;

    // Validate before activating
    if (updatePayload.isActive === true) {
      const finalBaseFee = updatePayload.baseFee ?? existing.baseFee;
      if (finalBaseFee === undefined || finalBaseFee === null || finalBaseFee < 0) {
        throw new AppError('لا يمكن تفعيل المسار دون تحديد سعر أساسي صحيح', 400);
      }
    }

    const updated = await prisma.interGovernorateRoute.update({
      where: { id },
      data: updatePayload,
      include: { routeMethods: true },
    });

    await prisma.interGovernorateAuditLog.create({
      data: {
        routeId: id,
        action: 'ROUTE_UPDATED',
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated),
        changedBy: adminUserId,
        ipAddress,
        reason: data.auditReason || 'Administrator updated route pricing',
      },
    });

    return updated;
  }

  /**
   * Admin: Toggles route active status.
   */
  public async toggleRouteActive(id: string, isActive: boolean, adminUserId?: string, ipAddress?: string): Promise<any> {
    const existing = await prisma.interGovernorateRoute.findUnique({ where: { id } });
    if (!existing) throw new AppError('المسار غير موجود', 404);

    if (isActive) {
      if (existing.baseFee < 0 || isNaN(existing.baseFee)) {
        throw new AppError('يجب تحديد سعر أساسي معتمد للمسار قبل تفعيله', 400);
      }
    }

    const updated = await prisma.interGovernorateRoute.update({
      where: { id },
      data: {
        isActive,
        updatedBy: adminUserId,
      },
    });

    await prisma.interGovernorateAuditLog.create({
      data: {
        routeId: id,
        action: isActive ? 'ROUTE_ACTIVATED' : 'ROUTE_DEACTIVATED',
        oldValue: JSON.stringify({ isActive: existing.isActive }),
        newValue: JSON.stringify({ isActive: updated.isActive }),
        changedBy: adminUserId,
        ipAddress,
        reason: `Route toggled to ${isActive ? 'ACTIVE' : 'INACTIVE'}`,
      },
    });

    return updated;
  }

  /**
   * Admin: Lists routes with filtering and statistics.
   */
  public async listRoutes(params: {
    originAreaId?: string;
    destinationAreaId?: string;
    isActive?: boolean;
    search?: string;
  } = {}): Promise<any[]> {
    const where: any = {};
    if (params.originAreaId) where.originAreaId = params.originAreaId;
    if (params.destinationAreaId) where.destinationAreaId = params.destinationAreaId;
    if (params.isActive !== undefined) where.isActive = params.isActive;
    if (params.search) {
      where.OR = [
        { nameAr: { contains: params.search, mode: 'insensitive' } },
        { nameEn: { contains: params.search, mode: 'insensitive' } },
        { originGovernorate: { contains: params.search, mode: 'insensitive' } },
        { destinationGovernorate: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    return await prisma.interGovernorateRoute.findMany({
      where,
      include: {
        routeMethods: true,
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Admin Analytics: Inter-governorate logistics KPIs.
   */
  public async getLogisticsAnalytics(): Promise<any> {
    const totalRoutes = await prisma.interGovernorateRoute.count();
    const activeRoutes = await prisma.interGovernorateRoute.count({ where: { isActive: true } });

    // Aggregate snapshots for inter-governorate shipments
    const interSnapshots = await prisma.deliveryQuoteSnapshot.findMany({
      where: { isInterGovernorate: true },
      select: {
        deliveryFee: true,
        baseFee: true,
        carrierCost: true,
        sellerContribution: true,
        marketplaceSubsidy: true,
        routeKey: true,
        calculatedAt: true,
      },
    });

    const totalShipments = interSnapshots.length;
    let totalDeliveryFeesCollected = 0;
    let totalCarrierCosts = 0;
    let totalSellerContributions = 0;
    let totalMarketplaceSubsidies = 0;

    const routeStatsMap = new Map<string, { count: number; fees: number }>();

    for (const snap of interSnapshots) {
      totalDeliveryFeesCollected += snap.deliveryFee || 0;
      totalCarrierCosts += snap.carrierCost || 0;
      totalSellerContributions += snap.sellerContribution || 0;
      totalMarketplaceSubsidies += snap.marketplaceSubsidy || 0;

      if (snap.routeKey) {
        const curr = routeStatsMap.get(snap.routeKey) || { count: 0, fees: 0 };
        curr.count += 1;
        curr.fees += snap.deliveryFee || 0;
        routeStatsMap.set(snap.routeKey, curr);
      }
    }

    // Check delivery orders status
    const failedDeliveries = await prisma.deliveryOrder.count({
      where: { status: { in: ['FAILED', 'FAILED_ATTEMPT', 'RETURN_TO_SENDER'] } },
    });

    const deliveredCount = await prisma.deliveryOrder.count({
      where: { status: 'DELIVERED' },
    });

    return {
      totalRoutes,
      activeRoutes,
      inactiveRoutes: totalRoutes - activeRoutes,
      totalShipments,
      totalDeliveryFeesCollected: Math.round(totalDeliveryFeesCollected),
      totalCarrierCosts: Math.round(totalCarrierCosts),
      totalSellerContributions: Math.round(totalSellerContributions),
      totalMarketplaceSubsidies: Math.round(totalMarketplaceSubsidies),
      platformMargin: Math.round(totalDeliveryFeesCollected - totalCarrierCosts + totalSellerContributions),
      failedDeliveries,
      deliveredCount,
      routePerformance: Array.from(routeStatsMap.entries()).map(([routeKey, data]) => ({
        routeKey,
        shipmentCount: data.count,
        totalFees: Math.round(data.fees),
      })),
    };
  }
}

export const interGovernorateRouteService = InterGovernorateRouteService.getInstance();
