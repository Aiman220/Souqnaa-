import assert from 'assert';
import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';
import { launcherCampaignService } from '../src/modules/remote-config/launcher-campaign.service';
import {
  APPROVED_CUSTOMER_APP_ICONS,
  APPROVED_SELLER_APP_ICONS,
} from '../src/modules/remote-config/feature-flags.defaults';

async function runSeasonalLauncherEngineTests() {
  console.log('🧪 Starting SOUQNAA Seasonal Launcher Icon & Campaign Scheduling Test Suite...\n');

  const adminUser = { id: 'admin-test-id', email: 'admin@souqnaa.ye' };

  const restoreBaseline = async () => {
    try {
      await Promise.all([
        launcherCampaignService.updateLauncherConfig(
          'CUSTOMER',
          'ANDROID',
          {
            defaultIconId: 'default',
            defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
            seasonalIconId: 'sale_1_1',
            seasonalIconUrl: '',
            seasonalEnabled: false,
          },
          adminUser
        ),
        launcherCampaignService.updateLauncherConfig(
          'CUSTOMER',
          'IOS',
          {
            defaultIconId: 'default',
            defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
            seasonalIconId: 'customer_sale_1_1',
            seasonalIconUrl: '',
            seasonalEnabled: false,
          },
          adminUser
        ),
        launcherCampaignService.updateLauncherConfig(
          'SELLER',
          'ANDROID',
          {
            defaultIconId: 'seller_default',
            defaultIconUrl: '/uploads/branding/seller_app_icon.png',
            seasonalIconId: 'seller_sale_1_1',
            seasonalIconUrl: '',
            seasonalEnabled: false,
          },
          adminUser
        ),
        launcherCampaignService.updateLauncherConfig(
          'SELLER',
          'IOS',
          {
            defaultIconId: 'seller_default',
            defaultIconUrl: '/uploads/branding/seller_app_icon.png',
            seasonalIconId: 'seller_sale_1_1',
            seasonalIconUrl: '',
            seasonalEnabled: false,
          },
          adminUser
        ),
      ]);
      remoteConfigService.invalidateCache();
    } catch (_) {}
  };

  await restoreBaseline();

  try {

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 1: FOUR INDEPENDENT CONFIGURATION RECORDS IN DATABASE
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('1. Checking four strictly independent launcher configurations...');
  const allConfigs = await launcherCampaignService.getAllConfigs();

  assert(allConfigs['CUSTOMER_ANDROID'], 'CUSTOMER_ANDROID configuration exists');
  assert(allConfigs['CUSTOMER_IOS'], 'CUSTOMER_IOS configuration exists');
  assert(allConfigs['SELLER_ANDROID'], 'SELLER_ANDROID configuration exists');
  assert(allConfigs['SELLER_IOS'], 'SELLER_IOS configuration exists');

  assert.strictEqual(allConfigs['CUSTOMER_ANDROID'].applicationType, 'CUSTOMER');
  assert.strictEqual(allConfigs['CUSTOMER_ANDROID'].platform, 'ANDROID');
  assert.strictEqual(allConfigs['CUSTOMER_IOS'].applicationType, 'CUSTOMER');
  assert.strictEqual(allConfigs['CUSTOMER_IOS'].platform, 'IOS');
  assert.strictEqual(allConfigs['SELLER_ANDROID'].applicationType, 'SELLER');
  assert.strictEqual(allConfigs['SELLER_ANDROID'].platform, 'ANDROID');
  assert.strictEqual(allConfigs['SELLER_IOS'].applicationType, 'SELLER');
  assert.strictEqual(allConfigs['SELLER_IOS'].platform, 'IOS');

  console.log('  ✓ PASS: Four independent configurations verified in PostgreSQL database');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 2: CUSTOMER AND SELLER APPROVED REGISTRIES DO NOT CONFLICT
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n2. Verifying separate customer and seller registries...');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('sale_1_1'), 'Customer supports sale_1_1');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('sale_11_11'), 'Customer supports sale_11_11');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('sale_12_12'), 'Customer supports sale_12_12');
  assert(APPROVED_SELLER_APP_ICONS.includes('seller_sale_1_1'), 'Seller supports seller_sale_1_1');
  assert(APPROVED_SELLER_APP_ICONS.includes('seller_brand_glossy'), 'Seller supports seller_brand_glossy');
  assert(APPROVED_SELLER_APP_ICONS.includes('brand_glossy'), 'Seller supports brand_glossy');
  assert(APPROVED_SELLER_APP_ICONS.includes('ramadan'), 'Seller supports ramadan');
  assert(APPROVED_SELLER_APP_ICONS.includes('winter'), 'Seller supports winter');

  // Normalization logic respects app type
  assert.strictEqual(launcherCampaignService.normalizeIconId('sale_11_11', 'CUSTOMER'), 'sale_11_11');
  assert.strictEqual(launcherCampaignService.normalizeIconId('sale_1_1', 'SELLER'), 'seller_sale_1_1');
  assert.strictEqual(launcherCampaignService.normalizeIconId('brand_glossy', 'SELLER'), 'seller_brand_glossy');
  console.log('  ✓ PASS: Registries cleanly isolate customer and seller identifiers');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 3: CAMPAIGN RESOLVER ENGINE (MATHEMATICAL VERIFICATION)
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n3. Verifying campaign resolver engine behavior...');
  const baseTime = new Date('2026-06-01T12:00:00.000Z');
  const campaignStart = new Date('2026-06-10T00:00:00.000Z');
  const campaignEnd = new Date('2026-06-20T00:00:00.000Z');

  const testConfig = {
    id: 'test-id',
    applicationType: 'CUSTOMER' as const,
    platform: 'ANDROID' as const,
    defaultIconId: 'default',
    defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
    seasonalIconId: 'sale_11_11',
    seasonalIconUrl: 'https://souqnaa.ye/uploads/branding/sale_11_11.png',
    seasonalEnabled: true,
    campaignName: 'موسم رمضان',
    campaignDeepLink: 'souqnaa-customer://campaign/ramadan',
    campaignStartAt: campaignStart.toISOString(),
    campaignEndAt: campaignEnd.toISOString(),
    timezone: 'Asia/Aden',
    publishedVersion: 5,
    updatedAt: new Date().toISOString(),
    updatedBy: 'admin',
  };

  // Rule 1: seasonalEnabled = false -> default
  const disabledResolution = launcherCampaignService.resolveLauncherIcon(
    { ...testConfig, seasonalEnabled: false },
    new Date('2026-06-15T12:00:00.000Z')
  );
  assert.strictEqual(disabledResolution.activeIconId, 'default');
  assert.strictEqual(disabledResolution.isSeasonalActive, false);
  console.log('  ✓ PASS: Rule 1: seasonalEnabled = false -> defaultIcon');

  // Rule 2: currentTime < campaignStartAt -> default
  const futureResolution = launcherCampaignService.resolveLauncherIcon(
    testConfig,
    new Date('2026-06-05T12:00:00.000Z')
  );
  assert.strictEqual(futureResolution.activeIconId, 'default');
  assert.strictEqual(futureResolution.isSeasonalActive, false);
  console.log('  ✓ PASS: Rule 2: currentTime < campaignStartAt -> defaultIcon');

  // Rule 3: campaignStartAt <= currentTime < campaignEndAt -> seasonal
  const activeResolution1 = launcherCampaignService.resolveLauncherIcon(
    testConfig,
    new Date('2026-06-10T00:00:00.000Z') // Exact boundary start
  );
  assert.strictEqual(activeResolution1.activeIconId, 'sale_11_11');
  assert.strictEqual(activeResolution1.isSeasonalActive, true);

  const activeResolution2 = launcherCampaignService.resolveLauncherIcon(
    testConfig,
    new Date('2026-06-15T12:00:00.000Z') // Inside window
  );
  assert.strictEqual(activeResolution2.activeIconId, 'sale_11_11');
  assert.strictEqual(activeResolution2.activeIconUrl, 'https://souqnaa.ye/uploads/branding/sale_11_11.png');
  assert.strictEqual(activeResolution2.isSeasonalActive, true);
  console.log('  ✓ PASS: Rule 3: campaignStartAt <= currentTime < campaignEndAt -> seasonalIcon');

  // Rule 4: currentTime >= campaignEndAt -> default
  const expiredResolution = launcherCampaignService.resolveLauncherIcon(
    testConfig,
    new Date('2026-06-20T00:00:00.000Z') // Exact boundary end
  );
  assert.strictEqual(expiredResolution.activeIconId, 'default');
  assert.strictEqual(expiredResolution.isSeasonalActive, false);
  console.log('  ✓ PASS: Rule 4: currentTime >= campaignEndAt -> defaultIcon');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 4: INVALID DATE RANGE REJECTION (HTTP 400)
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n4. Verifying invalid / reversed date range rejection...');
  let dateRejected = false;
  try {
    await launcherCampaignService.updateLauncherConfig(
      'CUSTOMER',
      'ANDROID',
      {
        campaignStartAt: '2026-10-20T00:00:00.000Z',
        campaignEndAt: '2026-10-10T00:00:00.000Z', // Reversed!
      },
      adminUser
    );
  } catch (err: any) {
    dateRejected = true;
    assert.strictEqual(err.statusCode, 400);
    assert(err.message.includes('تاريخ نهاية الحملة'));
  }
  assert(dateRejected, 'Reversed dates must reject with 400');
  console.log('  ✓ PASS: Reversed campaign dates rejected with HTTP 400');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 5: STRICT APPLICATION ISOLATION (CUSTOMER VS SELLER)
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n5. Verifying strict application isolation (CUSTOMER vs SELLER)...');
  const now = new Date();
  const validStart = new Date(now.getTime() - 3600000).toISOString();
  const validEnd = new Date(now.getTime() + 86400000).toISOString();

  // Activate campaign ONLY on SELLER_ANDROID
  await launcherCampaignService.updateLauncherConfig(
    'SELLER',
    'ANDROID',
    {
      seasonalEnabled: true,
      seasonalIconId: 'seller_sale_1_1',
      seasonalIconUrl: 'https://souqnaa.ye/uploads/branding/seller_expo.png',
      campaignName: 'معرض التجار السنوي',
      campaignDeepLink: 'souqnaa-seller://campaign/expo',
      campaignStartAt: validStart,
      campaignEndAt: validEnd,
    },
    adminUser
  );

  // Check SELLER_ANDROID via RemoteConfig
  const sellerAndroidResolved = await remoteConfigService.getResolvedConfig({
    appType: 'seller',
    platform: 'android',
  });
  assert.strictEqual(sellerAndroidResolved.branding.customerAppIcon, 'seller_sale_1_1');
  assert.strictEqual(
    sellerAndroidResolved.branding.platforms.android.iconUrl,
    'https://souqnaa.ye/uploads/branding/seller_expo.png'
  );

  // Check CUSTOMER_ANDROID - Must remain untouched and default!
  const customerAndroidResolved = await remoteConfigService.getResolvedConfig({
    appType: 'customer',
    platform: 'android',
  });
  assert.strictEqual(customerAndroidResolved.branding.customerAppIcon, 'default');
  assert.notStrictEqual(
    customerAndroidResolved.branding.platforms.android.iconUrl,
    'https://souqnaa.ye/uploads/branding/seller_expo.png'
  );

  // Check SELLER_IOS - Platform independence: iOS was NOT enabled, remains default!
  const sellerIosResolved = await remoteConfigService.getResolvedConfig({
    appType: 'seller',
    platform: 'ios',
  });
  assert.strictEqual(sellerIosResolved.branding.customerAppIcon, 'seller_default');
  console.log('  ✓ PASS: Customer and Seller configurations and Android/iOS platforms are strictly isolated');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 6: AUTOMATIC CAMPAIGN EXPIRATION & RECONCILIATION
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n6. Testing automatic campaign expiration & reconciliation...');
  // Configure an expired campaign
  const expiredPastStart = new Date(now.getTime() - 7200000).toISOString();
  const expiredPastEnd = new Date(now.getTime() - 3600000).toISOString(); // Expired 1 hour ago

  await launcherCampaignService.updateLauncherConfig(
    'CUSTOMER',
    'IOS',
    {
      seasonalEnabled: true,
      seasonalIconId: 'sale_11_11',
      seasonalIconUrl: 'https://souqnaa.ye/uploads/branding/past_fest.png',
      campaignStartAt: expiredPastStart,
      campaignEndAt: expiredPastEnd,
    },
    adminUser
  );

  // Run reconciliation
  const reconResult = await launcherCampaignService.reconcileAllCampaignSchedules(now);
  assert(reconResult.reconciledCount >= 1, 'Reconciled at least 1 expired campaign');
  assert(reconResult.changed.includes('CUSTOMER_IOS'), 'CUSTOMER_IOS expired and was updated');

  // Verify CUSTOMER_IOS in DB is now seasonalEnabled = false
  const updatedCustomerIos = await launcherCampaignService.getConfig('CUSTOMER', 'IOS');
  assert.strictEqual(updatedCustomerIos.seasonalEnabled, false);
  console.log('  ✓ PASS: Expired campaign automatically deactivated and restored default');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 7: REDIS CACHE INVALIDATION & RE-WARMING
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n7. Testing Redis cache invalidation...');
  const cacheKey = 'remote_config:launcher:customer:android';
  const preCheck = await launcherCampaignService.getConfig('CUSTOMER', 'ANDROID');
  assert(preCheck !== null);

  // Invalidate
  await redis.del(cacheKey);
  const reloaded = await launcherCampaignService.getConfig('CUSTOMER', 'ANDROID');
  assert.strictEqual(reloaded.platform, 'ANDROID');
  console.log('  ✓ PASS: Cache invalidated and cleanly re-warmed from PostgreSQL');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 8: CLEAN RESET FOR ALL 4 CONFIGURATIONS
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n8. Cleaning up and resetting to default states...');
  await launcherCampaignService.updateLauncherConfig(
    'CUSTOMER',
    'ANDROID',
    {
      defaultIconId: 'default',
      defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
      seasonalEnabled: false,
      seasonalIconUrl: '',
    },
    adminUser
  );
  await launcherCampaignService.updateLauncherConfig(
    'CUSTOMER',
    'IOS',
    {
      defaultIconId: 'default',
      defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
      seasonalEnabled: false,
      seasonalIconUrl: '',
    },
    adminUser
  );
  await launcherCampaignService.updateLauncherConfig(
    'SELLER',
    'ANDROID',
    {
      defaultIconId: 'seller_default',
      defaultIconUrl: '/uploads/branding/seller_app_icon.png',
      seasonalEnabled: false,
      seasonalIconUrl: '',
    },
    adminUser
  );
  await launcherCampaignService.updateLauncherConfig(
    'SELLER',
    'IOS',
    {
      defaultIconId: 'seller_default',
      defaultIconUrl: '/uploads/branding/seller_app_icon.png',
      seasonalEnabled: false,
      seasonalIconUrl: '',
    },
    adminUser
  );
    console.log('  ✓ PASS: All 4 configurations cleanly restored');

    console.log('\n================================================================');
    console.log('🎉 ALL 8 SEASONAL LAUNCHER ENGINE INTEGRATION TESTS PASSED!');
    console.log('================================================================\n');
  } finally {
    await restoreBaseline();
  }
}

runSeasonalLauncherEngineTests()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
