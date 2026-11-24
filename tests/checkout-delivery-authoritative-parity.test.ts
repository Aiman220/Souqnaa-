import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryQuoteService } from '../src/services/delivery/delivery-quote.service';
import { heavyDeliveryService } from '../src/services/delivery/heavy-delivery.service';
import { interGovernorateRouteService } from '../src/services/delivery/inter-governorate-route.service';
import { prisma } from '../src/database/prisma';

test('SOUQNA Authoritative Delivery Calculation Parity Suite', async (t) => {
  await t.test('1. City Delivery: Standard vs Scheduled vs Express Rate Consistency', async () => {
    // Verify city delivery calculation with zone pricing
    const address = await prisma.address.findFirst({
      where: {
        city: {
          nameAr: { contains: 'صنعاء' },
        },
      },
      include: { city: true },
    });

    const store = await prisma.store.findFirst({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: { id: true, sellerId: true, name: true, latitude: true, longitude: true },
    });

    if (address && store) {
      const quoteStandard = await deliveryQuoteService.createQuote({
        customerAddressId: address.id,
        sellerOrders: [
          {
            sellerId: store.sellerId,
            storeId: store.id,
            isExpress: false,
          },
        ],
        deliveryMethod: 'standard',
        isExpress: false,
      });

      assert.strictEqual(quoteStandard.deliveryAvailable, true);
      assert.ok(quoteStandard.totalDeliveryFee > 0);

      const quoteExpress = await deliveryQuoteService.createQuote({
        customerAddressId: address.id,
        sellerOrders: [
          {
            sellerId: store.sellerId,
            storeId: store.id,
            isExpress: true,
          },
        ],
        deliveryMethod: 'express',
        isExpress: true,
      });

      assert.strictEqual(quoteExpress.deliveryAvailable, true);
      assert.ok(quoteExpress.totalDeliveryFee >= quoteStandard.totalDeliveryFee);
    }
  });

  await t.test('2. Inter-Governorate Route: Accurate route resolution and method surcharges', async () => {
    const route = await interGovernorateRouteService.resolveRoute(
      'loc-ye-sanaa',
      'loc-ye-taiz-al-hawban',
    );

    assert.ok(route);
    assert.strictEqual(route.isActive, true);

    const pricingStandard = await interGovernorateRouteService.calculatePricing({
      originAreaId: 'loc-ye-sanaa',
      destinationAreaId: 'loc-ye-taiz-al-hawban',
      deliveryMethodCode: 'intercity_transport',
      actualWeightKg: 5,
    });

    const pricingExpress = await interGovernorateRouteService.calculatePricing({
      originAreaId: 'loc-ye-sanaa',
      destinationAreaId: 'loc-ye-taiz-al-hawban',
      deliveryMethodCode: 'express',
      actualWeightKg: 5,
    });

    const pricingPickup = await interGovernorateRouteService.calculatePricing({
      originAreaId: 'loc-ye-sanaa',
      destinationAreaId: 'loc-ye-taiz-al-hawban',
      deliveryMethodCode: 'pickup_point',
      actualWeightKg: 5,
    });

    assert.strictEqual(pricingStandard.isInterGovernorate, true);
    assert.ok(pricingStandard.finalDeliveryFee > 0);
    assert.ok(pricingExpress.finalDeliveryFee >= pricingStandard.finalDeliveryFee);
    assert.ok(pricingPickup.finalDeliveryFee <= pricingStandard.finalDeliveryFee);
  });

  await t.test('3. Heavy Logistics: Dedicated vehicle-hire pricing rather than universal per-kg rate', async () => {
    // 4 tons of ceramic tiles / marble
    const cargoAnalysis = heavyDeliveryService.analyzeShipmentCargo([
      {
        name: 'سيراميك وبورسلان نخب أول',
        quantity: 100,
        weightKg: 40, // 4,000 kg total
        sellingUnit: 'BOX',
        palletCount: 4,
        categorySlug: 'ceramics-porcelain',
        categoryNameAr: 'سيراميك ورخام وبورسلان',
      },
    ]);

    assert.strictEqual(cargoAnalysis.isHeavyOrBulky, true);
    assert.ok(cargoAnalysis.totalActualWeightKg >= 2500);

    const vehicleMatch = await heavyDeliveryService.matchVehicle(cargoAnalysis);
    assert.ok(vehicleMatch.matchedVehicle);
    // 4,000 kg requires medium truck / dyna (not standard bike or motorcycle!)
    assert.notStrictEqual(vehicleMatch.matchedVehicle.code, 'MOTORCYCLE');

    const pricing = heavyDeliveryService.calculateHeavyPricing(cargoAnalysis, vehicleMatch, {
      distanceKm: 15.0,
      isInterGovernorate: false,
    });

    assert.strictEqual(pricing.deliveryMode, 'HEAVY_LOCAL');
    assert.ok(pricing.finalDeliveryFee > 0);
    // Vehicle hire base covers initial distance + extra km + pallet handling labor
    assert.ok(pricing.baseFee > 0);
    assert.ok(pricing.loadingFee > 0);
    assert.ok(pricing.unloadingFee > 0);
    // Does NOT equal 4000 * standard 50 YER parcel rate
    assert.notStrictEqual(pricing.finalDeliveryFee, 4000 * 50);
  });

  await t.test('4. Digital Products: Strictly zero delivery fee in both quote and order creation', async () => {
    const digitalQuote = await deliveryQuoteService.createQuote({
      customerAddressId: 'any-address-id',
      isDigitalOnly: true,
      sellerOrders: [
        {
          sellerId: 'sel-digital',
          storeId: 'store-digital',
          isDigital: true,
        },
      ],
    });

    assert.strictEqual(digitalQuote.deliveryAvailable, true);
    assert.strictEqual(digitalQuote.totalDeliveryFee, 0);
    assert.strictEqual(digitalQuote.isDigitalOnly, true);
    assert.strictEqual(digitalQuote.policy, 'DIGITAL_DELIVERY');
  });

  await t.test('5. Order Creation Parameter Parity: destinationAreaId and deliveryMethodCode received', async () => {
    // Test that deliveryQuoteService correctly handles explicit destinationAreaId and deliveryMethodCode
    const address = await prisma.address.findFirst({
      include: { city: true },
    });

    const store = await prisma.store.findFirst({
      select: { id: true, sellerId: true },
    });

    if (address && store) {
      const quote = await deliveryQuoteService.createQuote({
        customerAddressId: address.id,
        sellerOrders: [{ sellerId: store.sellerId, storeId: store.id }],
        deliveryMethod: 'intercity_transport',
        destinationAreaId: 'loc-ye-taiz-al-hawban',
      });

      assert.strictEqual(quote.deliveryAvailable, true);
      assert.strictEqual(quote.isInterGovernorate, true);
      assert.strictEqual(quote.routeKey, 'loc-ye-sanaa:loc-ye-taiz-al-hawban');
    }
  });
});
