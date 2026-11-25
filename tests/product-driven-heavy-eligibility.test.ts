import test from 'node:test';
import assert from 'node:assert';
import { heavyDeliveryService } from '../src/services/delivery/heavy-delivery.service';
import { deliveryFeeService } from '../src/services/delivery/delivery-fee.service';
import { deliveryQuoteService } from '../src/services/delivery/delivery-quote.service';

test('Product-Driven Heavy Delivery Eligibility & Shipment Partitioning Suite', async (t) => {
  await t.test('1. Category alone does NOT trigger Heavy Delivery (Single tile sample)', async () => {
    // A single decorative tile sample weighing 0.5 kg in tiles category
    const item = {
      productId: 'prod_sample_tile_1',
      name: 'عينة بلاط سيراميك ديكور',
      quantity: 1,
      weightKg: 0.5,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 1,
      sellingUnit: 'PIECE',
      categorySlug: 'ceramics-tiles',
      categoryNameAr: 'سيراميك وبلاط',
    };

    const eligibility = heavyDeliveryService.evaluateItemEligibility(item);
    assert.strictEqual(eligibility.deliveryClass, 'STANDARD_PARCEL');
    assert.strictEqual(eligibility.isHeavy, false);
    assert.strictEqual(eligibility.requiresSellerConfirmation, false);

    const cargo = heavyDeliveryService.analyzeShipmentCargo([item]);
    assert.strictEqual(cargo.isHeavyOrBulky, false);
    assert.strictEqual(cargo.classification, 'STANDARD_PARCEL');
  });

  await t.test('2. High-quantity commercial tiles triggers Heavy Freight dynamically', async () => {
    // 100 boxes of tiles (100 * 28 kg = 2,800 kg) on pallets
    const item = {
      productId: 'prod_bulk_tiles_100',
      name: 'بلاط سيراميك نخب أول للأرضيات',
      quantity: 100,
      sellingUnit: 'BOX',
      packageWeightKg: 28.0,
      unitDimensionsJson: JSON.stringify({ boxWeightKg: 28.0, boxesPerPallet: 48 }),
      categorySlug: 'ceramics-tiles',
      categoryNameAr: 'سيراميك وبلاط',
    };

    const eligibility = heavyDeliveryService.evaluateItemEligibility(item);
    assert.strictEqual(eligibility.deliveryClass, 'HEAVY_FREIGHT');
    assert.strictEqual(eligibility.isHeavy, true);
    assert.strictEqual(eligibility.cargoClassification, 'TILES_PORCELAIN');
    assert.ok(eligibility.calculatedWeightKg >= 2800);
    assert.ok(eligibility.palletCount >= 2);
    assert.strictEqual(eligibility.requiresForklift, true);

    const cargo = heavyDeliveryService.analyzeShipmentCargo([item]);
    assert.strictEqual(cargo.isHeavyOrBulky, true);
    assert.strictEqual(cargo.classification, 'TILES_PORCELAIN');

    const vehicleMatch = await heavyDeliveryService.matchVehicle(cargo);
    assert.ok(vehicleMatch.matchedVehicle);
    // 2.8 tons requires at least a Light Truck (Dyna) or Medium Truck
    assert.ok(vehicleMatch.matchedVehicle.maxWeightKg >= 2800);
  });

  await t.test('3. Marble paperweight remains Standard Parcel; Marble slab triggers Heavy Freight', async () => {
    // 3a. Small marble gift/paperweight (0.8 kg)
    const marblePaperweight = {
      productId: 'prod_marble_paperweight',
      name: 'ثقالة أوراق رخامية للمكتب',
      quantity: 1,
      weightKg: 0.8,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 5,
      categorySlug: 'marble-granite',
      categoryNameAr: 'رخام وجرانيت',
    };
    const paperweightElig = heavyDeliveryService.evaluateItemEligibility(marblePaperweight);
    assert.strictEqual(paperweightElig.deliveryClass, 'STANDARD_PARCEL');
    assert.strictEqual(paperweightElig.isHeavy, false);

    // 3b. Marble slab (260x160 cm, ~225 kg on A-frame rack)
    const marbleSlab = {
      productId: 'prod_marble_slab_carrara',
      name: 'لوح رخام كرارة إيطالي فاخر',
      quantity: 1,
      sellingUnit: 'SLAB',
      unitDimensionsJson: JSON.stringify({ slabThicknessMm: 20, slabLengthCm: 260, slabWidthCm: 160 }),
      categorySlug: 'marble-granite',
      categoryNameAr: 'رخام وجرانيت',
    };
    const slabElig = heavyDeliveryService.evaluateItemEligibility(marbleSlab);
    assert.strictEqual(slabElig.deliveryClass, 'HEAVY_FREIGHT');
    assert.strictEqual(slabElig.isHeavy, true);
    assert.strictEqual(slabElig.cargoClassification, 'MARBLE_GRANITE');
    assert.strictEqual(slabElig.requiresSpecialVehicle, true);
    assert.strictEqual(slabElig.specialVehicleType, 'FLATBED');
    assert.strictEqual(slabElig.requiresCrane, true);
    assert.strictEqual(slabElig.requiresForklift, true);
  });

  await t.test('4. Missing required physical attributes triggers Seller Confirmation Workflow', async () => {
    // Industrial machinery product with no weight and no dimensions
    const latheMachinery = {
      productId: 'prod_lathe_machine',
      name: 'مخرطة معادن صناعية 3 فاز',
      quantity: 1,
      weightKg: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      categorySlug: 'industrial-machinery',
      categoryNameAr: 'آلات ومعدات صناعية',
      requiresSpecialVehicle: true,
    };

    const eligibility = heavyDeliveryService.evaluateItemEligibility(latheMachinery);
    assert.strictEqual(eligibility.deliveryClass, 'REQUIRES_SELLER_CONFIRMATION');
    assert.strictEqual(eligibility.requiresSellerConfirmation, true);
    assert.strictEqual(eligibility.quoteReason, 'MISSING_TRANSPORT_ATTRIBUTES');
    assert.ok(eligibility.incompleteReason?.includes('غير مكتملة'));

    const cargo = heavyDeliveryService.analyzeShipmentCargo([latheMachinery]);
    assert.strictEqual(cargo.hasIncompleteSpecs, true);

    const vehicleMatch = await heavyDeliveryService.matchVehicle(cargo);
    assert.strictEqual(vehicleMatch.requiresManualQuote, true);
  });

  await t.test('5. Mixed Cart Shipment Partitioning: Standard vs Heavy vs Digital', async () => {
    const mixedItems = [
      // Standard item
      {
        productId: 'prod_shirt_1',
        name: 'قميص قطني كاجوال',
        quantity: 2,
        weightKg: 0.3,
        lengthCm: 30,
        widthCm: 25,
        heightCm: 2,
      },
      // Heavy item
      {
        productId: 'prod_tiles_50_boxes',
        name: 'سيراميك حمامات ومطابخ',
        quantity: 50,
        sellingUnit: 'BOX',
        packageWeightKg: 25.0, // 50 * 25 = 1,250 kg
        categorySlug: 'ceramics',
      },
      // Digital item
      {
        productId: 'prod_ebook_1',
        name: 'كتاب التصميم المعماري الرقمي',
        quantity: 1,
        isDigital: true,
      },
    ];

    const partition = heavyDeliveryService.partitionShipment(mixedItems);
    assert.strictEqual(partition.hasMixedShipments, true);
    assert.strictEqual(partition.digitalItems.length, 1);
    assert.strictEqual(partition.standardItems.length, 1);
    assert.strictEqual(partition.heavyItems.length, 1);
    assert.strictEqual(partition.standardItems[0].productId, 'prod_shirt_1');
    assert.strictEqual(partition.heavyItems[0].productId, 'prod_tiles_50_boxes');
    assert.strictEqual(partition.digitalItems[0].productId, 'prod_ebook_1');
  });

  await t.test('6. Delivery Fee calculation produces independent sub-shipments for mixed orders', async () => {
    const sellerLat = 15.3500;
    const sellerLng = 44.2000;
    const customerLat = 15.3650;
    const customerLng = 44.2150; // local delivery (~3 km)

    const mixedItems = [
      {
        productId: 'prod_phone_case',
        name: 'كفر حماية للهاتف',
        quantity: 1,
        weightKg: 0.1,
        lengthCm: 15,
        widthCm: 8,
        heightCm: 1,
      },
      {
        productId: 'prod_tiles_40_boxes',
        name: 'بلاط أرضيات إسباني',
        quantity: 40,
        sellingUnit: 'BOX',
        packageWeightKg: 28.0, // 1,120 kg
        categorySlug: 'ceramics',
      },
    ];

    const quote = await deliveryFeeService.calculateFee(
      sellerLat, sellerLng,
      customerLat, customerLng,
      {
        heavyItems: mixedItems,
      }
    );

    assert.strictEqual(quote.hasMixedShipments, true);
    assert.ok(quote.subShipments);
    assert.strictEqual(quote.subShipments.length, 2);

    const standardSub = quote.subShipments.find((s) => s.shipmentType === 'STANDARD');
    const heavySub = quote.subShipments.find((s) => s.shipmentType === 'HEAVY');

    assert.ok(standardSub);
    assert.ok(heavySub);

    // Standard parcel fee is based on standard parcel rate (NOT heavy vehicle hire!)
    assert.ok(standardSub.deliveryFee < 5000);
    // Heavy freight fee is based on dedicated vehicle hire (e.g. Dyna / Light Truck base fee)
    assert.ok(heavySub.deliveryFee >= 15000);
    // Total delivery fee is the sum of independent shipments
    assert.strictEqual(quote.deliveryFee, standardSub.deliveryFee + heavySub.deliveryFee);
  });

  await t.test('7. Pure Heavy Cargo strictly restricts delivery methods to heavy_transport', async () => {
    const sellerLat = 15.3694;
    const sellerLng = 44.1910;
    const customerLat = 15.4200;
    const customerLng = 44.2100;

    const pureHeavyItems = [
      {
        productId: 'prod_tiles_50_boxes',
        name: 'بلاط أرضيات إسباني فاخر',
        quantity: 50,
        sellingUnit: 'BOX',
        packageWeightKg: 28.0, // 1,400 kg
        categorySlug: 'ceramics',
      },
    ];

    const quote = await deliveryFeeService.calculateFee(
      sellerLat, sellerLng,
      customerLat, customerLng,
      {
        heavyItems: pureHeavyItems,
      }
    );

    assert.strictEqual(quote.isHeavyDelivery, true);
    assert.strictEqual(quote.hasMixedShipments, false);
    assert.ok(quote.allowedDeliveryMethods);
    assert.strictEqual(quote.allowedDeliveryMethods.length, 1);
    assert.strictEqual(quote.allowedDeliveryMethods[0].code, 'heavy_transport');
  });
});
