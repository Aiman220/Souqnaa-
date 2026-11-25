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
  | 'OVERSIZED_FURNITURE'
  | 'CONSTRUCTION_MATERIALS'
  | 'GENERAL_BULKY'
  | 'STANDARD_PARCEL';

export type ProductDeliveryClass =
  | 'DIGITAL'
  | 'STANDARD_PARCEL'
  | 'HEAVY_FREIGHT'
  | 'REQUIRES_SELLER_CONFIRMATION';

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
  loadingRequirements?: string | null;
  unloadingRequirements?: string | null;
  isSpecialHandling?: boolean | null;
  categorySlug?: string | null;
  categoryNameAr?: string | null;
  categoryNameEn?: string | null;
  isDigital?: boolean | null;
}

export interface ItemDeliveryEligibility {
  deliveryClass: ProductDeliveryClass;
  isHeavy: boolean;
  isDigital: boolean;
  requiresSellerConfirmation: boolean;
  incompleteReason?: string;
  quoteReason?: string;
  calculatedWeightKg: number;
  calculatedVolumeCbm: number;
  palletCount: number;
  dimensions: { lengthCm: number; widthCm: number; heightCm: number };
  requiresForklift: boolean;
  requiresCrane: boolean;
  requiresSpecialVehicle: boolean;
  specialVehicleType?: string;
  cargoClassification: HeavyCargoClassification;
  cargoDescriptionAr: string;
}

export interface ShipmentPartitionResult {
  hasMixedShipments: boolean;
  digitalItems: HeavyProductShippingInput[];
  standardItems: HeavyProductShippingInput[];
  heavyItems: HeavyProductShippingInput[];
  unconfirmedItems: HeavyProductShippingInput[];
}

export interface DeliverySubShipment {
  id: string;
  sellerId?: string;
  storeId?: string;
  storeName?: string;
  shipmentType: 'STANDARD' | 'HEAVY' | 'DIGITAL';
  titleAr: string;
  titleEn: string;
  items: Array<{
    productId?: string;
    name?: string;
    quantity: number;
    weightKg?: number;
    isDigital?: boolean;
    sellingUnit?: string;
  }>;
  totalWeightKg: number;
  deliveryFee: number;
  baseFee: number;
  distanceCharge: number;
  handlingFee: number;
  deliveryMode: string;
  quoteType?: QuoteType;
  requiresManualQuote?: boolean;
  quoteReason?: string;
  vehicleCode?: string;
  vehicleNameAr?: string;
  vehicleNameEn?: string;
  palletCount?: number;
  requiresForklift?: boolean;
  requiresCrane?: boolean;
  allowedDeliveryMethods: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    surcharge: number;
    isAvailable?: boolean;
    estimatedHoursMin?: number;
    estimatedHoursMax?: number;
  }>;
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
  tripsCount: number;
  reason?: string;
}

