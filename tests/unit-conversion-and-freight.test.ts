/**
 * SOUQNA — Authoritative Unit Conversion & Freight Billing Test Suite
 *
 * Validates requirements from Section A through J:
 * 1. Physical unit conversions (Weight, Length, Area, Volume)
 * 2. Volumetric weight and chargeable weight calculation
 * 3. Validation rejection of negative/invalid inputs
 * 4. Tiles & porcelain packaging calculations (m² to boxes, pallets, net/gross weight)
 * 5. Marble & granite packaging calculations (slabs, A-frame racks, verified weight & density)
 * 6. Heavy machinery & equipment packaging calculations (tonnes, crane/forklift thresholds)
 * 7. Fabric & textile packaging calculations (linear meters to rolls, packaging volume)
 * 8. All 9 freight billing units (PER_VEHICLE_TRIP, PER_ROUTE, PER_TONNE, PER_KG, PER_CBM, PER_PALLET, PER_SLAB, PER_SHIPMENT, PER_KILOMETER)
 * 9. Prevention of duplicated vehicle-hire, route, and weight fees
 * 10. Product selling unit to stock inventory conversions
 * 11. HeavyDeliveryService eligibility and dynamic cargo analysis
 * 12. Digital products physical freight exemption
 */

import { UnitConversionService } from '../src/services/units/unit-conversion.service';
import { heavyDeliveryService } from '../src/services/delivery/heavy-delivery.service';

