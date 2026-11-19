/**
 * HeavyDeliveryService — Production-grade heavy & bulky delivery logistics engine for SOUQNA.
 *
 * Supports ceramic tiles, porcelain, marble, granite, doors, large home appliances,
 * industrial machinery, generators, solar equipment, and oversized cargo.
 *
 * Calculation modes:
 *  - STANDARD_PARCEL
 *  - HEAVY_LOCAL
 *  - HEAVY_INTER_GOVERNORATE
 *  - OVERSIZED_SPECIAL
 *  - MANUAL_QUOTE
 */

import { prisma } from '../../database/prisma';

export type DeliveryCalculationMode =
  | 'STANDARD_PARCEL'
  | 'HEAVY_LOCAL'
  | 'HEAVY_INTER_GOVERNORATE'
  | 'OVERSIZED_SPECIAL'
  | 'MANUAL_QUOTE';

export type QuoteType = 'AUTOMATIC_QUOTE' | 'MANUAL_QUOTE_REQUIRED';

export type HeavyCargoClassification =
  | 'TILES_PORCELAIN'
  | 'MARBLE_GRANITE'
  | 'MACHINERY_INDUSTRIAL'
  | 'GENERATORS_SOLAR'
  | 'DOORS_GATES'
  | 'HOME_APPLIANCES'
  | 'GENERAL_BULKY'
  | 'STANDARD_PARCEL';

export interface HeavyProductShippingInput {
  productId?: string;
  name?: string;
  quantity: number;
  weightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  packageWeightKg?: number | null;
  packageLengthCm?: number | null;
  packageWidthCm?: number | null;
  packageHeightCm?: number | null;
  sellingUnit?: string | null; // PIECE, BOX, SQM, SLAB, TON, SET
  unitDimensionsJson?: string | null;
  palletCount?: number | null;
  packagingType?: string | null;
  isFragile?: boolean | null;
  isOversized?: boolean | null;
  requiresForklift?: boolean | null;
  requiresCrane?: boolean | null;
  requiresSpecialVehicle?: boolean | null;
  specialVehicleType?: string | null;
  isSpecialHandling?: boolean | null;
  categorySlug?: string | null;
  categoryNameAr?: string | null;
  categoryNameEn?: string | null;
  isDigital?: boolean | null;
}

export interface CargoAnalysisResult {
  isHeavyOrBulky: boolean;
  classification: HeavyCargoClassification;
  totalActualWeightKg: number;
  totalVolumetricWeightKg: number;
  chargeableWeightKg: number;
  totalVolumeCbm: number;
  palletCount: number;
  maxItemLengthCm: number;
  maxItemWidthCm: number;
  maxItemHeightCm: number;
  isFragile: boolean;
  isOversized: boolean;
  requiresForklift: boolean;
  requiresCrane: boolean;
  requiresSpecialVehicle: boolean;
  specialVehicleType?: string;
  hasIncompleteSpecs: boolean;
  incompleteReason?: string;
  cargoDescriptionAr: string;
}

export interface VehicleMatchResult {
  matchedVehicle: any | null;
  candidateVehicles: any[];
  exceedsCapacity: boolean;
  requiresManualQuote: boolean;
  reason?: string;
}

export interface HeavyPricingCalculationOptions {
  distanceKm: number;
  isInterGovernorate: boolean;
  originGovernorate?: string;
  destinationGovernorate?: string;
  accessSurcharge?: number;
  discountAmount?: number;
}

