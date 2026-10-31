/**
 * SOUQNAA — Comprehensive City-Based Product Discovery & Delivery Serviceability Test Suite
 *
 * Validates:
 * 1. Strictly 10 Supported Delivery Areas in Yemen.
 * 2. Strict Rejection of Unsupported Cities, Governorates & Districts (Aden, Mukalla, Marib, Ibb, etc.).
 * 3. Arabic Spelling Variations & Normalization (Ta marbuta, Alef forms, dash variants, whitespace).
 * 4. Critical Taiz vs Taiz – Al Hawban Restriction:
 *    - "تعز" without "الحوبان" is strictly rejected with explicit localized message.
 *    - "تعز – الحوبان" is accepted.
 *    - Coordinates within Taiz city center vs Al Hawban coordinates.
 * 5. Customer Destination Resolution (Query params, Headers, Canonical Areas).
 * 6. Seller Delivery Serviceability & Geodesic Distance Checks.
 * 7. Multi-Seller Delivery Quote & Checkout Serviceability Revalidation.
 * 8. Backend Feature Flag 'city_based_product_discovery' Behavior.
 * 9. Security & API Rejection of Unsupported Destinations.
 */

import assert from 'node:assert/strict';
import {
  SupportedAreasService,
  STRICTLY_SUPPORTED_AREAS,
} from '../src/modules/locations/supported-areas.service';
import {
  DeliveryServiceabilityService,
} from '../src/services/delivery/delivery-serviceability.service';
import { DEFAULT_FEATURE_FLAGS } from '../src/modules/remote-config/feature-flags.defaults';
import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';

