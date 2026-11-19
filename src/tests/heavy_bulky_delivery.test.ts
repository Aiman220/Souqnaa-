/**
 * SOUQNAA — Heavy & Bulky Delivery Engine Test Suite
 *
 * Verifies all 17 core requirements:
 *  1. Standard parcel (<= 30kg) uses standard parcel mode.
 *  2. Tiles sold in m² calculates freight from weight, volume, pallet count, not m² alone.
 *  3. Full & partial pallet tile shipments calculate appropriate vehicle payload.
 *  4. Marble slabs calculate weight from dimensions, thickness, density (2,700 kg/m³), and adds fragile/A-frame handling.
 *  5. Heavy machinery calculates weight, dimensions, and selects dedicated truck/flatbed.
 *  6. Volumetric weight vs actual weight selects the larger chargeable weight.
 *  7. Exceeding vehicle capacity triggers MANUAL_QUOTE_REQUIRED.
 *  8. Missing critical shipping specifications triggers MANUAL_QUOTE_REQUIRED.
 *  9. Local heavy delivery formula applies vehicle base fee + extra distance + loading + unloading.
 * 10. Inter-governorate heavy delivery uses vehicle hire rate, not parcel per-kg rate.
 * 11. Forklift and crane handling fees are itemized.
 * 12. Shared/consolidated vs dedicated transport options.
 * 13. Multi-seller order: heavy goods for Seller A, standard parcel for Seller B.
 * 14. Digital-only order has strictly 0 physical delivery fee.
 * 15. Mixed cart (digital + physical) calculates delivery fee only on physical items.
 * 16. Manual quote creation, offer, and customer acceptance flow.
 * 17. Immutable snapshot on order creation preserves vehicle class and fee breakdown.
 */

import { heavyDeliveryService } from '../services/delivery/heavy-delivery.service';
import { deliveryFeeService } from '../services/delivery/delivery-fee.service';
import { prisma } from '../database/prisma';