async function runUnitConversionAndFreightTests() {
  console.log('============================================================');
  console.log('📦 SOUQNA — UNIT CONVERSION & FREIGHT BILLING TEST SUITE');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. SI PHYSICAL UNIT CONVERSIONS (Section E)
  // ─────────────────────────────────────────────────────────────
  console.log('[1] Testing Standard SI Unit Conversions...');

  // 1 Tonne = 1,000 kg; 1 kg = 1,000 g
  assert(UnitConversionService.convertWeight(1.0, 'METRIC_TON', 'KG') === 1000.0, '1 metric ton = 1000 kg');
  assert(UnitConversionService.convertWeight(2500.0, 'KG', 'METRIC_TON') === 2.5, '2500 kg = 2.5 metric tons');
  assert(UnitConversionService.convertWeight(1.0, 'KG', 'G') === 1000.0, '1 kg = 1000 g');
  assert(UnitConversionService.convertWeight(500.0, 'G', 'KG') === 0.5, '500 g = 0.5 kg');

  // Length: 1 m = 100 cm = 1,000 mm
  assert(UnitConversionService.convertLength(1.0, 'M', 'CM') === 100.0, '1 m = 100 cm');
  assert(UnitConversionService.convertLength(1.0, 'M', 'MM') === 1000.0, '1 m = 1000 mm');
  assert(UnitConversionService.convertLength(150.0, 'CM', 'M') === 1.5, '150 cm = 1.5 m');
  assert(UnitConversionService.convertLength(2500.0, 'MM', 'M') === 2.5, '2500 mm = 2.5 m');

  // Area: 1 m² = 10,000 cm²
  assert(UnitConversionService.convertArea(1.0, 'SQM', 'SQCM') === 10000.0, '1 m² = 10000 cm²');
  assert(UnitConversionService.convertArea(50000.0, 'SQCM', 'SQM') === 5.0, '50000 cm² = 5.0 m²');

  // Volume: 1 m³ = 1,000,000 cm³ = 1,000 L; 1 L = 1,000 mL
  assert(UnitConversionService.convertVolume(1.0, 'CBM', 'CBCM') === 1000000.0, '1 m³ = 1000000 cm³');
  assert(UnitConversionService.convertVolume(1.0, 'CBM', 'L') === 1000.0, '1 m³ = 1000 L');
  assert(UnitConversionService.convertVolume(1.0, 'L', 'ML') === 1000.0, '1 L = 1000 mL');
  assert(UnitConversionService.convertVolume(2500.0, 'ML', 'L') === 2.5, '2500 mL = 2.5 L');

  // Volume from dimensions
  const volCbm = UnitConversionService.calculateVolumeFromCm(200.0, 100.0, 50.0);
  assert(volCbm === 1.0, `Dimensions 200x100x50 cm = 1.0 m³ (got ${volCbm})`);

  // ─────────────────────────────────────────────────────────────
  // 2. VOLUMETRIC & CHARGEABLE WEIGHT (Section E)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[2] Testing Volumetric & Chargeable Weight...');

  // 1 m³ / 5000 = 200 kg volumetric weight
  const volWeight = UnitConversionService.calculateVolumetricWeight(1.0, 5000.0);
  assert(volWeight === 200.0, `1 m³ with divisor 5000 = 200 kg (got ${volWeight})`);

  // Chargeable weight = max(actual, volumetric)
  assert(UnitConversionService.calculateChargeableWeight(150.0, 200.0) === 200.0, 'Chargeable weight uses volumetric when greater');
  assert(UnitConversionService.calculateChargeableWeight(350.0, 200.0) === 350.0, 'Chargeable weight uses actual when greater');

  // ─────────────────────────────────────────────────────────────
  // 3. VALIDATION RULES (Section E)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[3] Testing Measurement Validation Rules...');

  let negativeRejected = false;
  try {
    UnitConversionService.convertWeight(-10.0, 'KG', 'METRIC_TON');
  } catch {
    negativeRejected = true;
  }
  assert(negativeRejected, 'Negative measurement value is strictly rejected with validation error');

  let invalidDivisorSafe = false;
  try {
    const safeVol = UnitConversionService.calculateVolumetricWeight(1.0, -1);
    invalidDivisorSafe = safeVol === 200.0;
  } catch {
    invalidDivisorSafe = false;
  }
  assert(invalidDivisorSafe, 'Invalid divisor safely defaults to 5000');

  // ─────────────────────────────────────────────────────────────
  // 4. TILES & PORCELAIN PACKAGING ENGINE (Section C)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[4] Testing Ceramic Tiles & Porcelain Packaging Engine...');

  // Scenario: Customer orders 72 m² of tiles (1.44 m²/box, 25 kg/box, 48 boxes/pallet)
  const tileResult = UnitConversionService.calculateTilePackaging({
    requestedQuantity: 72.0,
    sellingUnit: 'SQM',
    spec: {
      sqmPerBox: 1.44,
      piecesPerBox: 4,
      boxesPerPallet: 48,
      grossWeightKg: 25.0,
      palletWeightKg: 20.0,
      allowPartialBoxes: false,
    },
  });

  // 72 / 1.44 = 50 boxes
  assert(tileResult.totalBoxes === 50, `72 m² at 1.44 m²/box requires 50 boxes (got ${tileResult.totalBoxes})`);
  assert(tileResult.totalCoverageSqm === 72.0, `Coverage is 72.0 m² (got ${tileResult.totalCoverageSqm})`);
  assert(tileResult.palletCount === 2, `50 boxes at 48 boxes/pallet requires 2 pallets (got ${tileResult.palletCount})`);
  // Gross weight: 50 * 25 + 2 * 20 = 1250 + 40 = 1290 kg
  assert(tileResult.grossWeightKg === 1290.0, `Gross weight includes packaging & pallets: 1290 kg (got ${tileResult.grossWeightKg})`);
  assert(tileResult.totalPieces === 200, `Total pieces: 50 boxes * 4 = 200 (got ${tileResult.totalPieces})`);

  // Partial box restriction test: seller allows partial boxes vs restricts
  const partialAllowed = UnitConversionService.calculateTilePackaging({
    requestedQuantity: 10.0,
    sellingUnit: 'SQM',
    spec: { sqmPerBox: 1.44, allowPartialBoxes: true },
  });
  assert(partialAllowed.totalBoxes === 6.94, `Partial boxes allowed yields 6.94 boxes (got ${partialAllowed.totalBoxes})`);

  const partialRestricted = UnitConversionService.calculateTilePackaging({
    requestedQuantity: 10.0,
    sellingUnit: 'SQM',
    spec: { sqmPerBox: 1.44, allowPartialBoxes: false },
  });
  assert(partialRestricted.totalBoxes === 7, `Partial boxes restricted rounds up to 7 full boxes (got ${partialRestricted.totalBoxes})`);

  // ─────────────────────────────────────────────────────────────
  // 5. MARBLE & GRANITE PACKAGING ENGINE (Section C)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[5] Testing Marble & Granite Packaging Engine...');

  // Slab dimensions: 260 x 160 cm, thickness 20 mm. Density 2700 kg/m³
  // Area = 2.6 * 1.6 = 4.16 m². Volume = 4.16 * 0.02 = 0.0832 m³.
  // Weight per slab = 0.0832 * 2700 = 224.64 kg
  const marbleResult = UnitConversionService.calculateMarblePackaging({
    requestedQuantity: 5,
    sellingUnit: 'SLAB',
    spec: {
      slabLengthCm: 260.0,
      slabWidthCm: 160.0,
      slabThicknessMm: 20.0,
      materialDensityKgPerM3: 2700.0,
      slabsPerRack: 14,
      rackWeightKg: 75.0,
    },
  });

  assert(marbleResult.slabCount === 5, 'Slab count is 5');
  assert(Math.abs(marbleResult.singleSlabWeightKg - 224.64) < 0.1, `Single slab weight ~ 224.64 kg (got ${marbleResult.singleSlabWeightKg})`);
  assert(marbleResult.racksCount === 1, '5 slabs require 1 A-frame rack');
  // Gross weight: 5 * 224.64 + 75 = 1123.2 + 75 = 1198.2 kg
  assert(Math.abs(marbleResult.grossWeightKg - 1198.2) < 0.2, `Gross weight includes 75 kg rack tare (got ${marbleResult.grossWeightKg})`);
  assert(marbleResult.requiresCrane, 'Marble slabs require crane loading/unloading');
  assert(marbleResult.requiresFlatbed, 'Marble slabs require flatbed carrier');

  // Verified weight override
  const verifiedMarble = UnitConversionService.calculateMarblePackaging({
    requestedQuantity: 2,
    sellingUnit: 'SLAB',
    spec: { rackWeightKg: 75.0, slabsPerRack: 14 },
    verifiedSlabWeightKg: 250.0,
  });
  assert(verifiedMarble.grossWeightKg === 575.0, `Verified weight 250 kg * 2 + 75 kg rack = 575 kg (got ${verifiedMarble.grossWeightKg})`);

  // ─────────────────────────────────────────────────────────────
  // 6. HEAVY MACHINERY & INDUSTRIAL EQUIPMENT (Section C)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[6] Testing Heavy Machinery Packaging Engine...');

  const generator = UnitConversionService.calculateMachineryPackaging({
    requestedQuantity: 1,
    unitWeightKg: 3500.0,
    lengthCm: 280.0,
    widthCm: 140.0,
    heightCm: 180.0,
    transportFrameWeightKg: 150.0,
  });

  assert(generator.totalWeightKg === 3650.0, `Gross weight: 3500 + 150 frame = 3650 kg (got ${generator.totalWeightKg})`);
  assert(generator.weightTonnes === 3.65, `Weight in tonnes: 3.65 t (got ${generator.weightTonnes})`);
  assert(generator.requiresCrane, 'Generator >= 3000 kg requires crane');
  assert(generator.requiresForklift, 'Generator >= 1000 kg requires forklift');

  // ─────────────────────────────────────────────────────────────
  // 7. FABRICS & TEXTILES PACKAGING ENGINE (Section C)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[7] Testing Fabrics & Textiles Packaging Engine...');

  const fabricResult = UnitConversionService.calculateFabricPackaging({
    requestedQuantity: 120.0,
    sellingUnit: 'LINEAR_METER',
    spec: {
      metersPerRoll: 50.0,
      fabricWidthCm: 150.0,
      rollWeightKg: 20.0,
      rollDiameterCm: 25.0,
    },
  });

  assert(fabricResult.totalLinearMeters === 120.0, 'Total linear meters is 120 m');
  assert(fabricResult.totalRolls === 3, '120 m at 50 m/roll requires 3 rolls');
  assert(fabricResult.totalWeightKg === 60.0, '3 rolls * 20 kg = 60 kg total weight');

  // ─────────────────────────────────────────────────────────────
  // 8. ALL 9 FREIGHT BILLING UNITS (Section D)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[8] Testing All 9 Freight Billing Units...');

  // 1. PER_VEHICLE_TRIP
  const tripFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_VEHICLE_TRIP',
    unitRate: 45000.0,
    tripsCount: 2,
  });
  assert(tripFee === 90000.0, `PER_VEHICLE_TRIP: 45000 * 2 = 90000 YER (got ${tripFee})`);

  // 2. PER_ROUTE
  const routeFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_ROUTE',
    unitRate: 120000.0,
    tripsCount: 1,
  });
  assert(routeFee === 120000.0, `PER_ROUTE: 120000 * 1 = 120000 YER (got ${routeFee})`);

  // 3. PER_TONNE
  const tonneFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_TONNE',
    unitRate: 15000.0,
    chargeableWeightKg: 4500.0, // 4.5 tonnes
  });
  assert(tonneFee === 67500.0, `PER_TONNE: 4.5 t * 15000 = 67500 YER (got ${tonneFee})`);

  // 4. PER_KG
  const kgFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_KG',
    unitRate: 25.0,
    chargeableWeightKg: 800.0,
  });
  assert(kgFee === 20000.0, `PER_KG: 800 kg * 25 = 20000 YER (got ${kgFee})`);

  // 5. PER_CBM
  const cbmFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_CBM',
    unitRate: 12000.0,
    volumeCbm: 3.5,
  });
  assert(cbmFee === 42000.0, `PER_CBM: 3.5 m³ * 12000 = 42000 YER (got ${cbmFee})`);

  // 6. PER_PALLET
  const palletFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_PALLET',
    unitRate: 6000.0,
    palletCount: 4,
  });
  assert(palletFee === 24000.0, `PER_PALLET: 4 pallets * 6000 = 24000 YER (got ${palletFee})`);

  // 7. PER_SLAB
  const slabFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_SLAB',
    unitRate: 7500.0,
    slabCount: 6,
  });
  assert(slabFee === 45000.0, `PER_SLAB: 6 slabs * 7500 = 45000 YER (got ${slabFee})`);

  // 8. PER_SHIPMENT
  const shipmentFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_SHIPMENT',
    unitRate: 35000.0,
  });
  assert(shipmentFee === 35000.0, `PER_SHIPMENT: flat 35000 YER (got ${shipmentFee})`);

  // 9. PER_KILOMETER
  const kmFee = UnitConversionService.calculateFreightByBillingUnit({
    billingUnit: 'PER_KILOMETER',
    unitRate: 400.0,
    roadDistanceKm: 150.0,
    tripsCount: 1,
  });
  assert(kmFee === 60000.0, `PER_KILOMETER: 150 km * 400 = 60000 YER (got ${kmFee})`);

  // ─────────────────────────────────────────────────────────────
  // 9. INVENTORY STOCK CONVERSION (Section F)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[9] Testing Inventory Stock Quantity Conversion...');

  // Box to Pieces
  const stockPieces = UnitConversionService.convertSellingQtyToStockQty(10, 'BOX', {
    stockStorageUnit: 'PIECE',
    piecesPerBox: 8,
  });
  assert(stockPieces === 80, `10 boxes of 8 pcs = 80 stock pieces (got ${stockPieces})`);

  // Pallet to Boxes
  const stockBoxes = UnitConversionService.convertSellingQtyToStockQty(2, 'PALLET', {
    stockStorageUnit: 'BOX',
    boxesPerPallet: 48,
  });
  assert(stockBoxes === 96, `2 pallets of 48 boxes = 96 stock boxes (got ${stockBoxes})`);

  // Roll to Linear Meters
  const stockMeters = UnitConversionService.convertSellingQtyToStockQty(4, 'ROLL', {
    stockStorageUnit: 'METER',
    metersPerRoll: 50.0,
  });
  assert(stockMeters === 200, `4 rolls of 50 m = 200 stock meters (got ${stockMeters})`);

  // ─────────────────────────────────────────────────────────────
  // 10. HEAVY DELIVERY SERVICE INTEGRATION (Section C, D, G)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[10] Testing HeavyDeliveryService Integration...');

  // Eligibility: Tiles item
  const tileItemEligibility = heavyDeliveryService.evaluateItemEligibility({
    name: 'سيراميك حمامات 60x60',
    quantity: 100,
    sellingUnit: 'SQM',
    unitDimensionsJson: JSON.stringify({
      sqmPerBox: 1.44,
      piecesPerBox: 4,
      boxesPerPallet: 48,
      grossWeightKg: 25.0,
    }),
  });
  assert(tileItemEligibility.deliveryClass === 'HEAVY_FREIGHT', '100 SQM tiles classified as HEAVY_FREIGHT');
  assert(tileItemEligibility.cargoClassification === 'TILES_PORCELAIN', 'Tiles correctly classified as TILES_PORCELAIN');
  assert(tileItemEligibility.palletCount === 2, `100 SQM tiles requires 2 pallets (got ${tileItemEligibility.palletCount})`);
  assert(tileItemEligibility.calculatedWeightKg > 1700, `Tiles weight includes pallets & packaging (got ${tileItemEligibility.calculatedWeightKg})`);

  // Eligibility: Marble slab item
  const marbleEligibility = heavyDeliveryService.evaluateItemEligibility({
    name: 'رخام تركي ترافنتينو',
    quantity: 4,
    sellingUnit: 'SLAB',
    unitDimensionsJson: JSON.stringify({
      slabLengthCm: 260.0,
      slabWidthCm: 160.0,
      slabThicknessMm: 20.0,
      rackWeightKg: 75.0,
    }),
  });
  assert(marbleEligibility.deliveryClass === 'HEAVY_FREIGHT', 'Marble slab classified as HEAVY_FREIGHT');
  assert(marbleEligibility.cargoClassification === 'MARBLE_GRANITE', 'Marble correctly classified as MARBLE_GRANITE');
  assert(marbleEligibility.requiresCrane, 'Marble slab requires crane');
  assert(marbleEligibility.specialVehicleType === 'FLATBED', 'Marble slab requires FLATBED');

  // Eligibility: Digital product exemption (Section J.16)
  const digitalEligibility = heavyDeliveryService.evaluateItemEligibility({
    name: 'برنامج محاسبي أونلاين',
    quantity: 1,
    isDigital: true,
  });
  assert(digitalEligibility.deliveryClass === 'DIGITAL', 'Digital product delivery class is DIGITAL');
  assert(!digitalEligibility.isHeavy, 'Digital product is strictly NOT heavy');
  assert(digitalEligibility.calculatedWeightKg === 0, 'Digital product has 0 weight');

  // Pricing: Prevention of duplicate charging (Section D & E)
  // Dedicated vehicle hire pricing (PER_VEHICLE_TRIP) should NOT double-charge per-kg or per-tonne
  const cargoAnalysis = heavyDeliveryService.analyzeShipmentCargo([
    {
      name: 'مولد كهربائي صناعي',
      quantity: 1,
      sellingUnit: 'PIECE',
      weightKg: 2800.0,
      lengthCm: 220.0,
      widthCm: 120.0,
      heightCm: 150.0,
    },
  ]);
  const vehicleMatch = await heavyDeliveryService.matchVehicle(cargoAnalysis);
  assert(vehicleMatch.matchedVehicle !== null, 'Found matching heavy vehicle for industrial generator');

  // Dedicated Vehicle Pricing
  const dedicatedPricing = await heavyDeliveryService.calculateHeavyPricing(cargoAnalysis, vehicleMatch, {
    distanceKm: 25.0,
    isInterGovernorate: false,
    freightBillingUnit: 'PER_VEHICLE_TRIP',
  });
  assert(dedicatedPricing.freightBillingUnit === 'PER_VEHICLE_TRIP', 'Freight billing unit is PER_VEHICLE_TRIP');
  assert(dedicatedPricing.baseFee > 0, 'Base vehicle hire charge is applied');

  // Per-Tonne Pricing (alternative billing basis)
  const tonnePricing = await heavyDeliveryService.calculateHeavyPricing(cargoAnalysis, vehicleMatch, {
    distanceKm: 25.0,
    isInterGovernorate: false,
    freightBillingUnit: 'PER_TONNE',
    freightRatePerUnit: 20000.0,
  });
  assert(tonnePricing.freightBillingUnit === 'PER_TONNE', 'Freight billing unit is PER_TONNE');
  // Weight is 2.8 t -> 2.8 * 20000 = 56000 YER. Base fee should equal freight billing charge, not double-charge vehicle base!
  assert(tonnePricing.baseFee === 56000, `Per-tonne pricing substitutes vehicle base fee with 56,000 YER (got ${tonnePricing.baseFee})`);
  assert(tonnePricing.distanceCharge === 0, 'Distance charge is zeroed when per-tonne rate replaces distance fee');

  console.log('\n============================================================');
  console.log(`RESULTS: ${passed} passed, ${failed} failed.`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runUnitConversionAndFreightTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