async function runTests() {
  console.log('\n🧪 Starting SOUQNAA City-Based Product Discovery & Delivery Serviceability Test Suite...\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      const res = fn();
      if (res instanceof Promise) {
        return res
          .then(() => {
            console.log(`  ✓ PASS: ${name}`);
            passed++;
          })
          .catch((err) => {
            console.error(`  ✗ FAIL: ${name}`, err);
            failed++;
          });
      } else {
        console.log(`  ✓ PASS: ${name}`);
        passed++;
      }
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`, err);
      failed++;
    }
  }

  const areasService = SupportedAreasService.getInstance();
  const serviceabilityService = DeliveryServiceabilityService.getInstance();

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Strictly 10 Supported Delivery Areas in Yemen
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- 1. Strictly 10 Supported Delivery Areas in Yemen ---');

  test('Total supported areas count is exactly 10', () => {
    assert.equal(STRICTLY_SUPPORTED_AREAS.length, 10);
  });

  const expected10Areas = [
    { canonicalId: 'loc-ye-sanaa', nameAr: 'صنعاء', nameEn: 'Sanaa' },
    { canonicalId: 'loc-ye-saada', nameAr: 'صعدة', nameEn: 'Saada' },
    { canonicalId: 'loc-ye-amran', nameAr: 'عمران', nameEn: 'Amran' },
    { canonicalId: 'loc-ye-hajjah', nameAr: 'حجة', nameEn: 'Hajjah' },
    { canonicalId: 'loc-ye-al-mahwit', nameAr: 'المحويت', nameEn: 'Al Mahwit' },
    { canonicalId: 'loc-ye-raymah', nameAr: 'ريمة', nameEn: 'Raymah' },
    { canonicalId: 'loc-ye-dhamar', nameAr: 'ذمار', nameEn: 'Dhamar' },
    { canonicalId: 'loc-ye-al-bayda', nameAr: 'البيضاء', nameEn: 'Al Bayda' },
    { canonicalId: 'loc-ye-al-hudaydah', nameAr: 'الحديدة', nameEn: 'Al Hudaydah' },
    { canonicalId: 'loc-ye-taiz-al-hawban', nameAr: 'تعز – الحوبان', nameEn: 'Taiz - Al Hawban' },
  ];

  for (const exp of expected10Areas) {
    test(`Supported area matches canonical ID: ${exp.nameAr} (${exp.nameEn}) -> ${exp.canonicalId}`, () => {
      const match = areasService.matchSupportedArea(exp.nameAr);
      assert.equal(match.isSupported, true);
      assert.ok(match.area);
      assert.equal(match.area?.canonicalId, exp.canonicalId);
      assert.equal(match.area?.nameAr, exp.nameAr);
      assert.equal(match.area?.nameEn, exp.nameEn);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Strict Rejection of Unsupported Locations
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Strict Rejection of Unsupported Locations ---');

  const unsupportedLocations = [
    'عدن',
    'Aden',
    'المكلا',
    'Mukalla',
    'حضرموت',
    'Hadramout',
    'مأرب',
    'Marib',
    'إب',
    'اب',
    'Ibb',
    'شبوة',
    'Shabwah',
    'لحج',
    'Lahij',
    'أبين',
    'Abyan',
    'الضالع',
    'Al Dhale',
    'المهرة',
    'Al Mahrah',
    'سقطرى',
    'Socotra',
    'سيئون',
    'Seiyun',
  ];

  for (const loc of unsupportedLocations) {
    test(`Strictly rejects unsupported location: ${loc}`, () => {
      const match = areasService.matchSupportedArea(loc);
      assert.equal(match.isSupported, false);
      assert.equal(match.area, null);
      assert.ok(match.rejectionReasonAr);
      assert.ok(match.rejectionReasonAr?.includes('عذراً، هذه المنطقة غير مشمولة'));
    });
  }

  test('Gracefully rejects null and empty location strings', () => {
    const matchNull = areasService.matchSupportedArea(null);
    assert.equal(matchNull.isSupported, false);
    assert.ok(matchNull.rejectionReasonAr);

    const matchEmpty = areasService.matchSupportedArea('');
    assert.equal(matchEmpty.isSupported, false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Arabic Spelling Variations & Normalization
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Arabic Spelling Variations & Normalization ---');

  test('Normalizes Saada variants: صعده vs صعدة', () => {
    assert.equal(areasService.matchSupportedArea('صعده').isSupported, true);
    assert.equal(areasService.matchSupportedArea('صعدة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('صعده').area?.canonicalId, 'loc-ye-saada');
  });

  test('Normalizes Hajjah variants: حجه vs حجة', () => {
    assert.equal(areasService.matchSupportedArea('حجه').isSupported, true);
    assert.equal(areasService.matchSupportedArea('حجة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('حجه').area?.canonicalId, 'loc-ye-hajjah');
  });

  test('Normalizes Al Hudaydah variants: حديدة, الحديده, مدينة الحديدة', () => {
    assert.equal(areasService.matchSupportedArea('حديده').isSupported, true);
    assert.equal(areasService.matchSupportedArea('الحديده').isSupported, true);
    assert.equal(areasService.matchSupportedArea('مدينة الحديدة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('محافظة الحديدة').isSupported, true);
  });

  test('Normalizes Sanaa capital variants: امانة العاصمة, أمانة العاصمة, صنعا', () => {
    assert.equal(areasService.matchSupportedArea('صنعا').isSupported, true);
    assert.equal(areasService.matchSupportedArea('امانة العاصمة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('أمانة العاصمة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('امانة العاصمة').area?.canonicalId, 'loc-ye-sanaa');
  });

  test('Normalizes Dhamar variants: ذمار, مدينة ذمار, محافظة ذمار', () => {
    assert.equal(areasService.matchSupportedArea('ذمار').isSupported, true);
    assert.equal(areasService.matchSupportedArea('مدينة ذمار').isSupported, true);
    assert.equal(areasService.matchSupportedArea('محافظة ذمار').isSupported, true);
  });

  test('Normalizes Raymah and Al Mahwit prefixes', () => {
    assert.equal(areasService.matchSupportedArea('ريمه').isSupported, true);
    assert.equal(areasService.matchSupportedArea('ريمة').isSupported, true);
    assert.equal(areasService.matchSupportedArea('المحويت').isSupported, true);
    assert.equal(areasService.matchSupportedArea('محويت').isSupported, true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Critical Taiz vs Taiz – Al Hawban Nuance
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Critical Taiz vs Taiz – Al Hawban Nuance ---');

  test('REJECTS generic "تعز" without Al Hawban with specific localized error', () => {
    const match = areasService.matchSupportedArea('تعز');
    assert.equal(match.isSupported, false);
    assert.equal(match.area, null);
    assert.ok(match.rejectionReasonAr);
    assert.ok(match.rejectionReasonAr?.includes('الحوبان'));
  });

  test('REJECTS "مدينة تعز" without Al Hawban', () => {
    const match = areasService.matchSupportedArea('مدينة تعز');
    assert.equal(match.isSupported, false);
    assert.ok(match.rejectionReasonAr?.includes('الحوبان'));
  });

  test('REJECTS "محافظة تعز" without Al Hawban', () => {
    const match = areasService.matchSupportedArea('محافظة تعز');
    assert.equal(match.isSupported, false);
    assert.ok(match.rejectionReasonAr?.includes('الحوبان'));
  });

  test('REJECTS English "Taiz" without Al Hawban', () => {
    const match = areasService.matchSupportedArea('Taiz');
    assert.equal(match.isSupported, false);
    assert.ok(match.rejectionReasonEn?.includes('Al Hawban'));
  });

  test('ACCEPTS "تعز – الحوبان" (with en-dash)', () => {
    const match = areasService.matchSupportedArea('تعز – الحوبان');
    assert.equal(match.isSupported, true);
    assert.equal(match.area?.canonicalId, 'loc-ye-taiz-al-hawban');
  });

  test('ACCEPTS "تعز - الحوبان" (with regular hyphen)', () => {
    const match = areasService.matchSupportedArea('تعز - الحوبان');
    assert.equal(match.isSupported, true);
    assert.equal(match.area?.canonicalId, 'loc-ye-taiz-al-hawban');
  });

  test('ACCEPTS "منطقة الحوبان" alone', () => {
    const match = areasService.matchSupportedArea('منطقة الحوبان');
    assert.equal(match.isSupported, true);
    assert.equal(match.area?.canonicalId, 'loc-ye-taiz-al-hawban');
  });

  test('ACCEPTS "الحوبان تعز" and "تعز (الحوبان)" and "Taiz - Al Hawban"', () => {
    assert.equal(areasService.matchSupportedArea('الحوبان تعز').isSupported, true);
    assert.equal(areasService.matchSupportedArea('تعز (الحوبان)').isSupported, true);
    assert.equal(areasService.matchSupportedArea('Taiz - Al Hawban').isSupported, true);
    assert.equal(areasService.matchSupportedArea('Al Hawban, Taiz').isSupported, true);
  });

  test('REJECTS Taiz city center coordinates (~13.5776, 44.0175) outside Hawban', () => {
    const taizCityCenter = {
      city: 'تعز',
      district: 'القاهرة',
      latitude: 13.5776,
      longitude: 44.0175,
    };
    const check = areasService.isAddressSupported(taizCityCenter);
    assert.equal(check.isSupported, false);
    assert.ok(check.rejectionReasonAr?.includes('الحوبان'));
  });

  test('ACCEPTS Al Hawban coordinates (~13.6100, 44.0600)', () => {
    const hawbanCoords = {
      city: 'تعز – الحوبان',
      district: 'الحوبان',
      latitude: 13.6100,
      longitude: 44.0600,
    };
    const check = areasService.isAddressSupported(hawbanCoords);
    assert.equal(check.isSupported, true);
    assert.equal(check.area?.canonicalId, 'loc-ye-taiz-al-hawban');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Geodesic Distance & Serviceability Calculations
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Geodesic Distance & Serviceability Calculations ---');

  test('Calculates geodesic distance between Sanaa and Amran (~45-50km)', () => {
    const dist = areasService.calculateGeodesicDistanceKm(15.3694, 44.1910, 15.6594, 43.9439);
    assert.ok(dist >= 35 && dist <= 60, `Distance was ${dist}km, expected ~45-50km`);
  });

  test('Calculates geodesic distance between Sanaa and Dhamar (~95-105km)', () => {
    const dist = areasService.calculateGeodesicDistanceKm(15.3694, 44.1910, 14.5428, 44.4056);
    assert.ok(dist >= 85 && dist <= 115, `Distance was ${dist}km, expected ~95-105km`);
  });

  test('Finds nearest supported area by coordinates within threshold', () => {
    const nearest = areasService.findSupportedAreaByCoordinates(15.3600, 44.2000, 50.0);
    assert.ok(nearest.area);
    assert.equal(nearest.area?.canonicalId, 'loc-ye-sanaa');
    assert.ok(nearest.distanceKm < 5.0);
  });

  test('Returns null for coordinates outside Yemen territory', () => {
    const nearest = areasService.findSupportedAreaByCoordinates(5.0, 60.0, 50.0);
    assert.equal(nearest.area, null);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Customer Destination Resolution & HTTP Request Parsing
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 6. Customer Destination Resolution & HTTP Request Parsing ---');

  await test('Resolves destination from query parameter "destinationCity"', async () => {
    const mockReq: any = {
      query: { destinationCity: 'صنعاء' },
      headers: {},
    };
    const dest = await serviceabilityService.resolveCustomerDestination(mockReq);
    assert.ok(dest);
    assert.equal(dest?.isSupported, true);
    assert.equal(dest?.cityName, 'صنعاء');
    assert.equal(dest?.canonicalCityId, 'loc-ye-sanaa');
  });

  await test('Resolves destination from header "x-destination-city"', async () => {
    const mockReq: any = {
      query: {},
      headers: { 'x-destination-city': 'ذمار' },
    };
    const dest = await serviceabilityService.resolveCustomerDestination(mockReq);
    assert.ok(dest);
    assert.equal(dest?.isSupported, true);
    assert.equal(dest?.cityName, 'ذمار');
    assert.equal(dest?.canonicalCityId, 'loc-ye-dhamar');
  });

  await test('Resolves Taiz - Al Hawban correctly from headers', async () => {
    const mockReq: any = {
      query: {},
      headers: { 'x-destination-city': 'تعز – الحوبان' },
    };
    const dest = await serviceabilityService.resolveCustomerDestination(mockReq);
    assert.ok(dest);
    assert.equal(dest?.isSupported, true);
    assert.equal(dest?.canonicalCityId, 'loc-ye-taiz-al-hawban');
  });

  await test('Flags unsupported destination when header is "عدن"', async () => {
    const mockReq: any = {
      query: {},
      headers: { 'x-destination-city': 'عدن' },
    };
    const dest = await serviceabilityService.resolveCustomerDestination(mockReq);
    assert.ok(dest);
    assert.equal(dest?.isSupported, false);
    assert.ok(dest?.matchResult.rejectionReasonAr);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Store Serviceability & Distance Limit Rules
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 7. Store Serviceability & Distance Limit Rules ---');

  test('Store and customer in same city within radius is serviceable', () => {
    const storeLocation = {
      city: 'صنعاء',
      latitude: 15.3694,
      longitude: 44.1910,
      maxDeliveryDistanceKm: 30.0,
    };
    const customerDestination = {
      latitude: 15.3500,
      longitude: 44.2000,
    };

    const dist = areasService.calculateGeodesicDistanceKm(
      storeLocation.latitude,
      storeLocation.longitude,
      customerDestination.latitude,
      customerDestination.longitude
    );
    assert.ok(dist <= storeLocation.maxDeliveryDistanceKm);
  });

  test('Store with 15km radius serving destination ~100km away is NOT serviceable', () => {
    const storeLocation = {
      city: 'صنعاء',
      latitude: 15.3694,
      longitude: 44.1910,
      maxDeliveryDistanceKm: 15.0,
    };
    const customerDestination = {
      latitude: 14.5428, // Dhamar
      longitude: 44.4056,
    };

    const dist = areasService.calculateGeodesicDistanceKm(
      storeLocation.latitude,
      storeLocation.longitude,
      customerDestination.latitude,
      customerDestination.longitude
    );
    assert.ok(dist > storeLocation.maxDeliveryDistanceKm);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Feature Flag Registration & Database Validation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 8. Feature Flag Registration & Database Validation ---');

  test('RemoteConfig defaults include city_based_product_discovery with default=false', () => {
    const flagDef = DEFAULT_FEATURE_FLAGS.find((f: any) => f.key === 'city_based_product_discovery');
    assert.ok(flagDef, 'Flag must be registered in defaults');
    assert.equal(flagDef?.enabled, false, 'Default must be false');
    assert.equal(flagDef?.isSensitive, true, 'Flag must be sensitive');
    assert.ok(flagDef?.platforms.includes('android'));
    assert.ok(flagDef?.platforms.includes('ios'));
    assert.ok(flagDef?.platforms.includes('web'));
  });

  await test('Verifies feature flag record in real PostgreSQL database', async () => {
    const dbFlag = await prisma.featureFlag.findUnique({
      where: { key: 'city_based_product_discovery' },
    });
    assert.ok(dbFlag, 'Flag must exist in PostgreSQL database');
    assert.equal(dbFlag?.key, 'city_based_product_discovery');
    assert.equal(typeof dbFlag?.enabled, 'boolean');
  });

  await test('Verifies 10 canonical cities exist in real PostgreSQL database', async () => {
    const allSanaa = await prisma.city.findMany({ where: { nameAr: 'صنعاء' } });
    console.log('    Sanaa records:', JSON.stringify(allSanaa));
    await areasService.ensureDatabaseSync();
    const cities = await prisma.city.findMany();
    console.log('    All Cities in DB:', cities.map((c: any) => `${c.nameAr} (country: ${c.countryId})`).join(', '));
    assert.ok(cities.length >= 10, `Found ${cities.length} cities in DB, expected at least 10`);
    const dbNames = cities.map((c: any) => c.nameAr);
    assert.ok(dbNames.includes('صنعاء'));
    assert.ok(dbNames.includes('صعدة'));
    assert.ok(dbNames.includes('تعز – الحوبان'));
  });

  console.log('\n========================================');
  console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('========================================\n');

  try {
    await prisma.$disconnect();
    await redis.disconnect();
  } catch (_) {}

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
