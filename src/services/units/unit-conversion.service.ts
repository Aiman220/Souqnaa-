/**
 * UnitConversionService — Centralized, decimal-safe unit conversion and measurement engine for SOUQNA.
 *
 * Implements authoritative physical unit conversions, category packaging engines,
 * inventory stock conversions, volumetric/chargeable weight calculations,
 * and freight billing unit pricing bases.
 */

export type ProductSellingUnitCode =
  | 'PIECE'
  | 'BOX'
  | 'SET'
  | 'PACK'
  | 'PAIR'
  | 'KG'
  | 'G'
  | 'METRIC_TON'
  | 'LITER'
  | 'ML'
  | 'METER'
  | 'LINEAR_METER'
  | 'SQM'
  | 'CBM'
  | 'ROLL'
  | 'SLAB'
  | 'PALLET'
  | 'SHEET'
  | 'OTHER';

export type WeightUnitCode = 'G' | 'KG' | 'METRIC_TON';
export type LengthUnitCode = 'MM' | 'CM' | 'M';
export type AreaUnitCode = 'SQCM' | 'SQM';
export type VolumeUnitCode = 'ML' | 'L' | 'CBCM' | 'CBM';

export type FreightBillingUnitCode =
  | 'PER_VEHICLE_TRIP'
  | 'PER_ROUTE'
  | 'PER_TONNE'
  | 'PER_KG'
  | 'PER_CBM'
  | 'PER_PALLET'
  | 'PER_SLAB'
  | 'PER_SHIPMENT'
  | 'PER_KILOMETER';

export interface ProductPackagingSpec {
  piecesPerBox?: number | null;
  sqmPerBox?: number | null;
  sqmPerPiece?: number | null;
  boxesPerPallet?: number | null;
  palletWeightKg?: number | null;
  palletLengthCm?: number | null;
  palletWidthCm?: number | null;
  palletHeightCm?: number | null;
  netWeightKg?: number | null;
  grossWeightKg?: number | null;
  packagingWeightKg?: number | null;
  allowPartialBoxes?: boolean | null;
  roundingMode?: 'UP' | 'DOWN' | 'NEAREST' | null;
  slabThicknessMm?: number | null;
  slabLengthCm?: number | null;
  slabWidthCm?: number | null;
  materialDensityKgPerM3?: number | null;
  slabsPerRack?: number | null;
  rackWeightKg?: number | null;
  rackLengthCm?: number | null;
  rackWidthCm?: number | null;
  rackHeightCm?: number | null;
  metersPerRoll?: number | null;
  fabricWidthCm?: number | null;
  rollWeightKg?: number | null;
  rollDiameterCm?: number | null;
  batteryWeightKg?: number | null;
  isHazmatCargo?: boolean | null;
  customSellingUnitAr?: string | null;
  customSellingUnitEn?: string | null;
  stockStorageUnit?: string | null;
  conversionFactorToStockUnit?: number | null;
}

export interface TilePackagingResult {
  requestedQuantity: number;
  sellingUnit: ProductSellingUnitCode;
  totalBoxes: number;
  totalPieces: number;
  totalCoverageSqm: number;
  palletCount: number;
  netWeightKg: number;
  grossWeightKg: number;
  packagingWeightKg: number;
  volumeCbm: number;
  requiresForklift: boolean;
}

export interface MarblePackagingResult {
  slabCount: number;
  totalAreaSqm: number;
  singleSlabWeightKg: number;
  totalSlabsWeightKg: number;
  racksCount: number;
  totalRackWeightKg: number;
  grossWeightKg: number;
  volumeCbm: number;
  requiresCrane: boolean;
  requiresForklift: boolean;
  requiresFlatbed: boolean;
}

export interface MachineryPackagingResult {
  totalWeightKg: number;
  weightTonnes: number;
  totalVolumeCbm: number;
  requiresForklift: boolean;
  requiresCrane: boolean;
  requiresFlatbedOrLowbed: boolean;
}