export interface HeavyPricingCalculationOptions {
  distanceKm: number;
  isInterGovernorate: boolean;
  originGovernorate?: string;
  destinationGovernorate?: string;
  accessSurcharge?: number;
  discountAmount?: number;
  allowSpecialChargesDiscount?: boolean;
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
  tripsCount: number;
  baseFee: number;
  distanceCharge: number;
  loadingFee: number;
  unloadingFee: number;
  forkliftFee: number;
  craneFee: number;
  specialHandlingFee: number;
  accessSurcharge: number;
  mandatorySpecialHandlingFee: number;
  deliveryDiscount: number;
  finalDeliveryFee: number;
  currency: string;
  explanationAr: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Default Heavy Vehicle Classes (Production Fallback)
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_HEAVY_VEHICLES = [
  {
    code: 'PICKUP_1T',
    nameAr: 'شاحنة صغيرة / ونيت (1 طن)',
    nameEn: 'Pickup Truck 1 Ton',
    maxWeightKg: 1000.0,
    maxVolumeCbm: 3.5,
    maxLengthCm: 220.0,
    maxWidthCm: 160.0,
    maxHeightCm: 140.0,
    baseFee: 7000.0,
    ratePerKm: 250.0,
    interGovernorateHireRate: 35000.0,
    loadingFee: 2000.0,
    unloadingFee: 2000.0,
    requiresCrane: false,
    requiresForklift: false,
    isActive: true,
    priority: 1,
  },
  {
    code: 'LIGHT_TRUCK_3T',
    nameAr: 'شاحنة خفيفة 3 طن (دينا)',
    nameEn: 'Light Truck 3 Ton (Dyna)',
    maxWeightKg: 3000.0,
    maxVolumeCbm: 12.0,
    maxLengthCm: 420.0,
    maxWidthCm: 200.0,
    maxHeightCm: 200.0,
    baseFee: 15000.0,
    ratePerKm: 450.0,
    interGovernorateHireRate: 65000.0,
    loadingFee: 4000.0,
    unloadingFee: 4000.0,
    requiresCrane: false,
    requiresForklift: false,
    isActive: true,
    priority: 2,
  },
  {
    code: 'MEDIUM_TRUCK_5T',
    nameAr: 'شاحنة متوسطة 5 طن',
    nameEn: 'Medium Truck 5 Ton',
    maxWeightKg: 5000.0,
    maxVolumeCbm: 20.0,
    maxLengthCm: 600.0,
    maxWidthCm: 220.0,
    maxHeightCm: 220.0,
    baseFee: 25000.0,
    ratePerKm: 600.0,
    interGovernorateHireRate: 95000.0,
    loadingFee: 7000.0,
    unloadingFee: 7000.0,
    requiresCrane: false,
    requiresForklift: false,
    isActive: true,
    priority: 3,
  },
  {
    code: 'HEAVY_TRUCK_10T',
    nameAr: 'شاحنة ثقيلة 10 طن',
    nameEn: 'Heavy Truck 10 Ton',
    maxWeightKg: 10000.0,
    maxVolumeCbm: 35.0,
    maxLengthCm: 800.0,
    maxWidthCm: 240.0,
    maxHeightCm: 240.0,
    baseFee: 45000.0,
    ratePerKm: 900.0,
    interGovernorateHireRate: 160000.0,
    loadingFee: 12000.0,
    unloadingFee: 12000.0,
    requiresCrane: false,
    requiresForklift: false,
    isActive: true,
    priority: 4,
  },
  {
    code: 'TRAILER_30T',
    nameAr: 'قاطرة / تريلا 30 طن',
    nameEn: 'Semi-Trailer 30 Ton',
    maxWeightKg: 30000.0,
    maxVolumeCbm: 65.0,
    maxLengthCm: 1360.0,
    maxWidthCm: 245.0,
    maxHeightCm: 260.0,
    baseFee: 90000.0,
    ratePerKm: 1500.0,
    interGovernorateHireRate: 320000.0,
    loadingFee: 25000.0,
    unloadingFee: 25000.0,
    requiresCrane: false,
    requiresForklift: true,
    isActive: true,
    priority: 5,
  },
  {
    code: 'FLATBED',
    nameAr: 'سطحة مخصصة للرخام والحديد (15 طن)',
    nameEn: 'Flatbed Carrier 15 Ton',
    maxWeightKg: 15000.0,
    maxVolumeCbm: 40.0,
    maxLengthCm: 900.0,
    maxWidthCm: 250.0,
    maxHeightCm: 250.0,
    baseFee: 55000.0,
    ratePerKm: 1000.0,
    interGovernorateHireRate: 180000.0,
    loadingFee: 15000.0,
    unloadingFee: 15000.0,
    requiresCrane: true,
    requiresForklift: true,
    isActive: true,
    priority: 6,
  },
  {
    code: 'LOWBED',
    nameAr: 'لوبد نقل معدات ثقيلة (50 طن)',
    nameEn: 'Lowbed Heavy Equipment Carrier 50 Ton',
    maxWeightKg: 50000.0,
    maxVolumeCbm: 100.0,
    maxLengthCm: 1600.0,
    maxWidthCm: 300.0,
    maxHeightCm: 320.0,
    baseFee: 150000.0,
    ratePerKm: 2500.0,
    interGovernorateHireRate: 500000.0,
    loadingFee: 35000.0,
    unloadingFee: 35000.0,
    requiresCrane: true,
    requiresForklift: true,
    isActive: true,
    priority: 7,
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// In-Memory Vehicle Cache
// ──────────────────────────────────────────────────────────────────────────────

let _cachedVehicles: any[] | null = null;
let _cachedVehiclesExpiresAt = 0;
const VEHICLE_CACHE_TTL_MS = 60 * 1000;

export class HeavyDeliveryService {
  /**
   * Load active heavy vehicle classes from DB with in-memory caching
   * and fallback to predefined classes if database table is unseeded.
   */
  async getActiveVehicleClasses(): Promise<any[]> {
    if (_cachedVehicles && Date.now() < _cachedVehiclesExpiresAt) {
      return _cachedVehicles;
    }
    try {
      const vehicles = await prisma.heavyVehicleClass.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      });
      if (vehicles && vehicles.length > 0) {
        _cachedVehicles = vehicles;
        _cachedVehiclesExpiresAt = Date.now() + VEHICLE_CACHE_TTL_MS;
        return vehicles;
      }
    } catch (_) {
      // Fallback below
    }
    _cachedVehicles = DEFAULT_HEAVY_VEHICLES;
    _cachedVehiclesExpiresAt = Date.now() + VEHICLE_CACHE_TTL_MS;
    return DEFAULT_HEAVY_VEHICLES;
  }

  /**
   * Invalidate cached vehicle classes when admin modifies rates.
   */
  invalidateVehicleCache(): void {
    _cachedVehicles = null;
    _cachedVehiclesExpiresAt = 0;
  }

  /**
   * Product-Driven Delivery Eligibility Evaluator.
   *
   * Dynamically evaluates an individual product's actual physical transportation attributes:
   *  - Selling unit & quantity calculations (SQM, BOX, SLAB, TON, PIECE)
   *  - Weight, dimensional limits, and volumetric displacement
   *  - Equipment requirements (crane, forklift, flatbed, lowbed)
   *  - Missing attribute detection with safe seller confirmation workflow
   *
   * CRITICAL: Never classifies a product as heavy simply because of its category name/slug!
   */
  evaluateItemEligibility(item: HeavyProductShippingInput): ItemDeliveryEligibility {
    // 1. Digital products are strictly non-physical
    if (item.isDigital) {
      return {
        deliveryClass: 'DIGITAL',
        isHeavy: false,
        isDigital: true,
        requiresSellerConfirmation: false,
        calculatedWeightKg: 0,
        calculatedVolumeCbm: 0,
        palletCount: 0,
        dimensions: { lengthCm: 0, widthCm: 0, heightCm: 0 },
        requiresForklift: false,
        requiresCrane: false,
        requiresSpecialVehicle: false,
        cargoClassification: 'STANDARD_PARCEL',
        cargoDescriptionAr: 'منتج رقمي (لا يتطلب شحن فيزيائي)',
      };
    }

    const qty = Math.max(1, item.quantity || 1);
    const unit = (item.sellingUnit || 'PIECE').toUpperCase();

    let meta: any = {};
    if (item.unitDimensionsJson) {
      try {
        meta = typeof item.unitDimensionsJson === 'string'
          ? JSON.parse(item.unitDimensionsJson)
          : item.unitDimensionsJson;
      } catch {
        meta = {};
      }
    }

    let calculatedWeightKg = 0;
    let calculatedVolumeCbm = 0;
    let palletCount = item.palletCount || 0;
    let lengthCm = item.lengthCm || item.packageLengthCm || 0;
    let widthCm = item.widthCm || item.packageWidthCm || 0;
    let heightCm = item.heightCm || item.packageHeightCm || 0;

    let requiresForklift = Boolean(item.requiresForklift);
    let requiresCrane = Boolean(item.requiresCrane);
    let requiresSpecialVehicle = Boolean(item.requiresSpecialVehicle);
    let specialVehicleType = item.specialVehicleType || undefined;
    let isFragile = Boolean(item.isFragile);
    let isOversized = Boolean(item.isOversized);

    const catSlug = (item.categorySlug || '').toLowerCase();
    const catAr = item.categoryNameAr || '';
    const catEn = (item.categoryNameEn || '').toLowerCase();
    const prodName = (item.name || '').toLowerCase();

    const isTileItem =
      catSlug.includes('tile') ||
      catAr.includes('بلاط') ||
      catAr.includes('سيراميك') ||
      prodName.includes('سيراميك') ||
      prodName.includes('بورسلان');

    // 2. Selling Unit Calculations
    if (unit === 'SQM' || (unit === 'BOX' && (meta.sqmPerBox || meta.boxWeightKg || meta.boxesPerPallet || isTileItem))) {
      const sqmPerBox = meta.sqmPerBox ? parseFloat(meta.sqmPerBox) : 1.44;
      const boxWeight = meta.boxWeightKg ? parseFloat(meta.boxWeightKg) : (item.packageWeightKg || item.weightKg || 25.0);
      const boxesPerPallet = meta.boxesPerPallet ? parseInt(meta.boxesPerPallet, 10) : 48;

      let totalBoxes = 0;
      if (unit === 'SQM') {
        totalBoxes = Math.ceil(qty / sqmPerBox);
      } else {
        totalBoxes = qty;
      }

      calculatedWeightKg = totalBoxes * boxWeight;

      if (totalBoxes >= boxesPerPallet || palletCount > 0) {
        palletCount = Math.max(palletCount, Math.ceil(totalBoxes / boxesPerPallet));
        calculatedVolumeCbm = palletCount * 0.96; // 120 x 80 x 100 cm standard pallet
        lengthCm = Math.max(lengthCm, 120);
        widthCm = Math.max(widthCm, 80);
        heightCm = Math.max(heightCm, 100);
      } else {
        lengthCm = Math.max(lengthCm, 60);
        widthCm = Math.max(widthCm, 60);
        heightCm = Math.max(heightCm, Math.min(100, totalBoxes * 8));
        calculatedVolumeCbm = (lengthCm * widthCm * heightCm) / 1_000_000;
      }

      if (calculatedWeightKg >= 2000 || palletCount >= 2) {
        requiresForklift = true;
      }
      isFragile = true;
    } else if (unit === 'SLAB' || item.packagingType === 'SLAB_RACK_A_FRAME') {
      const slabThicknessMm = meta.slabThicknessMm ? parseFloat(meta.slabThicknessMm) : 20.0;
      const slabLengthCm = meta.slabLengthCm ? parseFloat(meta.slabLengthCm) : (lengthCm || 260.0);
      const slabWidthCm = meta.slabWidthCm ? parseFloat(meta.slabWidthCm) : (widthCm || 160.0);
      lengthCm = slabLengthCm;
      widthCm = slabWidthCm;
      heightCm = Math.max(heightCm, 100.0);

      const slabVolumeM3 = (slabLengthCm / 100) * (slabWidthCm / 100) * (slabThicknessMm / 1000);
      const densityKgPerM3 = 2700.0;
      const singleSlabWeightKg = (item.weightKg && item.weightKg > 0)
        ? item.weightKg
        : (slabVolumeM3 * densityKgPerM3);

      const rackWeight = 75.0; // A-frame rack weight
      calculatedWeightKg = (singleSlabWeightKg * qty) + rackWeight;
      calculatedVolumeCbm = Math.max(0.8, (slabLengthCm / 100) * (1.0) * (slabWidthCm / 100));

      requiresSpecialVehicle = true;
      specialVehicleType = 'FLATBED';
      requiresCrane = true;
      requiresForklift = true;
      isOversized = true;
      isFragile = true;
    } else if (unit === 'TON') {
      calculatedWeightKg = qty * 1000.0;
      requiresForklift = true;
      if (calculatedWeightKg >= 5000) {
        requiresCrane = true;
      }
      if (lengthCm > 0 && widthCm > 0 && heightCm > 0) {
        calculatedVolumeCbm = ((lengthCm * widthCm * heightCm) / 1_000_000) * qty;
      }
    } else {
      // General item
      const singleWeight = item.weightKg || item.packageWeightKg || 0;
      calculatedWeightKg = singleWeight * qty;
      if (lengthCm > 0 && widthCm > 0 && heightCm > 0) {
        calculatedVolumeCbm = ((lengthCm * widthCm * heightCm) / 1_000_000) * qty;
      }
    }

    // 3. Safe validation / seller confirmation workflow for missing attributes
    const hasHeavyIndicators =
      Boolean(item.requiresSpecialVehicle) ||
      Boolean(item.requiresCrane) ||
      Boolean(item.requiresForklift) ||
      Boolean(item.isOversized) ||
      (palletCount > 0) ||
      ['PALLET', 'SLAB_RACK_A_FRAME', 'WOODEN_CRATE'].includes(item.packagingType || '') ||
      Boolean(item.loadingRequirements) ||
      Boolean(item.unloadingRequirements) ||
      ['TON', 'SLAB'].includes(unit) ||
      catSlug.includes('machin') || catSlug.includes('industrial') ||
      catAr.includes('معدات') || catAr.includes('ماكينات') ||
      prodName.includes('ماكينة') || prodName.includes('معدة صناعية') ||
      prodName.includes('مخرطة');

    const hasMissingPhysicalSpecs =
      calculatedWeightKg === 0 && (lengthCm === 0 || widthCm === 0 || heightCm === 0);

    if (hasHeavyIndicators && hasMissingPhysicalSpecs) {
      return {
        deliveryClass: 'REQUIRES_SELLER_CONFIRMATION',
        isHeavy: true,
        isDigital: false,
        requiresSellerConfirmation: true,
        incompleteReason: `مواصفات الشحن الفيزيائية (الوزن والأبعاد) غير مكتملة للمنتج "${item.name || 'المنتج'}". يلزم تأكيد وسيلة النقل والتسعير مع البائع قبل إتمام الطلب.`,
        quoteReason: 'MISSING_TRANSPORT_ATTRIBUTES',
        calculatedWeightKg: 0,
        calculatedVolumeCbm: 0,
        palletCount: 0,
        dimensions: { lengthCm: 0, widthCm: 0, heightCm: 0 },
        requiresForklift: Boolean(item.requiresForklift),
        requiresCrane: Boolean(item.requiresCrane),
        requiresSpecialVehicle: Boolean(item.requiresSpecialVehicle),
        specialVehicleType: item.specialVehicleType || undefined,
        cargoClassification: 'GENERAL_BULKY',
        cargoDescriptionAr: `بضاعة تتطلب مواصفات نقل إضافية (${item.name || ''})`,
      };
    }

    // 4. Determine Heavy Freight vs Standard Parcel dynamically
    const volumetricWeightKg = (calculatedVolumeCbm * 1_000_000) / 5000;
    const chargeableWeightKg = Math.max(calculatedWeightKg, volumetricWeightKg);

    const maxDimensionCm = Math.max(lengthCm, widthCm, heightCm);
    const girthCm = lengthCm + 2 * (widthCm + heightCm);
    const singlePieceWeight = (item.weightKg || item.packageWeightKg || (qty > 0 ? calculatedWeightKg / qty : 0));

    // Dynamic threshold: An item is only heavy if it physically exceeds standard courier handling
    const isHeavyFreight =
      requiresSpecialVehicle ||
      requiresCrane ||
      requiresForklift ||
      isOversized ||
      palletCount > 0 ||
      item.packagingType === 'SLAB_RACK_A_FRAME' ||
      singlePieceWeight > 30.0 ||   // Standard courier single parcel limit is 30 kg
      calculatedWeightKg > 50.0 ||   // Combined weight limit for parcel line is 50 kg
      maxDimensionCm > 140.0 ||      // Single parcel maximum length is 140 cm
      girthCm > 300.0 ||             // Standard postal girth limit
      calculatedVolumeCbm > 0.18;    // Max parcel volume

    if (!isHeavyFreight) {
      return {
        deliveryClass: 'STANDARD_PARCEL',
        isHeavy: false,
        isDigital: false,
        requiresSellerConfirmation: false,
        calculatedWeightKg: Math.round(calculatedWeightKg * 100) / 100,
        calculatedVolumeCbm: Math.round(calculatedVolumeCbm * 1000) / 1000,
        palletCount: 0,
        dimensions: { lengthCm, widthCm, heightCm },
        requiresForklift: false,
        requiresCrane: false,
        requiresSpecialVehicle: false,
        cargoClassification: 'STANDARD_PARCEL',
        cargoDescriptionAr: `طرد قياسي (${Math.round(calculatedWeightKg * 10) / 10} كجم)`,
      };
    }

    // 5. Heavy Cargo Classification
    let cargoClassification: HeavyCargoClassification = 'GENERAL_BULKY';
    if (unit === 'SLAB' || item.packagingType === 'SLAB_RACK_A_FRAME' || catSlug.includes('marble') || catAr.includes('رخام') || prodName.includes('رخام')) {
      cargoClassification = 'MARBLE_GRANITE';
    } else if (unit === 'SQM' || (unit === 'BOX' && (palletCount > 0 || calculatedWeightKg >= 50)) || catSlug.includes('tile') || catAr.includes('بلاط') || catAr.includes('سيراميك') || prodName.includes('سيراميك') || prodName.includes('بورسلان')) {
      cargoClassification = 'TILES_PORCELAIN';
    } else if (catSlug.includes('furniture') || catAr.includes('أثاث') || catAr.includes('كنب') || catAr.includes('غرف نوم') || catAr.includes('خزائن') || prodName.includes('كنب') || prodName.includes('دولاب') || prodName.includes('طاولة') || prodName.includes('سرير')) {
      cargoClassification = 'OVERSIZED_FURNITURE';
    } else if (unit === 'TON' || catSlug.includes('construction') || catSlug.includes('cement') || catSlug.includes('steel') || catAr.includes('أسمنت') || catAr.includes('حديد') || catAr.includes('بلك') || catAr.includes('طوب') || catAr.includes('مواد بناء') || prodName.includes('أسمنت') || prodName.includes('حديد تسليح') || prodName.includes('بلك')) {
      cargoClassification = 'CONSTRUCTION_MATERIALS';
    } else if (catSlug.includes('generator') || catSlug.includes('solar') || catAr.includes('طاقة شمسية') || catAr.includes('مولد') || prodName.includes('مولد')) {
      cargoClassification = 'GENERATORS_SOLAR';
    } else if (catSlug.includes('machin') || catSlug.includes('industrial') || catAr.includes('معدات') || catAr.includes('ماكينة') || prodName.includes('ماكينة')) {
      cargoClassification = 'MACHINERY_INDUSTRIAL';
    } else if (catSlug.includes('door') || catAr.includes('أبواب') || catAr.includes('باب') || maxDimensionCm >= 200) {
      cargoClassification = 'DOORS_GATES';
    } else if (catSlug.includes('appliance') || catAr.includes('أجهزة منزلية') || prodName.includes('ثلاجة') || prodName.includes('غسالة')) {
      cargoClassification = 'HOME_APPLIANCES';
    }

    let descAr = `بضائع ثقيلة (${Math.round(calculatedWeightKg)} كجم)`;
    if (cargoClassification === 'TILES_PORCELAIN') {
      descAr = `سيراميك وبورسلان (${palletCount} طبلية / ${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'MARBLE_GRANITE') {
      descAr = `ألواح رخام وجرانيت ثقيلة (${Math.round(calculatedWeightKg)} كجم على سطحة وقواعد)`;
    } else if (cargoClassification === 'OVERSIZED_FURNITURE') {
      descAr = `أثاث ومفروشات كبيرة الحجم (${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'CONSTRUCTION_MATERIALS') {
      descAr = `مواد بناء وإنشاءات ثقيلة (${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'MACHINERY_INDUSTRIAL') {
      descAr = `معدات وآلات صناعية ثقيلة (${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'GENERATORS_SOLAR') {
      descAr = `أنظمة طاقة شمسية ومولدات (${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'DOORS_GATES') {
      descAr = `أبواب ومستلزمات إنشائية (${Math.round(calculatedWeightKg)} كجم)`;
    } else if (cargoClassification === 'HOME_APPLIANCES') {
      descAr = `أجهزة كهربائية ومنزلية كبيرة (${Math.round(calculatedWeightKg)} كجم)`;
    }

    return {
      deliveryClass: 'HEAVY_FREIGHT',
      isHeavy: true,
      isDigital: false,
      requiresSellerConfirmation: false,
      calculatedWeightKg: Math.round(calculatedWeightKg * 100) / 100,
      calculatedVolumeCbm: Math.round(calculatedVolumeCbm * 1000) / 1000,
      palletCount,
      dimensions: { lengthCm, widthCm, heightCm },
      requiresForklift,
      requiresCrane,
      requiresSpecialVehicle,
      specialVehicleType,
      cargoClassification,
      cargoDescriptionAr: descAr,
    };
  }

  /**
   * Partitions items into compatible sub-shipments:
   *  - digitalItems (0 delivery fee)
   *  - standardItems (standard parcel rates)
   *  - heavyItems (dedicated heavy vehicle hire)
   *  - unconfirmedItems (missing specifications requiring seller confirmation)
   */
  partitionShipment(items: HeavyProductShippingInput[]): ShipmentPartitionResult {
    const digitalItems: HeavyProductShippingInput[] = [];
    const standardItems: HeavyProductShippingInput[] = [];
    const heavyItems: HeavyProductShippingInput[] = [];
    const unconfirmedItems: HeavyProductShippingInput[] = [];

    for (const item of items) {
      if (item.isDigital) {
        digitalItems.push(item);
        continue;
      }

      const eligibility = this.evaluateItemEligibility(item);

      if (eligibility.deliveryClass === 'REQUIRES_SELLER_CONFIRMATION') {
        unconfirmedItems.push(item);
        heavyItems.push(item);
      } else if (eligibility.deliveryClass === 'HEAVY_FREIGHT') {
        heavyItems.push(item);
      } else {
        standardItems.push(item);
      }
    }

    const hasMixedShipments =
      (standardItems.length > 0 && heavyItems.length > 0) ||
      (digitalItems.length > 0 && (standardItems.length > 0 || heavyItems.length > 0));

    return {
      hasMixedShipments,
      digitalItems,
      standardItems,
      heavyItems,
      unconfirmedItems,
    };
  }

  /**
   * Product-Driven Cargo Analysis.
   *
   * Analyzes an array of shipment items and computes total weight, volume,
   * dimensions bounding box, pallet counts, and handling classifications.
   *
   * Uses evaluateItemEligibility for product-driven classification.
   * NEVER classifies an item as heavy based solely on category name!
   */
  analyzeShipmentCargo(items: HeavyProductShippingInput[]): CargoAnalysisResult {
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

    let hasAnyHeavyItem = false;
    const classificationsCount: Record<HeavyCargoClassification, number> = {
      STANDARD_PARCEL: 0,
      GENERAL_BULKY: 0,
      TILES_PORCELAIN: 0,
      MARBLE_GRANITE: 0,
      MACHINERY_INDUSTRIAL: 0,
      GENERATORS_SOLAR: 0,
      DOORS_GATES: 0,
      HOME_APPLIANCES: 0,
      OVERSIZED_FURNITURE: 0,
      CONSTRUCTION_MATERIALS: 0,
    };

    for (const item of physicalItems) {
      const eligibility = this.evaluateItemEligibility(item);

      if (eligibility.deliveryClass === 'REQUIRES_SELLER_CONFIRMATION') {
        hasIncompleteSpecs = true;
        incompleteReason = eligibility.incompleteReason;
        hasAnyHeavyItem = true;
      } else if (eligibility.deliveryClass === 'HEAVY_FREIGHT') {
        hasAnyHeavyItem = true;
      }

      totalWeight += eligibility.calculatedWeightKg;
      totalVolumeCbm += eligibility.calculatedVolumeCbm;
      totalPalletCount += eligibility.palletCount;

      maxLength = Math.max(maxLength, eligibility.dimensions.lengthCm);
      maxWidth = Math.max(maxWidth, eligibility.dimensions.widthCm);
      maxHeight = Math.max(maxHeight, eligibility.dimensions.heightCm);

      if (eligibility.requiresForklift) requiresForklift = true;
      if (eligibility.requiresCrane) requiresCrane = true;
      if (eligibility.requiresSpecialVehicle) {
        requiresSpecialVehicle = true;
        specialVehicleType = eligibility.specialVehicleType || specialVehicleType;
      }
      if (item.isFragile || eligibility.cargoClassification === 'MARBLE_GRANITE' || eligibility.cargoClassification === 'TILES_PORCELAIN') {
        isFragile = true;
      }
      if (item.isOversized) isOversized = true;

      classificationsCount[eligibility.cargoClassification] = (classificationsCount[eligibility.cargoClassification] || 0) + 1;
    }

    // Volumetric weight divisor: 5000 (IATA freight divisor: cm³ / 5000 = kg)
    const totalVolumetricWeightKg = Math.round(((totalVolumeCbm * 1_000_000) / 5000) * 100) / 100;
    const chargeableWeightKg = Math.max(Math.round(totalWeight * 100) / 100, totalVolumetricWeightKg);

    // Oversized check for total combined shipment bounding box
    if (maxLength > 240 || maxWidth > 240 || maxHeight > 220 || chargeableWeightKg > 1000) {
      isOversized = true;
    }

    // Heavy classification check:
    // Strictly product-driven: item explicitly requires heavy transport, or combined cargo exceeds courier capability
    const isHeavyOrBulky =
      hasAnyHeavyItem ||
      chargeableWeightKg > 50.0 ||
      totalVolumeCbm > 0.20 ||
      totalPalletCount > 0 ||
      maxLength > 150 ||
      requiresForklift ||
      requiresCrane ||
      requiresSpecialVehicle;

    // Pick dominant cargo classification
    let detectedClassification: HeavyCargoClassification = 'STANDARD_PARCEL';
    if (!isHeavyOrBulky) {
      detectedClassification = 'STANDARD_PARCEL';
    } else {
      let maxCount = 0;
      for (const [cls, count] of Object.entries(classificationsCount)) {
        if (cls !== 'STANDARD_PARCEL' && count > maxCount) {
          maxCount = count;
          detectedClassification = cls as HeavyCargoClassification;
        }
      }
      if (detectedClassification === 'STANDARD_PARCEL') {
        detectedClassification = 'GENERAL_BULKY';
      }
    }

    let cargoDescriptionAr = 'بضاعة عادية / طرد قياسي';
    switch (detectedClassification) {
      case 'TILES_PORCELAIN':
        cargoDescriptionAr = `سيراميك وبورسلان (${totalPalletCount} طبلية / ${Math.round(totalWeight)} كجم)`;
        break;
      case 'MARBLE_GRANITE':
        cargoDescriptionAr = `ألواح رخام وجرانيت ثقيلة (${Math.round(totalWeight)} كجم على قواعد)`;
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
        tripsCount: 1,
        reason: cargo.incompleteReason || 'INCOMPLETE_SPECIFICATIONS',
      };
    }

    // Filter vehicles that can safely carry this cargo (considering single-trip or multi-trip capacity)
    const validCandidates: Array<{ vehicle: any; tripsCount: number; hireCostScore: number }> = [];

    for (const v of vehicles) {
      // 1. Dimensional limits check for single item physical fit
      if (cargo.maxItemLengthCm > v.maxLengthCm) continue;
      if (cargo.maxItemWidthCm > v.maxWidthCm) continue;
      if (cargo.maxItemHeightCm > v.maxHeightCm) continue;

      // 2. Special flatbed/lowbed requirements
      if (cargo.requiresSpecialVehicle) {
        if (cargo.specialVehicleType === 'FLATBED' && v.code !== 'FLATBED' && v.code !== 'LOWBED') {
          continue;
        }
        if (cargo.specialVehicleType === 'LOWBED' && v.code !== 'LOWBED') {
          continue;
        }
      }

      // LOWBED is strictly reserved for oversized machinery or explicit LOWBED special transport requests
      if (v.code === 'LOWBED' && cargo.specialVehicleType !== 'LOWBED' && cargo.classification !== 'MACHINERY_INDUSTRIAL') {
        continue;
      }

      // 3. Calculate trips required based on weight payload and volume capacity
      const tripsByWeight = Math.ceil(cargo.chargeableWeightKg / v.maxWeightKg);
      const tripsByVolume = Math.ceil(cargo.totalVolumeCbm / v.maxVolumeCbm);
      const tripsCount = Math.max(1, tripsByWeight, tripsByVolume);

      // Excessive trip count check (more than 10 trips requires manual quote / dedicated fleet dispatch)
      if (tripsCount > 10) continue;

      // Score by total vehicle hire cost to pick the most economical vehicle
      const hireCostScore = (v.baseFee || 10000) * tripsCount;

      validCandidates.push({ vehicle: v, tripsCount, hireCostScore });
    }

    if (validCandidates.length === 0) {
      return {
        matchedVehicle: null,
        candidateVehicles: [],
        exceedsCapacity: true,
        requiresManualQuote: true,
        tripsCount: 1,
        reason: `وزن أو أبعاد الشحنة (${cargo.chargeableWeightKg} كجم، الطول ${cargo.maxItemLengthCm} سم) تتجاوز قدرة المركبات المتاحة أو تتطلب شحن أسطول كبير. يلزم تسعير يدوي خاص (MANUAL_QUOTE).`,
      };
    }

    // Sort by: lowest trip count, then lowest hire cost, then vehicle priority
    validCandidates.sort((a, b) => {
      if (a.tripsCount !== b.tripsCount) return a.tripsCount - b.tripsCount;
      if (a.hireCostScore !== b.hireCostScore) return a.hireCostScore - b.hireCostScore;
      return (a.vehicle.priority || 0) - (b.vehicle.priority || 0);
    });

    const bestMatch = validCandidates[0];
    const selected = bestMatch.vehicle;
    const tripsCount = bestMatch.tripsCount;

    // Lowbed always requires manual quote confirmation for route clearances
    if (selected.code === 'LOWBED') {
      return {
        matchedVehicle: selected,
        candidateVehicles: validCandidates.map((c) => c.vehicle),
        exceedsCapacity: false,
        requiresManualQuote: true,
        tripsCount,
        reason: 'الشحنة تتطلب لوبد نقل ثقيل (LOWBED). يلزم تسعير خاص وتنسيق مسبق لتصاريح الطرق.',
      };
    }

    return {
      matchedVehicle: selected,
      candidateVehicles: validCandidates.map((c) => c.vehicle),
      exceedsCapacity: false,
      requiresManualQuote: false,
      tripsCount,
    };
  }

  /**
   * Authoritative Heavy & Bulky Delivery Fee Calculation.
   *
   * Local Formula:
   *  Vehicle Minimum Base Charge * tripsCount
   *  + Zone Distance Charge ((distanceKm - 10) * ratePerKm * tripsCount)
   *  + Loading Charge (Labor)
   *  + Unloading Charge (Labor)
   *  + Forklift Charge (if required)
   *  + Crane Charge (if required)
   *  + Special Handling (Fragile / A-Frame)
   *  + Access Surcharge
   *  - Delivery Discount (protecting mandatory handling charges)
   *
   * Inter-Governorate Formula:
   *  Vehicle Dedicated Hire Rate * tripsCount (NOT parcel per-kg rate)
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
        tripsCount: vehicleMatch.tripsCount || 1,
        baseFee: 0,
        distanceCharge: 0,
        loadingFee: 0,
        unloadingFee: 0,
        forkliftFee: 0,
        craneFee: 0,
        specialHandlingFee: 0,
        accessSurcharge: 0,
        mandatorySpecialHandlingFee: 0,
        deliveryDiscount: 0,
        finalDeliveryFee: 0,
        currency,
        explanationAr: vehicleMatch.reason || 'يلزم تسعير يدوي مخصص لهذه الشحنة الكبيرة.',
      };
    }

    const vehicle = vehicleMatch.matchedVehicle;
    const tripsCount = vehicleMatch.tripsCount || 1;

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
      // Multiplied by number of trips/vehicles required
      baseFee = Math.round(vehicle.interGovernorateHireRate * tripsCount);
      distanceCharge = 0; // Included in dedicated inter-city hire rate
    } else {
      // Local city transport: base charge covers up to 10 km
      baseFee = Math.round(vehicle.baseFee * tripsCount);
      if (distanceKm > 10.0) {
        const extraKm = distanceKm - 10.0;
        distanceCharge = Math.round(extraKm * vehicle.ratePerKm * tripsCount);
      }
    }

    // Labor loading & unloading charges
    let loadingFee = Math.round(vehicle.loadingFee * tripsCount);
    let unloadingFee = Math.round(vehicle.unloadingFee * tripsCount);

    // Additional pallet labor: 500 YER per pallet if pallet count > 2
    if (cargo.palletCount > 2) {
      const extraPalletLabor = (cargo.palletCount - 2) * 500.0;
      loadingFee += Math.round(extraPalletLabor);
      unloadingFee += Math.round(extraPalletLabor);
    }

    // Special Equipment fees
    const forkliftFee = cargo.requiresForklift ? 15000.0 : 0.0;
    const craneFee = cargo.requiresCrane ? 35000.0 : 0.0;

    // Fragile / Slab rack handling fee
    const specialHandlingFee = cargo.isFragile ? 5000.0 : 0.0;

    // Compute mandatory special handling & equipment charges
    const mandatorySpecialHandlingFee =
      loadingFee +
      unloadingFee +
      forkliftFee +
      craneFee +
      specialHandlingFee +
      accessSurcharge;

    // Compute subtotal before discounts
    const subtotal = baseFee + distanceCharge + mandatorySpecialHandlingFee;

    // Protect mandatory special transport & equipment fees from standard free shipping promotions
    const discountableTransportPortion = (options.allowSpecialChargesDiscount === true)
      ? subtotal
      : (baseFee + distanceCharge);

    const applicableDiscount = Math.min(discountableTransportPortion, Math.max(0, discountAmount));
    const finalDeliveryFee = Math.max(0, Math.round(subtotal - applicableDiscount));

    const tripSuffix = tripsCount > 1 ? ` (${tripsCount} رحلات / مركبات)` : '';
    const explanationAr = isInterGovernorate
      ? `نقل مخصص بين المحافظات بواسطة ${vehicle.nameAr}${tripSuffix} (أجرة المركبة: ${baseFee.toLocaleString()} ر.ي + خدمات التحميل والمناولة)`
      : `توصيل بضائع ثقيلة داخل المحافظة بواسطة ${vehicle.nameAr}${tripSuffix} (أجرة الأساس: ${baseFee.toLocaleString()} ر.ي + رسوم المسافة والمناولة)`;

    return {
      deliveryMode: mode,
      quoteType: 'AUTOMATIC_QUOTE',
      requiresManualQuote: false,
      vehicleCode: vehicle.code,
      vehicleNameAr: vehicle.nameAr,
      vehicleNameEn: vehicle.nameEn,
      palletCount: cargo.palletCount,
      tripsCount,
      baseFee,
      distanceCharge,
      loadingFee,
      unloadingFee,
      forkliftFee,
      craneFee,
      specialHandlingFee,
      accessSurcharge,
      mandatorySpecialHandlingFee,
      deliveryDiscount: applicableDiscount,
      finalDeliveryFee,
      currency,
      explanationAr,
    };
  }
}

export const heavyDeliveryService = new HeavyDeliveryService();