export interface HeavyPricingBreakdown {
  deliveryMode: DeliveryCalculationMode;
  quoteType: QuoteType;
  quoteReason?: string;
  requiresManualQuote: boolean;
  vehicleCode: string;
  vehicleNameAr: string;
  vehicleNameEn: string;
  palletCount: number;
  baseFee: number;
  distanceCharge: number;
  loadingFee: number;
  unloadingFee: number;
  forkliftFee: number;
  craneFee: number;
  specialHandlingFee: number;
  accessSurcharge: number;
  deliveryDiscount: number;
  finalDeliveryFee: number;
  currency: string;
  explanationAr: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// In-Memory Vehicle Cache
// ──────────────────────────────────────────────────────────────────────────────

let _cachedVehicles: any[] | null = null;
let _cachedVehiclesExpiresAt = 0;
const VEHICLE_CACHE_TTL_MS = 60 * 1000;

export class HeavyDeliveryService {
  /**
   * Load active heavy vehicle classes from DB with in-memory caching.
   */
  async getActiveVehicleClasses(): Promise<any[]> {
    if (_cachedVehicles && Date.now() < _cachedVehiclesExpiresAt) {
      return _cachedVehicles;
    }
    const vehicles = await prisma.heavyVehicleClass.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });
    _cachedVehicles = vehicles;
    _cachedVehiclesExpiresAt = Date.now() + VEHICLE_CACHE_TTL_MS;
    return vehicles;
  }

  /**
   * Invalidate cached vehicle classes when admin modifies rates.
   */
  invalidateVehicleCache(): void {
    _cachedVehicles = null;
    _cachedVehiclesExpiresAt = 0;
  }

  /**
   * Analyzes an array of shipment items and computes total weight, volume,
   * dimensions bounding box, pallet counts, and handling classifications.
   */
  analyzeShipmentCargo(items: HeavyProductShippingInput[]): CargoAnalysisResult {
    // 1. Filter out digital items (physical delivery fee is strictly zero for digital items)
    const physicalItems = items.filter((it) => !it.isDigital);

    if (physicalItems.length === 0) {
      return {
        isHeavyOrBulky: false,
        classification: 'STANDARD_PARCEL',
        totalActualWeightKg: 0,
        totalVolumetricWeightKg: 0,
        chargeableWeightKg: 0,
        totalVolumeCbm: 0,
        palletCount: 0,
        maxItemLengthCm: 0,
        maxItemWidthCm: 0,
        maxItemHeightCm: 0,
        isFragile: false,
        isOversized: false,
        requiresForklift: false,
        requiresCrane: false,
        requiresSpecialVehicle: false,
        hasIncompleteSpecs: false,
        cargoDescriptionAr: 'منتجات رقمية (لا توجد بضائع فيزيائية)',
      };
    }

    let totalWeight = 0;
    let totalVolumeCbm = 0;
    let totalPalletCount = 0;
    let maxLength = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    let isFragile = false;
    let isOversized = false;
    let requiresForklift = false;
    let requiresCrane = false;
    let requiresSpecialVehicle = false;
    let specialVehicleType: string | undefined;

    let hasIncompleteSpecs = false;
    let incompleteReason: string | undefined;

    let detectedClassification: HeavyCargoClassification = 'STANDARD_PARCEL';

    for (const item of physicalItems) {
      const qty = Math.max(1, item.quantity);
      const catSlug = (item.categorySlug || '').toLowerCase();
      const catAr = item.categoryNameAr || '';
      const catEn = (item.categoryNameEn || '').toLowerCase();
      const unit = (item.sellingUnit || 'PIECE').toUpperCase();

      let meta: any = {};
      if (item.unitDimensionsJson) {
        try {
          meta = JSON.parse(item.unitDimensionsJson);
        } catch {
          meta = {};
        }
      }

      // Detect product category family
      const isTilesCategory =
        catSlug.includes('tile') ||
        catSlug.includes('ceramic') ||
        catSlug.includes('porcelain') ||
        catAr.includes('سيراميك') ||
        catAr.includes('بورسلان') ||
        catAr.includes('بلاط') ||
        catEn.includes('tile');

      const isMarbleCategory =
        catSlug.includes('marble') ||
        catSlug.includes('granite') ||
        catAr.includes('رخام') ||
        catAr.includes('جرانيت') ||
        catEn.includes('marble') ||
        catEn.includes('granite');

      const isMachineryCategory =
        catSlug.includes('machin') ||
        catSlug.includes('industrial') ||
        catAr.includes('معدات') ||
        catAr.includes('ماكينات') ||
        catAr.includes('صناعي') ||
        catEn.includes('machin');

      const isSolarOrGenerator =
        catSlug.includes('solar') ||
        catSlug.includes('generator') ||
        catAr.includes('طاقة شمسية') ||
        catAr.includes('مولد') ||
        catAr.includes('إنفرتر') ||
        catAr.includes('بطاريات');

      const isDoorCategory =
        catSlug.includes('door') ||
        catSlug.includes('gate') ||
        catAr.includes('أبواب') ||
        catAr.includes('باب') ||
        catEn.includes('door');

      const isApplianceCategory =
        catSlug.includes('appliance') ||
        catAr.includes('أجهزة منزلية') ||
        catAr.includes('ثلاجات') ||
        catAr.includes('غسالات') ||
        catAr.includes('مكيفات');

      // 1. TILES & PORCELAIN CALCULATION
      if (isTilesCategory || unit === 'SQM' || (unit === 'BOX' && isTilesCategory)) {
        detectedClassification = 'TILES_PORCELAIN';
        isFragile = true;

        const sqmPerBox = meta.sqmPerBox ? parseFloat(meta.sqmPerBox) : 1.44;
        const boxWeight = meta.boxWeightKg ? parseFloat(meta.boxWeightKg) : (item.packageWeightKg || 28.0);
        const boxesPerPallet = meta.boxesPerPallet ? parseInt(meta.boxesPerPallet, 10) : 48;

        let totalBoxes = 0;
        if (unit === 'SQM') {
          // Quantity is square meters -> convert to boxes
          totalBoxes = Math.ceil(qty / sqmPerBox);
        } else if (unit === 'BOX') {
          totalBoxes = qty;
        } else if (unit === 'PIECE') {
          const piecesPerBox = meta.piecesPerBox ? parseInt(meta.piecesPerBox, 10) : 8;
          totalBoxes = Math.ceil(qty / piecesPerBox);
        } else {
          totalBoxes = qty;
        }

        const itemTotalWeight = totalBoxes * boxWeight;
        const pallets = Math.ceil(totalBoxes / boxesPerPallet);

        totalWeight += itemTotalWeight;
        totalPalletCount += pallets;

        // Pallet dimensions: 120cm x 80cm x 100cm (0.96 CBM per pallet)
        totalVolumeCbm += pallets * 0.96;
        maxLength = Math.max(maxLength, 120);
        maxWidth = Math.max(maxWidth, 80);
        maxHeight = Math.max(maxHeight, 100);

        if (pallets >= 2 || itemTotalWeight >= 2000) {
          requiresForklift = true;
        }
      }
      // 2. MARBLE & GRANITE CALCULATION
      else if (isMarbleCategory || unit === 'SLAB') {
        detectedClassification = 'MARBLE_GRANITE';
        isFragile = true;
        requiresSpecialVehicle = true;
        specialVehicleType = 'FLATBED';

        // Marble density = 2,700 kg/m³
        const densityKgPerM3 = 2700.0;
        const slabThicknessMm = meta.slabThicknessMm ? parseFloat(meta.slabThicknessMm) : 20.0;
        const slabLengthCm = meta.slabLengthCm ? parseFloat(meta.slabLengthCm) : (item.lengthCm || 260.0);
        const slabWidthCm = meta.slabWidthCm ? parseFloat(meta.slabWidthCm) : (item.widthCm || 160.0);

        const slabVolumeM3 = (slabLengthCm / 100) * (slabWidthCm / 100) * (slabThicknessMm / 1000);
        const singleSlabWeightKg = slabVolumeM3 * densityKgPerM3;

        let itemWeight = 0;
        if (item.weightKg && item.weightKg > 0) {
          itemWeight = item.weightKg * qty;
        } else if (item.packageWeightKg && item.packageWeightKg > 0) {
          itemWeight = item.packageWeightKg * qty;
        } else {
          itemWeight = singleSlabWeightKg * qty;
        }

        // Add protective packaging and A-frame rack weight (~75 kg per shipment)
        const packagingRackWeight = 75.0;
        totalWeight += itemWeight + packagingRackWeight;

        // Marble slab volume on rack
        const rackVolumeCbm = (slabLengthCm / 100) * (100 / 100) * (slabWidthCm / 100); // slabs stand vertically on A-frame
        totalVolumeCbm += Math.max(0.8, rackVolumeCbm);

        maxLength = Math.max(maxLength, slabLengthCm);
        maxWidth = Math.max(maxWidth, 100);
        maxHeight = Math.max(maxHeight, slabWidthCm);

        requiresCrane = true;
        requiresForklift = true;
      }
      // 3. MACHINERY & GENERATORS & SOLAR
      else if (isMachineryCategory || isSolarOrGenerator) {
        detectedClassification = isMachineryCategory ? 'MACHINERY_INDUSTRIAL' : 'GENERATORS_SOLAR';

        const itemWeight = (item.weightKg || item.packageWeightKg || 0) * qty;
        const itemL = item.lengthCm || item.packageLengthCm || 0;
        const itemW = item.widthCm || item.packageWidthCm || 0;
        const itemH = item.heightCm || item.packageHeightCm || 0;

        if (itemWeight === 0 && (itemL === 0 || itemW === 0 || itemH === 0)) {
          hasIncompleteSpecs = true;
          incompleteReason = `مواصفات الشحن الفيزيائية غير مكتملة للمنتج "${item.name || 'معدة / ماكينة'}". يلزم تحديد الوزن والأبعاد بدقة.`;
        }

        totalWeight += itemWeight;
        const singleVolCbm = (itemL * itemW * itemH) / 1_000_000;
        totalVolumeCbm += singleVolCbm * qty;

        maxLength = Math.max(maxLength, itemL);
        maxWidth = Math.max(maxWidth, itemW);
        maxHeight = Math.max(maxHeight, itemH);

        if (itemWeight > 1000 || item.requiresForklift) {
          requiresForklift = true;
        }
        if (itemWeight > 3000 || item.requiresCrane) {
          requiresCrane = true;
          requiresSpecialVehicle = true;
          specialVehicleType = 'FLATBED';
        }
        if (item.isOversized) isOversized = true;
      }
      // 4. DOORS & GATES
      else if (isDoorCategory) {
        detectedClassification = 'DOORS_GATES';
        const doorL = item.lengthCm || item.packageLengthCm || 215.0; // standard door height ~215cm
        const doorW = item.widthCm || item.packageWidthCm || 100.0;
        const doorH = item.heightCm || item.packageHeightCm || 10.0;
        const doorWeight = (item.weightKg || item.packageWeightKg || 45.0) * qty;

        totalWeight += doorWeight;
        const doorVolCbm = (doorL * doorW * doorH) / 1_000_000;
        totalVolumeCbm += doorVolCbm * qty;

        maxLength = Math.max(maxLength, doorL);
        maxWidth = Math.max(maxWidth, doorW);
        maxHeight = Math.max(maxHeight, doorH);

        if (item.isFragile) isFragile = true;
      }
      // 5. HOME APPLIANCES
      else if (isApplianceCategory) {
        detectedClassification = 'HOME_APPLIANCES';
        const appWeight = (item.weightKg || item.packageWeightKg || 60.0) * qty;
        const appL = item.lengthCm || item.packageLengthCm || 70.0;
        const appW = item.widthCm || item.packageWidthCm || 70.0;
        const appH = item.heightCm || item.packageHeightCm || 175.0; // refrigerator height

        totalWeight += appWeight;
        const appVolCbm = (appL * appW * appH) / 1_000_000;
        totalVolumeCbm += appVolCbm * qty;

        maxLength = Math.max(maxLength, appL);
        maxWidth = Math.max(maxWidth, appW);
        maxHeight = Math.max(maxHeight, appH);

        isFragile = true; // appliances must be secured against impacts
      }
      // 6. GENERAL PHYSICAL MERCHANDISE
      else {
        const itemWeight = (item.weightKg || item.packageWeightKg || 1.0) * qty;
        const itemL = item.lengthCm || item.packageLengthCm || 20.0;
        const itemW = item.widthCm || item.packageWidthCm || 20.0;
        const itemH = item.heightCm || item.packageHeightCm || 20.0;

        totalWeight += itemWeight;
        const volCbm = (itemL * itemW * itemH) / 1_000_000;
        totalVolumeCbm += volCbm * qty;

        maxLength = Math.max(maxLength, itemL);
        maxWidth = Math.max(maxWidth, itemW);
        maxHeight = Math.max(maxHeight, itemH);

        if (item.palletCount) totalPalletCount += item.palletCount;
        if (item.isFragile) isFragile = true;
        if (item.isOversized) isOversized = true;
        if (item.requiresForklift) requiresForklift = true;
        if (item.requiresCrane) requiresCrane = true;
        if (item.requiresSpecialVehicle) {
          requiresSpecialVehicle = true;
          specialVehicleType = item.specialVehicleType || 'FLATBED';
        }
      }
    }

    // Volumetric weight divisor: 5000 (standard IATA freight divisor for cm³ to kg)
    // 1 CBM = 200 kg volumetric
    const totalVolumetricWeightKg = Math.round((totalVolumeCbm * 1_000_000) / 5000 * 100) / 100;
    const chargeableWeightKg = Math.max(Math.round(totalWeight * 100) / 100, totalVolumetricWeightKg);

    // Oversized classification: single dimension > 240cm or weight > 1000kg
    if (maxLength > 240 || maxWidth > 240 || maxHeight > 220 || chargeableWeightKg > 1000) {
      isOversized = true;
    }

    // Heavy threshold: > 30 kg, volume > 0.15 CBM, or pallets > 0, or specialized heavy category
    const isHeavyOrBulky =
      chargeableWeightKg > 30.0 ||
      totalVolumeCbm > 0.15 ||
      totalPalletCount > 0 ||
      maxLength > 150 ||
      requiresForklift ||
      requiresCrane ||
      requiresSpecialVehicle ||
      detectedClassification !== 'STANDARD_PARCEL';

    if (!isHeavyOrBulky) {
      detectedClassification = 'STANDARD_PARCEL';
    } else if (detectedClassification === 'STANDARD_PARCEL') {
      detectedClassification = 'GENERAL_BULKY';
    }

    let cargoDescriptionAr = 'بضاعة عادية / طرد قياسي';
    switch (detectedClassification) {
      case 'TILES_PORCELAIN':
        cargoDescriptionAr = `سيراميك وبورسلان (${totalPalletCount} طبلية / ${Math.round(totalWeight)} كجم)`;
        break;
      case 'MARBLE_GRANITE':
        cargoDescriptionAr = `ألواح رخام وجرانيت ثقيلة (${Math.round(totalWeight)} كجم على قواعد A-Frame)`;
        break;
      case 'MACHINERY_INDUSTRIAL':
        cargoDescriptionAr = `معدات وآلات صناعية ثقيلة (${Math.round(totalWeight)} كجم)`;
        break;
      case 'GENERATORS_SOLAR':
        cargoDescriptionAr = `أنظمة طاقة شمسية ومولدات (${Math.round(totalWeight)} كجم)`;
        break;
      case 'DOORS_GATES':
        cargoDescriptionAr = `أبواب ومستلزمات إنشائية (${Math.round(totalWeight)} كجم)`;
        break;
      case 'HOME_APPLIANCES':
        cargoDescriptionAr = `أجهزة كهربائية ومنزلية كبيرة (${Math.round(totalWeight)} كجم)`;
        break;
      case 'GENERAL_BULKY':
        cargoDescriptionAr = `بضائع ثقيلة أو كبيرة الحجم (${Math.round(totalWeight)} كجم)`;
        break;
    }

    return {
      isHeavyOrBulky,
      classification: detectedClassification,
      totalActualWeightKg: Math.round(totalWeight * 100) / 100,
      totalVolumetricWeightKg,
      chargeableWeightKg,
      totalVolumeCbm: Math.round(totalVolumeCbm * 100) / 100,
      palletCount: totalPalletCount,
      maxItemLengthCm: maxLength,
      maxItemWidthCm: maxWidth,
      maxItemHeightCm: maxHeight,
      isFragile,
      isOversized,
      requiresForklift,
      requiresCrane,
      requiresSpecialVehicle,
      specialVehicleType,
      hasIncompleteSpecs,
      incompleteReason,
      cargoDescriptionAr,
    };
  }

  /**
   * Selects the smallest optimal active vehicle that satisfies payload weight,
   * volume capacity, cargo dimensions, and special equipment requirements.
   */
  async matchVehicle(cargo: CargoAnalysisResult): Promise<VehicleMatchResult> {
    const vehicles = await this.getActiveVehicleClasses();

    if (cargo.hasIncompleteSpecs) {
      return {
        matchedVehicle: null,
        candidateVehicles: [],
        exceedsCapacity: false,
        requiresManualQuote: true,
        reason: cargo.incompleteReason || 'INCOMPLETE_SPECIFICATIONS',
      };
    }

    // Filter vehicles that can safely carry this cargo
    const candidates = vehicles.filter((v) => {
      // 1. Payload weight check
      if (cargo.chargeableWeightKg > v.maxWeightKg) return false;

      // 2. Volume capacity check
      if (cargo.totalVolumeCbm > v.maxVolumeCbm) return false;

      // 3. Dimensional limits check
      if (cargo.maxItemLengthCm > v.maxLengthCm) return false;
      if (cargo.maxItemWidthCm > v.maxWidthCm) return false;
      if (cargo.maxItemHeightCm > v.maxHeightCm) return false;

      // 4. Special flatbed/lowbed requirements
      if (cargo.requiresSpecialVehicle) {
        if (cargo.specialVehicleType === 'FLATBED' && v.code !== 'FLATBED' && v.code !== 'LOWBED') {
          return false;
        }
        if (cargo.specialVehicleType === 'LOWBED' && v.code !== 'LOWBED') {
          return false;
        }
      }

      return true;
    });

    if (candidates.length === 0) {
      return {
        matchedVehicle: null,
        candidateVehicles: [],
        exceedsCapacity: true,
        requiresManualQuote: true,
        reason: `وزن أو أبعاد الشحنة (${cargo.chargeableWeightKg} كجم، الطول ${cargo.maxItemLengthCm} سم) تتجاوز قدرة جميع مركبات النقل القياسية المتاحة. يلزم تسعير يدوي خاص (MANUAL_QUOTE).`,
      };
    }

    // Smallest adequate vehicle is the first candidate (sorted by priority / payload)
    const selected = candidates[0];

    // Lowbed always requires manual quote confirmation for route clearances
    if (selected.code === 'LOWBED') {
      return {
        matchedVehicle: selected,
        candidateVehicles: candidates,
        exceedsCapacity: false,
        requiresManualQuote: true,
        reason: 'الشحنة تتطلب لوبد نقل ثقيل (LOWBED). يلزم تسعير خاص وتنسيق مسبق لتصاريح الطرق.',
      };
    }

    return {
      matchedVehicle: selected,
      candidateVehicles: candidates,
      exceedsCapacity: false,
      requiresManualQuote: false,
    };
  }

  /**
   * Authoritative Heavy & Bulky Delivery Fee Calculation.
   *
   * Local Formula:
   *  Vehicle Minimum Base Charge
   *  + Zone Distance Charge ((distanceKm - 10) * ratePerKm)
   *  + Loading Charge (Labor)
   *  + Unloading Charge (Labor)
   *  + Forklift Charge (if required)
   *  + Crane Charge (if required)
   *  + Special Handling (Fragile / A-Frame)
   *  + Access Surcharge
   *  - Delivery Discount
   *
   * Inter-Governorate Formula:
   *  Vehicle Dedicated Hire Rate (NOT parcel per-kg rate)
   *  + Loading / Unloading Charges
   *  + Special Handling (Crane / Forklift)
   *  + Route Surcharges
   *  - Delivery Discount
   */
  calculateHeavyPricing(
    cargo: CargoAnalysisResult,
    vehicleMatch: VehicleMatchResult,
    options: HeavyPricingCalculationOptions,
  ): HeavyPricingBreakdown {
    const {
      distanceKm,
      isInterGovernorate,
      accessSurcharge = 0.0,
      discountAmount = 0.0,
    } = options;

    const currency = 'YER';

    // 1. Handle Manual Quote Triggers
    if (vehicleMatch.requiresManualQuote || !vehicleMatch.matchedVehicle) {
      return {
        deliveryMode: 'MANUAL_QUOTE',
        quoteType: 'MANUAL_QUOTE_REQUIRED',
        quoteReason: vehicleMatch.reason || 'MANUAL_QUOTE_REQUIRED',
        requiresManualQuote: true,
        vehicleCode: vehicleMatch.matchedVehicle?.code || 'SPECIAL_TRANSPORT',
        vehicleNameAr: vehicleMatch.matchedVehicle?.nameAr || 'وسيلة نقل خاصة مخصصة',
        vehicleNameEn: vehicleMatch.matchedVehicle?.nameEn || 'Dedicated Special Transport',
        palletCount: cargo.palletCount,
        baseFee: 0,
        distanceCharge: 0,
        loadingFee: 0,
        unloadingFee: 0,
        forkliftFee: 0,
        craneFee: 0,
        specialHandlingFee: 0,
        accessSurcharge: 0,
        deliveryDiscount: 0,
        finalDeliveryFee: 0,
        currency,
        explanationAr: vehicleMatch.reason || 'يلزم تسعير يدوي مخصص لهذه الشحنة الكبيرة.',
      };
    }

    const vehicle = vehicleMatch.matchedVehicle;

    // 2. Mode Determination
    let mode: DeliveryCalculationMode;
    if (cargo.requiresCrane || vehicle.code === 'FLATBED' || vehicle.code === 'LOWBED') {
      mode = 'OVERSIZED_SPECIAL';
    } else if (isInterGovernorate) {
      mode = 'HEAVY_INTER_GOVERNORATE';
    } else {
      mode = 'HEAVY_LOCAL';
    }

    let baseFee = 0;
    let distanceCharge = 0;

    if (isInterGovernorate) {
      // Dedicated vehicle hire rate for inter-governorate transport (§5 of prompt)
      // Never multiply tons by standard parcel per-kg rate!
      baseFee = vehicle.interGovernorateHireRate;
      distanceCharge = 0; // Included in dedicated inter-city hire rate
    } else {
      // Local city transport: base charge covers up to 10 km
      baseFee = vehicle.baseFee;
      if (distanceKm > 10.0) {
        const extraKm = distanceKm - 10.0;
        distanceCharge = Math.round(extraKm * vehicle.ratePerKm);
      }
    }

    // Labor loading & unloading charges
    let loadingFee = vehicle.loadingFee;
    let unloadingFee = vehicle.unloadingFee;

    // Additional pallet labor: 500 YER per pallet if pallet count > 2
    if (cargo.palletCount > 2) {
      const extraPalletLabor = (cargo.palletCount - 2) * 500.0;
      loadingFee += extraPalletLabor;
      unloadingFee += extraPalletLabor;
    }

    // Special Equipment fees
    const forkliftFee = cargo.requiresForklift ? 15000.0 : 0.0;
    const craneFee = cargo.requiresCrane ? 35000.0 : 0.0;

    // Fragile / Slab rack handling fee
    const specialHandlingFee = cargo.isFragile ? 5000.0 : 0.0;

    // Compute subtotal before discounts
    const subtotal =
      baseFee +
      distanceCharge +
      loadingFee +
      unloadingFee +
      forkliftFee +
      craneFee +
      specialHandlingFee +
      accessSurcharge;

    const applicableDiscount = Math.min(subtotal, Math.max(0, discountAmount));
    const finalDeliveryFee = Math.max(0, Math.round(subtotal - applicableDiscount));

    const explanationAr = isInterGovernorate
      ? `نقل مخصص بين المحافظات بواسطة ${vehicle.nameAr} (أجرة المركبة: ${baseFee.toLocaleString()} ر.ي + خدمات التحميل والمناولة)`
      : `توصيل بضائع ثقيلة داخل المحافظة بواسطة ${vehicle.nameAr} (أجرة الأساس: ${baseFee.toLocaleString()} ر.ي + رسوم المسافة والمناولة)`;

    return {
      deliveryMode: mode,
      quoteType: 'AUTOMATIC_QUOTE',
      requiresManualQuote: false,
      vehicleCode: vehicle.code,
      vehicleNameAr: vehicle.nameAr,
      vehicleNameEn: vehicle.nameEn,
      palletCount: cargo.palletCount,
      baseFee,
      distanceCharge,
      loadingFee,
      unloadingFee,
      forkliftFee,
      craneFee,
      specialHandlingFee,
      accessSurcharge,
      deliveryDiscount: applicableDiscount,
      finalDeliveryFee,
      currency,
      explanationAr,
    };
  }
}

export const heavyDeliveryService = new HeavyDeliveryService();