export interface FabricPackagingResult {
  totalLinearMeters: number;
  totalRolls: number;
  totalWeightKg: number;
  totalVolumeCbm: number;
}

export class UnitConversionService {
  // ────────────────────────────────────────────────────────────────────────────
  // Validation Helpers
  // ────────────────────────────────────────────────────────────────────────────

  static validatePositive(value: number, fieldName: string): void {
    if (isNaN(value) || !isFinite(value) || value <= 0) {
      throw new Error(`Invalid measurement: ${fieldName} must be a positive number greater than 0.`);
    }
  }

  static validateNonNegative(value: number, fieldName: string): void {
    if (isNaN(value) || !isFinite(value) || value < 0) {
      throw new Error(`Invalid measurement: ${fieldName} cannot be negative.`);
    }
  }

  private static cleanPrecision(val: number): number {
    if (isNaN(val) || !isFinite(val)) return val;
    return parseFloat(val.toPrecision(12));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Unit Normalizers
  // ────────────────────────────────────────────────────────────────────────────

  static normalizeSellingUnit(unit?: string | null): ProductSellingUnitCode {
    if (!unit || !unit.trim()) return 'PIECE';
    const u = unit.trim().toUpperCase();
    if (u === 'TON' || u === 'TONS' || u === 'TONNE' || u === 'TONNES' || u === 'T' || u === 'طن' || u === 'طن متري') {
      return 'METRIC_TON';
    }
    if (u === 'KG' || u === 'KGS' || u === 'KILO' || u === 'KILOGRAMS' || u === 'كجم' || u === 'كيلو' || u === 'كيلوجرام') {
      return 'KG';
    }
    if (u === 'G' || u === 'GM' || u === 'GMS' || u === 'GRAM' || u === 'GRAMS' || u === 'جم' || u === 'جرام') {
      return 'G';
    }
    if (u === 'L' || u === 'LITRE' || u === 'LITRES' || u === 'LITERS' || u === 'لتر') {
      return 'LITER';
    }
    if (u === 'ML' || u === 'MILLILITRE' || u === 'MILLILITER' || u === 'مل' || u === 'ملليلتر') {
      return 'ML';
    }
    if (u === 'M2' || u === 'M²' || u === 'SQM' || u === 'SQ_METER' || u === 'SQUARE_METRE' || u === 'م²' || u === 'متر مربع') {
      return 'SQM';
    }
    if (u === 'M3' || u === 'M³' || u === 'CBM' || u === 'CU_METER' || u === 'CUBIC_METRE' || u === 'م³' || u === 'متر مكعب') {
      return 'CBM';
    }
    if (u === 'LM' || u === 'LINEAR_METER' || u === 'LINEAR_METRE' || u === 'م طولي') {
      return 'LINEAR_METER';
    }
    if (u === 'M' || u === 'METER' || u === 'METRE' || u === 'م' || u === 'متر') {
      return 'METER';
    }
    if (u === 'PAIR' || u === 'PAIRS' || u === 'PR' || u === 'زوج') {
      return 'PAIR';
    }
    if (u === 'BOX' || u === 'BOXES' || u === 'CARTON' || u === 'CTN' || u === 'صندوق' || u === 'كرتون') {
      return 'BOX';
    }
    if (u === 'SET' || u === 'SETS' || u === 'طقم') {
      return 'SET';
    }
    if (u === 'PACK' || u === 'PACKS' || u === 'PACKAGE' || u === 'عبوة') {
      return 'PACK';
    }
    if (u === 'ROLL' || u === 'ROLLS' || u === 'لفة' || u === 'رول') {
      return 'ROLL';
    }
    if (u === 'SLAB' || u === 'SLABS' || u === 'لوح') {
      return 'SLAB';
    }
    if (u === 'PALLET' || u === 'PALLETS' || u === 'PLT' || u === 'طبلية' || u === 'منصة') {
      return 'PALLET';
    }
    if (u === 'SHEET' || u === 'SHEETS' || u === 'شريحة' || u === 'صفيحة') {
      return 'SHEET';
    }
    if (u === 'OTHER' || u === 'CUSTOM' || u === 'أخرى' || u === 'وحدة أخرى') {
      return 'OTHER';
    }
    return 'PIECE';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Weight Conversions
  // ────────────────────────────────────────────────────────────────────────────

  static convertWeight(value: number, from: WeightUnitCode, to: WeightUnitCode): number {
    this.validateNonNegative(value, 'value');
    if (from === to) return value;

    const toKgMultipliers: Record<WeightUnitCode, number> = {
      G: 0.001,
      KG: 1.0,
      METRIC_TON: 1000.0,
    };

    const inKg = value * toKgMultipliers[from];
    return this.cleanPrecision(inKg / toKgMultipliers[to]);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Length & Dimension Conversions
  // ────────────────────────────────────────────────────────────────────────────

  static convertLength(value: number, from: LengthUnitCode, to: LengthUnitCode): number {
    this.validateNonNegative(value, 'value');
    if (from === to) return value;

    const toMeterMultipliers: Record<LengthUnitCode, number> = {
      MM: 0.001,
      CM: 0.01,
      M: 1.0,
    };

    const inMeters = value * toMeterMultipliers[from];
    return this.cleanPrecision(inMeters / toMeterMultipliers[to]);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Area Conversions
  // ────────────────────────────────────────────────────────────────────────────

  static convertArea(value: number, from: AreaUnitCode, to: AreaUnitCode): number {
    this.validateNonNegative(value, 'value');
    if (from === to) return value;

    const toSqmMultipliers: Record<AreaUnitCode, number> = {
      SQCM: 0.0001,
      SQM: 1.0,
    };

    const inSqm = value * toSqmMultipliers[from];
    return this.cleanPrecision(inSqm / toSqmMultipliers[to]);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Volume & Capacity Conversions
  // ────────────────────────────────────────────────────────────────────────────

  static convertVolume(value: number, from: VolumeUnitCode, to: VolumeUnitCode): number {
    this.validateNonNegative(value, 'value');
    if (from === to) return value;

    const toCbmMultipliers: Record<VolumeUnitCode, number> = {
      ML: 0.000001,
      L: 0.001,
      CBCM: 0.000001,
      CBM: 1.0,
    };

    const inCbm = value * toCbmMultipliers[from];
    return this.cleanPrecision(inCbm / toCbmMultipliers[to]);
  }

  static calculateVolumeFromCm(lengthCm: number, widthCm: number, heightCm: number): number {
    this.validateNonNegative(lengthCm, 'lengthCm');
    this.validateNonNegative(widthCm, 'widthCm');
    this.validateNonNegative(heightCm, 'heightCm');
    return (lengthCm * widthCm * heightCm) / 1000000.0;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Volumetric & Chargeable Weight
  // ────────────────────────────────────────────────────────────────────────────

  static calculateVolumetricWeight(
    volumeCbm: number,
    divisor = 5000.0,
    kgPerCbm?: number,
  ): number {
    this.validateNonNegative(volumeCbm, 'volumeCbm');
    if (kgPerCbm && kgPerCbm > 0) {
      return volumeCbm * kgPerCbm;
    }
    const volumeCm3 = volumeCbm * 1000000.0;
    return volumeCm3 / (divisor > 0 ? divisor : 5000.0);
  }

  static calculateChargeableWeight(actualWeightKg: number, volumetricWeightKg: number): number {
    this.validateNonNegative(actualWeightKg, 'actualWeightKg');
    this.validateNonNegative(volumetricWeightKg, 'volumetricWeightKg');
    return actualWeightKg > volumetricWeightKg ? actualWeightKg : volumetricWeightKg;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Category-Specific Calculation Engines
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Calculates Ceramic Tiles & Porcelain packaging, box count, pallet count, and weights.
   */
  static calculateTilePackaging(params: {
    requestedQuantity: number;
    sellingUnit: ProductSellingUnitCode;
    spec: ProductPackagingSpec;
    defaultSqmPerBox?: number;
    defaultBoxWeightKg?: number;
  }): TilePackagingResult {
    const {
      requestedQuantity,
      sellingUnit,
      spec,
      defaultSqmPerBox = 1.44,
      defaultBoxWeightKg = 25.0,
    } = params;

    this.validatePositive(requestedQuantity, 'requestedQuantity');

    const sqmPerBox = spec.sqmPerBox && spec.sqmPerBox > 0 ? spec.sqmPerBox : defaultSqmPerBox;
    const piecesPerBox = spec.piecesPerBox && spec.piecesPerBox > 0 ? spec.piecesPerBox : 4;
    const boxesPerPallet = spec.boxesPerPallet && spec.boxesPerPallet > 0 ? spec.boxesPerPallet : 48;
    const boxWeightKg = spec.grossWeightKg && spec.grossWeightKg > 0
      ? spec.grossWeightKg
      : (spec.netWeightKg && spec.netWeightKg > 0 ? spec.netWeightKg : defaultBoxWeightKg);
    const emptyPalletWeightKg = spec.palletWeightKg && spec.palletWeightKg > 0 ? spec.palletWeightKg : 20.0;

    let totalBoxes = 0.0;
    let totalCoverageSqm = 0.0;
    let totalPieces = 0;

    if (sellingUnit === 'SQM') {
      const rawBoxes = requestedQuantity / sqmPerBox;
      if (spec.allowPartialBoxes) {
        totalBoxes = parseFloat(rawBoxes.toFixed(2));
      } else {
        totalBoxes = spec.roundingMode === 'DOWN' ? Math.floor(rawBoxes) : Math.ceil(rawBoxes);
        if (totalBoxes < 1.0) totalBoxes = 1.0;
      }
      totalCoverageSqm = totalBoxes * sqmPerBox;
      totalPieces = Math.round(totalBoxes * piecesPerBox);
    } else if (sellingUnit === 'BOX') {
      totalBoxes = requestedQuantity;
      totalCoverageSqm = totalBoxes * sqmPerBox;
      totalPieces = Math.round(totalBoxes * piecesPerBox);
    } else if (sellingUnit === 'PIECE') {
      totalPieces = Math.round(requestedQuantity);
      const rawBoxes = totalPieces / piecesPerBox;
      totalBoxes = spec.allowPartialBoxes ? parseFloat(rawBoxes.toFixed(2)) : Math.ceil(rawBoxes);
      totalCoverageSqm = totalPieces * (sqmPerBox / piecesPerBox);
    } else if (sellingUnit === 'PALLET') {
      totalBoxes = requestedQuantity * boxesPerPallet;
      totalCoverageSqm = totalBoxes * sqmPerBox;
      totalPieces = Math.round(totalBoxes * piecesPerBox);
    } else {
      totalBoxes = requestedQuantity;
      totalCoverageSqm = totalBoxes * sqmPerBox;
      totalPieces = Math.round(totalBoxes * piecesPerBox);
    }

    const palletCount = Math.ceil(totalBoxes / boxesPerPallet);
    const netWeightKg = totalBoxes * (boxWeightKg * 0.95);
    const packagingWeightKg = (totalBoxes * (boxWeightKg * 0.05)) + (palletCount * emptyPalletWeightKg);
    const grossWeightKg = (totalBoxes * boxWeightKg) + (palletCount * emptyPalletWeightKg);

    let volumeCbm = 0.0;
    if (palletCount > 0 && totalBoxes >= 10) {
      volumeCbm = palletCount * 0.96;
    } else {
      volumeCbm = totalBoxes * 0.025;
    }

    const requiresForklift = grossWeightKg >= 2000.0 || palletCount >= 2;

    return {
      requestedQuantity,
      sellingUnit,
      totalBoxes,
      totalPieces,
      totalCoverageSqm: parseFloat(totalCoverageSqm.toFixed(2)),
      palletCount,
      netWeightKg: parseFloat(netWeightKg.toFixed(2)),
      grossWeightKg: parseFloat(grossWeightKg.toFixed(2)),
      packagingWeightKg: parseFloat(packagingWeightKg.toFixed(2)),
      volumeCbm: parseFloat(volumeCbm.toFixed(3)),
      requiresForklift,
    };
  }

  /**
   * Calculates Marble and Granite slabs, dimensions, weight, and A-frame rack requirements.
   */
  static calculateMarblePackaging(params: {
    requestedQuantity: number;
    sellingUnit: ProductSellingUnitCode;
    spec: ProductPackagingSpec;
    verifiedSlabWeightKg?: number;
  }): MarblePackagingResult {
    const { requestedQuantity, sellingUnit, spec, verifiedSlabWeightKg } = params;
    this.validatePositive(requestedQuantity, 'requestedQuantity');

    const thicknessMm = spec.slabThicknessMm && spec.slabThicknessMm > 0 ? spec.slabThicknessMm : 20.0;
    const lengthCm = spec.slabLengthCm && spec.slabLengthCm > 0 ? spec.slabLengthCm : 260.0;
    const widthCm = spec.slabWidthCm && spec.slabWidthCm > 0 ? spec.slabWidthCm : 160.0;
    const density = spec.materialDensityKgPerM3 && spec.materialDensityKgPerM3 > 0
      ? spec.materialDensityKgPerM3
      : 2700.0;
    const slabsPerRack = spec.slabsPerRack && spec.slabsPerRack > 0 ? spec.slabsPerRack : 14;
    const rackWeight = spec.rackWeightKg && spec.rackWeightKg > 0 ? spec.rackWeightKg : 75.0;

    const singleSlabAreaSqm = (lengthCm / 100.0) * (widthCm / 100.0);
    const singleSlabVolumeM3 = singleSlabAreaSqm * (thicknessMm / 1000.0);

    const singleSlabWeightKg = verifiedSlabWeightKg && verifiedSlabWeightKg > 0
      ? verifiedSlabWeightKg
      : (singleSlabVolumeM3 * density);

    let slabCount = 0;
    let totalAreaSqm = 0.0;

    if (sellingUnit === 'SQM') {
      slabCount = Math.ceil(requestedQuantity / singleSlabAreaSqm);
      if (slabCount < 1) slabCount = 1;
      totalAreaSqm = slabCount * singleSlabAreaSqm;
    } else {
      slabCount = Math.round(requestedQuantity);
      if (slabCount < 1) slabCount = 1;
      totalAreaSqm = slabCount * singleSlabAreaSqm;
    }

    const racksCount = Math.ceil(slabCount / slabsPerRack);
    const totalSlabsWeightKg = slabCount * singleSlabWeightKg;
    const totalRackWeightKg = racksCount * rackWeight;
    const grossWeightKg = totalSlabsWeightKg + totalRackWeightKg;

    const volumeCbm = racksCount * ((lengthCm / 100.0) * 1.1 * ((widthCm + 20) / 100.0));

    return {
      slabCount,
      totalAreaSqm: parseFloat(totalAreaSqm.toFixed(2)),
      singleSlabWeightKg: parseFloat(singleSlabWeightKg.toFixed(2)),
      totalSlabsWeightKg: parseFloat(totalSlabsWeightKg.toFixed(2)),
      racksCount,
      totalRackWeightKg: parseFloat(totalRackWeightKg.toFixed(2)),
      grossWeightKg: parseFloat(grossWeightKg.toFixed(2)),
      volumeCbm: parseFloat(volumeCbm.toFixed(3)),
      requiresCrane: true,
      requiresForklift: true,
      requiresFlatbed: true,
    };
  }

  /**
   * Calculates Heavy Machinery, Generators, and Industrial Equipment.
   */
  static calculateMachineryPackaging(params: {
    requestedQuantity: number;
    unitWeightKg: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    transportFrameWeightKg?: number;
  }): MachineryPackagingResult {
    const {
      requestedQuantity,
      unitWeightKg,
      lengthCm = 120.0,
      widthCm = 100.0,
      heightCm = 120.0,
      transportFrameWeightKg = 0.0,
    } = params;

    this.validatePositive(requestedQuantity, 'requestedQuantity');
    this.validatePositive(unitWeightKg, 'unitWeightKg');
    this.validateNonNegative(transportFrameWeightKg, 'transportFrameWeightKg');

    const singleGrossWeightKg = unitWeightKg + transportFrameWeightKg;
    const totalWeightKg = singleGrossWeightKg * requestedQuantity;
    const weightTonnes = totalWeightKg / 1000.0;
    const totalVolumeCbm = ((lengthCm * widthCm * heightCm) / 1000000.0) * requestedQuantity;

    const requiresForklift = singleGrossWeightKg >= 1000.0 || totalWeightKg >= 1500.0;
    const requiresCrane = singleGrossWeightKg >= 3000.0 || heightCm >= 240.0 || totalWeightKg >= 10000.0;
    const requiresFlatbedOrLowbed = lengthCm >= 400.0 || widthCm >= 220.0 || weightTonnes >= 12.0;

    return {
      totalWeightKg: parseFloat(totalWeightKg.toFixed(2)),
      weightTonnes: parseFloat(weightTonnes.toFixed(3)),
      totalVolumeCbm: parseFloat(totalVolumeCbm.toFixed(3)),
      requiresForklift,
      requiresCrane,
      requiresFlatbedOrLowbed,
    };
  }

  /**
   * Calculates Fabrics and Textile rolls packaging.
   */
  static calculateFabricPackaging(params: {
    requestedQuantity: number;
    sellingUnit: ProductSellingUnitCode;
    spec: ProductPackagingSpec;
    defaultMetersPerRoll?: number;
    defaultFabricWidthCm?: number;
    defaultRollWeightKg?: number;
  }): FabricPackagingResult {
    const {
      requestedQuantity,
      sellingUnit,
      spec,
      defaultMetersPerRoll = 50.0,
      defaultFabricWidthCm = 150.0,
      defaultRollWeightKg = 18.0,
    } = params;

    this.validatePositive(requestedQuantity, 'requestedQuantity');

    const metersPerRoll = spec.metersPerRoll && spec.metersPerRoll > 0 ? spec.metersPerRoll : defaultMetersPerRoll;
    const fabricWidthCm = spec.fabricWidthCm && spec.fabricWidthCm > 0 ? spec.fabricWidthCm : defaultFabricWidthCm;
    const rollWeightKg = spec.rollWeightKg && spec.rollWeightKg > 0 ? spec.rollWeightKg : defaultRollWeightKg;
    const rollDiameterCm = spec.rollDiameterCm && spec.rollDiameterCm > 0 ? spec.rollDiameterCm : 20.0;

    let totalMeters = 0.0;
    let totalRolls = 0;

    if (sellingUnit === 'LINEAR_METER' || sellingUnit === 'METER') {
      totalMeters = requestedQuantity;
      totalRolls = Math.ceil(requestedQuantity / metersPerRoll);
      if (totalRolls < 1) totalRolls = 1;
    } else if (sellingUnit === 'ROLL') {
      totalRolls = Math.round(requestedQuantity);
      if (totalRolls < 1) totalRolls = 1;
      totalMeters = totalRolls * metersPerRoll;
    } else {
      totalRolls = 1;
      totalMeters = requestedQuantity;
    }

    const totalWeightKg = totalRolls * rollWeightKg;
    const singleRollVolumeCbm = (rollDiameterCm * rollDiameterCm * fabricWidthCm) / 1000000.0;
    const totalVolumeCbm = totalRolls * singleRollVolumeCbm;

    return {
      totalLinearMeters: parseFloat(totalMeters.toFixed(2)),
      totalRolls,
      totalWeightKg: parseFloat(totalWeightKg.toFixed(2)),
      totalVolumeCbm: parseFloat(totalVolumeCbm.toFixed(3)),
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Freight Billing Unit Calculator
  // ────────────────────────────────────────────────────────────────────────────

  static calculateFreightByBillingUnit(params: {
    billingUnit: FreightBillingUnitCode;
    unitRate: number;
    tripsCount?: number;
    roadDistanceKm?: number;
    actualWeightKg?: number;
    chargeableWeightKg?: number;
    volumeCbm?: number;
    palletCount?: number;
    slabCount?: number;
  }): number {
    const {
      billingUnit,
      unitRate,
      tripsCount = 1,
      roadDistanceKm = 0.0,
      actualWeightKg = 0.0,
      chargeableWeightKg = 0.0,
      volumeCbm = 0.0,
      palletCount = 0,
      slabCount = 0,
    } = params;

    this.validateNonNegative(unitRate, 'unitRate');
    const trips = tripsCount > 0 ? tripsCount : 1;

    switch (billingUnit) {
      case 'PER_VEHICLE_TRIP':
        return unitRate * trips;

      case 'PER_ROUTE':
        return unitRate * trips;

      case 'PER_TONNE': {
        const weightKg = chargeableWeightKg > 0 ? chargeableWeightKg : actualWeightKg;
        const tonnes = weightKg / 1000.0;
        return parseFloat((tonnes * unitRate).toFixed(2));
      }

      case 'PER_KG': {
        const weightKg = chargeableWeightKg > 0 ? chargeableWeightKg : actualWeightKg;
        return parseFloat((weightKg * unitRate).toFixed(2));
      }

      case 'PER_CBM':
        return parseFloat((volumeCbm * unitRate).toFixed(2));

      case 'PER_PALLET': {
        const pallets = palletCount > 0 ? palletCount : 1;
        return pallets * unitRate;
      }

      case 'PER_SLAB': {
        const slabs = slabCount > 0 ? slabCount : 1;
        return slabs * unitRate;
      }

      case 'PER_SHIPMENT':
        return unitRate;

      case 'PER_KILOMETER': {
        const km = roadDistanceKm > 0 ? roadDistanceKm : 0.0;
        return parseFloat((km * unitRate * trips).toFixed(2));
      }

      default:
        return unitRate * trips;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Product Selling Unit to Inventory Stock Conversion
  // ────────────────────────────────────────────────────────────────────────────

  static convertSellingQtyToStockQty(
    sellingQty: number,
    sellingUnit: ProductSellingUnitCode,
    spec?: ProductPackagingSpec | null,
  ): number {
    this.validateNonNegative(sellingQty, 'sellingQty');
    if (!spec) return sellingQty;

    if (spec.conversionFactorToStockUnit && spec.conversionFactorToStockUnit > 0) {
      return sellingQty * spec.conversionFactorToStockUnit;
    }

    const storage = (spec.stockStorageUnit || '').toUpperCase().trim();
    if (!storage) return sellingQty;

    // Box to Pieces
    if (sellingUnit === 'BOX' && (storage === 'PIECE' || storage === 'PCS')) {
      const factor = spec.piecesPerBox && spec.piecesPerBox > 0 ? spec.piecesPerBox : 1;
      return sellingQty * factor;
    }

    // Roll to Meters
    if (sellingUnit === 'ROLL' && (storage === 'METER' || storage === 'LINEAR_METER' || storage === 'M')) {
      const factor = spec.metersPerRoll && spec.metersPerRoll > 0 ? spec.metersPerRoll : 50.0;
      return sellingQty * factor;
    }

    // Pallet to Boxes
    if (sellingUnit === 'PALLET' && storage === 'BOX') {
      const factor = spec.boxesPerPallet && spec.boxesPerPallet > 0 ? spec.boxesPerPallet : 48;
      return sellingQty * factor;
    }

    // Metric Ton to Kg
    if (sellingUnit === 'METRIC_TON' && (storage === 'KG' || storage === 'KILOGRAM')) {
      return sellingQty * 1000.0;
    }

    // Liter to mL
    if (sellingUnit === 'LITER' && (storage === 'ML' || storage === 'MILLILITER')) {
      return sellingQty * 1000.0;
    }

    return sellingQty;
  }
}