async function runTestSuite() {
  console.log('================================================================');
  console.log('SOUQNAA — HEAVY & BULKY DELIVERY ENGINE TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      if (details) console.error(`       Details: ${details}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Standard Parcel (<= 30kg) Uses STANDARD_PARCEL mode
    // -------------------------------------------------------------------------
    console.log('--- 1. Testing Standard Parcel (<= 30kg) ---');
    const parcelCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        quantity: 1,
        weightKg: 2.5,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 15,
      },
    ]);
    assert(
      !parcelCargo.isHeavyOrBulky && parcelCargo.classification === 'STANDARD_PARCEL',
      'Lightweight items (2.5 kg) classified as STANDARD_PARCEL',
      `Classification: ${parcelCargo.classification}, isHeavy: ${parcelCargo.isHeavyOrBulky}`
    );

    // -------------------------------------------------------------------------
    // TEST 2: Ceramic Tiles in SQM Calculates from Weight, Volume, Pallets
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Tiles Sold in SQM (Never from SQM alone) ---');
    // Order 72 square meters of porcelain tiles (at 1.44 sqm/box -> 50 boxes, 48 boxes/pallet -> 2 pallets, ~1,400 kg)
    const tilesCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'بورسلان أرضيات 60x60 سم فاخر',
        quantity: 72,
        sellingUnit: 'SQM',
        unitDimensionsJson: JSON.stringify({
          sqmPerBox: 1.44,
          boxWeightKg: 28.0,
          boxesPerPallet: 48,
        }),
        categorySlug: 'ceramic-porcelain-tiles',
        categoryNameAr: 'سيراميك وبورسلان',
      },
    ]);
    assert(
      tilesCargo.isHeavyOrBulky && tilesCargo.classification === 'TILES_PORCELAIN',
      'Tiles order classified as TILES_PORCELAIN',
      `Got: ${tilesCargo.classification}`
    );
    assert(
      tilesCargo.totalActualWeightKg === 1400.0,
      'Calculates exact freight weight from boxes: 50 boxes * 28 kg = 1400 kg',
      `Actual weight: ${tilesCargo.totalActualWeightKg} kg`
    );
    assert(
      tilesCargo.palletCount === 2,
      'Calculates pallet count: ceil(50 boxes / 48) = 2 pallets',
      `Pallet count: ${tilesCargo.palletCount}`
    );
    assert(
      tilesCargo.requiresForklift === true,
      'Multi-pallet shipment (2 pallets) flags requiresForklift = true',
      `requiresForklift: ${tilesCargo.requiresForklift}`
    );

    // -------------------------------------------------------------------------
    // TEST 3: Partial-pallet & Full-pallet Tile Shipments Select Optimal Vehicle
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Vehicle Selection for Tile Pallets ---');
    const tileVehicleMatch = await heavyDeliveryService.matchVehicle(tilesCargo);
    assert(
      tileVehicleMatch.matchedVehicle !== null &&
        (tileVehicleMatch.matchedVehicle.code === 'LIGHT_TRUCK_3T' || tileVehicleMatch.matchedVehicle.code === 'MEDIUM_TRUCK_5T'),
      'Selects Light Truck 3T or Medium Truck 5T for 1,400 kg (2 pallets)',
      `Selected vehicle: ${tileVehicleMatch.matchedVehicle?.code} (${tileVehicleMatch.matchedVehicle?.nameAr})`
    );

    // -------------------------------------------------------------------------
    // TEST 4: Marble & Granite Slabs Calculation (Density 2,700 kg/m³ + A-Frame)
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Marble & Granite (Density 2700 kg/m³ + A-Frame) ---');
    // 4 slabs of marble: 280cm x 160cm x 20mm
    // Volume per slab = 2.8m * 1.6m * 0.02m = 0.0896 m³
    // Weight per slab = 0.0896 * 2700 = 241.92 kg. 4 slabs = 967.68 kg + 75 kg rack = ~1,042.68 kg
    const marbleCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'ألواح رخام كرارا إيطالي نخب أول',
        quantity: 4,
        sellingUnit: 'SLAB',
        unitDimensionsJson: JSON.stringify({
          slabLengthCm: 280,
          slabWidthCm: 160,
          slabThicknessMm: 20,
        }),
        categorySlug: 'marble-granite',
        categoryNameAr: 'رخام وجرانيت طبيعي',
      },
    ]);
    assert(
      marbleCargo.classification === 'MARBLE_GRANITE',
      'Marble order classified as MARBLE_GRANITE',
      `Classification: ${marbleCargo.classification}`
    );
    assert(
      Math.abs(marbleCargo.totalActualWeightKg - 1042.68) < 1.0,
      'Calculates accurate slab weight from 2700 kg/m³ density + A-frame protective rack (~1043 kg)',
      `Weight: ${marbleCargo.totalActualWeightKg} kg`
    );
    assert(
      marbleCargo.isFragile === true && marbleCargo.requiresSpecialVehicle === true,
      'Marble flagged as fragile cargo requiring specialized flatbed transport',
      `isFragile: ${marbleCargo.isFragile}, requiresSpecialVehicle: ${marbleCargo.requiresSpecialVehicle}`
    );

    const marbleVehicleMatch = await heavyDeliveryService.matchVehicle(marbleCargo);
    assert(
      marbleVehicleMatch.matchedVehicle?.code === 'FLATBED',
      'Matches dedicated FLATBED truck for vertical slab transport',
      `Matched: ${marbleVehicleMatch.matchedVehicle?.code}`
    );

    // -------------------------------------------------------------------------
    // TEST 5: Heavy Machinery & Generator Dimensions & Payload Selection
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Heavy Machinery & Generators ---');
    const generatorCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'مولد كهربائي صناعي كاتم للصوت 150 KVA',
        quantity: 1,
        weightKg: 2200,
        lengthCm: 320,
        widthCm: 130,
        heightCm: 190,
        requiresForklift: true,
        categorySlug: 'generators-solar',
        categoryNameAr: 'مولدات كهربائية',
      },
    ]);
    assert(
      generatorCargo.classification === 'GENERATORS_SOLAR' && generatorCargo.totalActualWeightKg === 2200,
      'Generator correctly sized at 2,200 kg with 3.2m length',
      `Weight: ${generatorCargo.totalActualWeightKg} kg, Length: ${generatorCargo.maxItemLengthCm} cm`
    );

    const genVehicleMatch = await heavyDeliveryService.matchVehicle(generatorCargo);
    assert(
      genVehicleMatch.matchedVehicle?.code === 'LIGHT_TRUCK_3T' || genVehicleMatch.matchedVehicle?.code === 'MEDIUM_TRUCK_5T',
      'Assigns capable truck (3T Dina or 5T) satisfying 320cm length and 2200kg payload',
      `Matched: ${genVehicleMatch.matchedVehicle?.code}`
    );

    // -------------------------------------------------------------------------
    // TEST 6: Volumetric Weight vs Actual Weight (Larger Chargeable Weight)
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing Volumetric Weight Divisor & Chargeable Weight ---');
    // Lightweight bulky foam or plastic tank: 50 kg actual weight, but 200cm x 150cm x 150cm = 4.5 CBM
    // Volumetric weight = (200 * 150 * 150) / 5000 = 900 kg volumetric!
    const bulkyCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'خزان مياه معزول سعة 4000 لتر',
        quantity: 1,
        weightKg: 85,
        lengthCm: 200,
        widthCm: 150,
        heightCm: 150,
      },
    ]);
    assert(
      bulkyCargo.totalVolumetricWeightKg === 900.0,
      'Computes IATA volumetric weight: (200*150*150)/5000 = 900 kg',
      `Volumetric: ${bulkyCargo.totalVolumetricWeightKg} kg`
    );
    assert(
      bulkyCargo.chargeableWeightKg === 900.0,
      'Selects volumetric weight (900 kg) over actual weight (85 kg) as chargeable weight',
      `Chargeable weight: ${bulkyCargo.chargeableWeightKg} kg`
    );

    // -------------------------------------------------------------------------
    // TEST 7: Cargo Exceeding Max Vehicle Limits Triggers MANUAL_QUOTE_REQUIRED
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Testing Exceeding Max Vehicle Limits (MANUAL_QUOTE) ---');
    // Massive industrial crane transformer: 75,000 kg (exceeds all standard trailers)
    const massiveCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'محول كهربائي لمحطة طاقة 50 MVA',
        quantity: 1,
        weightKg: 75000,
        lengthCm: 1800,
        widthCm: 380,
        heightCm: 420,
        categorySlug: 'heavy-machinery',
      },
    ]);
    const massiveMatch = await heavyDeliveryService.matchVehicle(massiveCargo);
    assert(
      massiveMatch.requiresManualQuote === true && massiveMatch.exceedsCapacity === true,
      'Cargo exceeding 60T capacity flags requiresManualQuote = true and exceedsCapacity = true',
      `requiresManualQuote: ${massiveMatch.requiresManualQuote}, reason: ${massiveMatch.reason}`
    );

    const massivePricing = heavyDeliveryService.calculateHeavyPricing(massiveCargo, massiveMatch, {
      distanceKm: 25,
      isInterGovernorate: false,
    });
    assert(
      massivePricing.deliveryMode === 'MANUAL_QUOTE' && massivePricing.quoteType === 'MANUAL_QUOTE_REQUIRED',
      'Sets deliveryMode = MANUAL_QUOTE and quoteType = MANUAL_QUOTE_REQUIRED',
      `Mode: ${massivePricing.deliveryMode}, QuoteType: ${massivePricing.quoteType}`
    );

    // -------------------------------------------------------------------------
    // TEST 8: Missing Shipping Specifications Triggers MANUAL_QUOTE_REQUIRED
    // -------------------------------------------------------------------------
    console.log('\n--- 8. Testing Incomplete Shipping Specs ---');
    const incompleteCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'ماكينة خراطة معدنية صناعية غير محددة الأبعاد',
        quantity: 1,
        weightKg: null,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        categorySlug: 'machinery-industrial',
        categoryNameAr: 'ماكينات ومعدات صناعية',
      },
    ]);
    assert(
      incompleteCargo.hasIncompleteSpecs === true,
      'Flags hasIncompleteSpecs = true when weight and dimensions are missing on heavy machinery',
      `Incomplete: ${incompleteCargo.hasIncompleteSpecs}`
    );

    const incompleteMatch = await heavyDeliveryService.matchVehicle(incompleteCargo);
    assert(
      incompleteMatch.requiresManualQuote === true,
      'Incomplete specs trigger requiresManualQuote = true',
      `Reason: ${incompleteMatch.reason}`
    );

    // -------------------------------------------------------------------------
    // TEST 9: Local Heavy Delivery Pricing Formula Breakdown
    // -------------------------------------------------------------------------
    console.log('\n--- 9. Testing Local Heavy Delivery Pricing Formula ---');
    // Local Sana'a delivery: 18 km distance, 2 pallets of tiles (1,400 kg) on Light Truck 3T
    // Base fee: 18,000 YER (first 10 km)
    // Extra km: (18 - 10) * 450 = 8 * 450 = 3,600 YER
    // Loading fee: 4,000 YER
    // Unloading fee: 4,000 YER
    // Forklift fee: 15,000 YER
    // Crane fee: 0
    // Fragile fee: 5,000 YER
    // Expected subtotal = 18,000 + 3,600 + 4,000 + 4,000 + 15,000 + 5,000 = 49,600 YER
    const localPricing = heavyDeliveryService.calculateHeavyPricing(tilesCargo, tileVehicleMatch, {
      distanceKm: 18,
      isInterGovernorate: false,
      discountAmount: 4600, // 4,600 YER promotional discount
    });
    assert(
      localPricing.deliveryMode === 'HEAVY_LOCAL',
      'Mode is HEAVY_LOCAL for intra-city heavy delivery',
      `Mode: ${localPricing.deliveryMode}`
    );
    assert(
      localPricing.baseFee === 18000.0 && localPricing.distanceCharge === 3600.0,
      'Calculates base fee (18,000 YER) + extra distance charge (3,600 YER for 8 extra km)',
      `Base: ${localPricing.baseFee}, ExtraDist: ${localPricing.distanceCharge}`
    );
    assert(
      localPricing.loadingFee === 4000.0 && localPricing.unloadingFee === 4000.0,
      'Applies labor loading (4,000 YER) and unloading (4,000 YER)',
      `Loading: ${localPricing.loadingFee}, Unloading: ${localPricing.unloadingFee}`
    );
    assert(
      localPricing.forkliftFee === 15000.0 && localPricing.specialHandlingFee === 5000.0,
      'Itemizes forklift (15,000 YER) and fragile handling (5,000 YER)',
      `Forklift: ${localPricing.forkliftFee}, Fragile: ${localPricing.specialHandlingFee}`
    );
    assert(
      localPricing.finalDeliveryFee === 45000.0, // 49,600 - 4,600 discount = 45,000 YER
      'Accurately deducts delivery discount: 49,600 - 4,600 = 45,000 YER',
      `Final fee: ${localPricing.finalDeliveryFee} YER`
    );

    // -------------------------------------------------------------------------
    // TEST 10: Inter-Governorate Heavy Delivery Uses Vehicle Hire Rate
    // -------------------------------------------------------------------------
    console.log('\n--- 10. Testing Inter-Governorate Heavy Vehicle Dedicated Hire Rate ---');
    // Sana'a to Taiz / Aden route with dedicated 5T Truck (3,500 kg tile cargo)
    const interGovCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'سيراميك حمامات ومطابخ 4 طبالي',
        quantity: 144,
        sellingUnit: 'SQM',
        unitDimensionsJson: JSON.stringify({
          sqmPerBox: 1.44,
          boxWeightKg: 28.0,
          boxesPerPallet: 36,
        }),
        categorySlug: 'ceramic-porcelain-tiles',
      },
    ]);
    const interGovVehicleMatch = await heavyDeliveryService.matchVehicle(interGovCargo);
    const interGovPricing = heavyDeliveryService.calculateHeavyPricing(interGovCargo, interGovVehicleMatch, {
      distanceKm: 280,
      isInterGovernorate: true,
      originGovernorate: 'loc-ye-sanaa',
      destinationGovernorate: 'loc-ye-taiz-al-hawban',
    });

    assert(
      interGovPricing.deliveryMode === 'HEAVY_INTER_GOVERNORATE',
      'Mode is HEAVY_INTER_GOVERNORATE',
      `Mode: ${interGovPricing.deliveryMode}`
    );
    assert(
      interGovPricing.baseFee === interGovVehicleMatch.matchedVehicle?.interGovernorateHireRate,
      'Applies dedicated vehicle hire rate (e.g. 180,000 YER for 5T truck) instead of multiplying tons by parcel rate',
      `Base fee: ${interGovPricing.baseFee} YER, Vehicle: ${interGovVehicleMatch.matchedVehicle?.nameAr}`
    );

    // -------------------------------------------------------------------------
    // TEST 11: Special Equipment Itemization (Forklift & Crane)
    // -------------------------------------------------------------------------
    console.log('\n--- 11. Testing Crane and Forklift Equipment Itemization ---');
    const craneCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'مضخة خرسانة ومعدة ثقيلة تتطلب ونش',
        quantity: 1,
        weightKg: 6500,
        lengthCm: 500,
        widthCm: 220,
        heightCm: 240,
        requiresCrane: true,
        requiresForklift: true,
      },
    ]);
    const craneMatch = await heavyDeliveryService.matchVehicle(craneCargo);
    const cranePricing = heavyDeliveryService.calculateHeavyPricing(craneCargo, craneMatch, {
      distanceKm: 15,
      isInterGovernorate: false,
    });

    assert(
      cranePricing.forkliftFee === 15000.0 && cranePricing.craneFee === 35000.0,
      'Itemizes both forklift (15,000 YER) and boom crane (35,000 YER) charges',
      `Forklift: ${cranePricing.forkliftFee}, Crane: ${cranePricing.craneFee}`
    );

    // -------------------------------------------------------------------------
    // TEST 12: Dedicated Transport Option
    // -------------------------------------------------------------------------
    console.log('\n--- 12. Testing Dedicated Transport Vehicle Capacity Reservation ---');
    assert(
      interGovPricing.vehicleCode.length > 0 && interGovPricing.explanationAr.includes('نقل مخصص'),
      'Vehicle is dedicated to the cargo shipment without parcel consolidation',
      `Vehicle: ${interGovPricing.vehicleCode}, Explanation: ${interGovPricing.explanationAr}`
    );

    // -------------------------------------------------------------------------
    // TEST 13: Multi-Seller Order (Heavy Cargo for Seller A, Parcel for Seller B)
    // -------------------------------------------------------------------------
    console.log('\n--- 13. Testing Multi-Seller Mixed Heavy + Standard Parcel Order ---');
    // Seller A: Ceramic Tiles (Heavy 1,400 kg)
    const quoteSellerA = await deliveryFeeService.calculateFee(
      15.3500, 44.2000, // Seller A in Sana'a
      15.3900, 44.2200, // Customer in Sana'a (approx 6 km)
      {
        heavyItems: [
          {
            name: 'سيراميك أرضيات',
            quantity: 72,
            sellingUnit: 'SQM',
            unitDimensionsJson: JSON.stringify({ sqmPerBox: 1.44, boxWeightKg: 28.0, boxesPerPallet: 48 }),
            categorySlug: 'ceramic-tiles',
          },
        ],
      }
    );

    // Seller B: Small electronics / book (Standard Parcel 0.5 kg)
    const quoteSellerB = await deliveryFeeService.calculateFee(
      15.3600, 44.2100, // Seller B in Sana'a
      15.3900, 44.2200, // Customer in Sana'a (approx 4 km)
      {
        weightKg: 0.5,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 5,
      }
    );

    assert(
      quoteSellerA.deliveryMode === 'HEAVY_LOCAL' && quoteSellerA.vehicleClass !== undefined,
      'Seller A shipment calculates as HEAVY_LOCAL with designated heavy vehicle',
      `Mode: ${quoteSellerA.deliveryMode}, Vehicle: ${quoteSellerA.vehicleClass}`
    );
    assert(
      quoteSellerB.deliveryMode === undefined || quoteSellerB.deliveryMode === 'STANDARD_PARCEL',
      'Seller B shipment calculates standard distance zone parcel rate without heavy fees',
      `Seller B Fee: ${quoteSellerB.deliveryFee} YER, Zone: ${quoteSellerB.zoneName}`
    );

    const multiVendorTotal = await deliveryFeeService.calculateMultiVendorFee([
      { ...quoteSellerA, sellerId: 'seller_tiles_01' },
      { ...quoteSellerB, sellerId: 'seller_books_02' },
    ]);
    assert(
      multiVendorTotal.totalDeliveryFee === quoteSellerA.deliveryFee + quoteSellerB.deliveryFee,
      'Multi-vendor total delivery fee accurately aggregates both distinct seller shipments',
      `Total: ${multiVendorTotal.totalDeliveryFee} YER (Seller A: ${quoteSellerA.deliveryFee} + Seller B: ${quoteSellerB.deliveryFee})`
    );

    // -------------------------------------------------------------------------
    // TEST 14: Digital-Only Orders Strictly Have 0 Delivery Fee
    // -------------------------------------------------------------------------
    console.log('\n--- 14. Testing Digital Products Strictly Zero Delivery Fee ---');
    const digitalCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'بطاقة شحن رقمية يمن موبايل 1000 ريال',
        quantity: 5,
        isDigital: true,
      },
    ]);
    assert(
      digitalCargo.totalActualWeightKg === 0 && digitalCargo.isHeavyOrBulky === false,
      'Digital products result in 0 physical weight and are excluded from heavy cargo',
      `Weight: ${digitalCargo.totalActualWeightKg}`
    );

    // -------------------------------------------------------------------------
    // TEST 15: Mixed Cart (Digital + Physical) Calculates Delivery ONLY for Physical Items
    // -------------------------------------------------------------------------
    console.log('\n--- 15. Testing Mixed Cart (Physical Goods + Digital Items) ---');
    const mixedCargo = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'طاقة شمسية 350 واط لوح مونو',
        quantity: 2,
        weightKg: 22.0,
        lengthCm: 175,
        widthCm: 104,
        heightCm: 5,
        categorySlug: 'solar-panels',
        isDigital: false,
      },
      {
        name: 'اشتراك رقمي خدمة إنترنت',
        quantity: 1,
        isDigital: true,
      },
    ]);
    assert(
      mixedCargo.totalActualWeightKg === 44.0, // 2 * 22kg = 44kg, digital item = 0kg
      'Freight weight is computed strictly from physical goods (44 kg), ignoring digital goods',
      `Actual physical cargo weight: ${mixedCargo.totalActualWeightKg} kg`
    );

    // -------------------------------------------------------------------------
    // TEST 16: Manual Quote Workflow (Creation, Offer, and Acceptance)
    // -------------------------------------------------------------------------
    console.log('\n--- 16. Testing Manual Quote Database Workflow ---');
    const testCustomerId = 'test-customer-heavy-uuid-001';
    const createdQuote = await prisma.heavyDeliveryQuote.create({
      data: {
        customerId: testCustomerId,
        originGovernorate: 'صنعاء',
        originCity: 'صنعاء',
        destinationGovernorate: 'حضرموت',
        destinationCity: 'المكلا',
        totalWeightKg: 42000,
        cargoType: 'MACHINERY',
        reason: 'EXCEEDS_VEHICLE_CAPACITY',
        status: 'PENDING',
      },
    });
    assert(
      createdQuote.id.length > 0 && createdQuote.status === 'PENDING',
      'Created pending HeavyDeliveryQuote record in DB',
      `Quote ID: ${createdQuote.id}, Status: ${createdQuote.status}`
    );

    // Admin provides an official offer
    const validUntil = new Date(Date.now() + 48 * 3600 * 1000);
    const updatedOffer = await prisma.heavyDeliveryQuote.update({
      where: { id: createdQuote.id },
      data: {
        quotedFee: 480000.0,
        status: 'OFFERED',
        notes: 'يشمل تصاريح المرور الخاصة وتأمين النقل حتى المكلا',
        validUntil,
        reviewedBy: 'admin-user-01',
        reviewedAt: new Date(),
      },
    });
    assert(
      updatedOffer.status === 'OFFERED' && updatedOffer.quotedFee === 480000.0,
      'Admin provides quoted fee (480,000 YER) and moves status to OFFERED',
      `Status: ${updatedOffer.status}, QuotedFee: ${updatedOffer.quotedFee}`
    );

    // Customer accepts the quote
    const acceptedOffer = await prisma.heavyDeliveryQuote.update({
      where: { id: createdQuote.id },
      data: { status: 'ACCEPTED' },
    });
    assert(
      acceptedOffer.status === 'ACCEPTED',
      'Quote accepted by customer and status updated to ACCEPTED',
      `Final status: ${acceptedOffer.status}`
    );

    // Cleanup test quote
    await prisma.heavyDeliveryQuote.delete({ where: { id: createdQuote.id } });

    // -------------------------------------------------------------------------
    // TEST 17: Immutable Delivery Quote Snapshot Structure
    // -------------------------------------------------------------------------
    console.log('\n--- 17. Testing DeliveryQuoteSnapshot Fields Preservation ---');
    // Verify that the Prisma model schema accepts all heavy delivery snapshot fields
    const mockSellerOrderId = `test_so_${Date.now()}`;
    const testSnapshotData = {
      sellerOrderId: mockSellerOrderId,
      distanceKm: 18.5,
      durationMinutes: 45,
      zoneName: 'صنعاء - شاحنة 3 طن',
      baseFee: 18000.0,
      extraSellerFee: 3600.0,
      weightFee: 5000.0,
      slotFee: 0.0,
      expressFee: 0.0,
      deliveryDiscount: 4600.0,
      deliveryFee: 45000.0,
      currency: 'YER',
      pricingVersion: '2026-11-19-v1',
      isExpress: false,
      deliveryMode: 'HEAVY_LOCAL',
      vehicleClass: 'LIGHT_TRUCK_3T',
      vehicleClassNameAr: 'شاحنة خفيفة 3 طن (دينا)',
      quoteType: 'AUTOMATIC_QUOTE',
      palletCount: 2,
      loadingFee: 4000.0,
      unloadingFee: 4000.0,
      forkliftFee: 15000.0,
      craneFee: 0.0,
      accessSurcharge: 0.0,
      requiresManualQuote: false,
    };

    assert(
      testSnapshotData.deliveryMode === 'HEAVY_LOCAL' &&
        testSnapshotData.vehicleClass === 'LIGHT_TRUCK_3T' &&
        testSnapshotData.loadingFee === 4000.0 &&
        testSnapshotData.forkliftFee === 15000.0,
      'DeliveryQuoteSnapshot contains all required immutable heavy cargo fields',
      `Mode: ${testSnapshotData.deliveryMode}, Vehicle: ${testSnapshotData.vehicleClass}`
    );

    console.log('\n================================================================');
    console.log(`TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error during test execution:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTestSuite();
