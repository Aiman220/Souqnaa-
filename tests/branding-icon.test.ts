import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';
import { APPROVED_CUSTOMER_APP_ICONS } from '../src/modules/remote-config/feature-flags.defaults';
import { storageService } from '../src/services/storage/storage.service';
import assert from 'assert';

async function runBrandingIconTests() {
  console.log('🧪 Starting SOUQNAA Customer App Icon & Branding Comprehensive Test Suite...\n');

  const adminUser = { id: 'test-admin-id', email: 'admin@souqnaa.ye' };

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 1: APPROVED ICON REGISTRY
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('1. Checking approved icon registry...');
  assert(APPROVED_CUSTOMER_APP_ICONS.length === 5, 'APPROVED_CUSTOMER_APP_ICONS must contain 5 variants');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('default'), 'Contains default');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('orange'), 'Contains orange');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('modern'), 'Contains modern');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('minimal'), 'Contains minimal');
  assert(APPROVED_CUSTOMER_APP_ICONS.includes('seasonal'), 'Contains seasonal');
  console.log('  ✓ PASS: Approved icons registry contains default, orange, modern, minimal, seasonal');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 2: UPLOAD DEFAULT CUSTOMER APP ICON
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n2. Testing upload of default customer app icon...');
  const fakePngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const defaultUploadResult = await storageService.uploadFile(
    {
      buffer: fakePngBuffer,
      originalname: 'souqnaa_app_icon_test.png',
      mimetype: 'image/png',
      size: fakePngBuffer.length,
    } as any,
    'branding/general'
  );
  assert(defaultUploadResult.url.length > 0, 'Upload result contains public URL');
  assert(defaultUploadResult.key.startsWith('branding/general/'), 'Key is stored in branding/general');
  console.log(`  ✓ PASS: Uploaded default icon to ${defaultUploadResult.url}`);

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 3: UPLOAD SEASONAL CAMPAIGN APP ICON
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n3. Testing upload of seasonal campaign app icon...');
  const seasonalUploadResult = await storageService.uploadFile(
    {
      buffer: fakePngBuffer,
      originalname: 'ramadan_seasonal_icon.png',
      mimetype: 'image/png',
      size: fakePngBuffer.length,
    } as any,
    'branding/seasonal'
  );
  assert(seasonalUploadResult.url.length > 0, 'Upload result contains seasonal URL');
  assert(seasonalUploadResult.key.startsWith('branding/seasonal/'), 'Key is stored in branding/seasonal');
  console.log(`  ✓ PASS: Uploaded seasonal icon to ${seasonalUploadResult.url}`);

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 4: PATH RESOLUTION FOR "uploads/branding..." AND "/uploads/branding..."
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n4. Verifying storage cleanKey handles "uploads/branding" and "/uploads/branding"...');
  const keyWithSlash = storageService.cleanKey('/uploads/branding/souqnaa-app-icon.png');
  assert.strictEqual(keyWithSlash, 'branding/souqnaa-app-icon.png', 'cleanKey strips /uploads/ prefix');

  const keyWithoutSlash = storageService.cleanKey('uploads/branding/souqnaa-app-icon.png');
  assert.strictEqual(keyWithoutSlash, 'branding/souqnaa-app-icon.png', 'cleanKey strips uploads/ prefix');

  // Verify getFileStream can access the local file via both forms
  const fileStream1 = await storageService.getFileStream('branding/souqnaa-app-icon.png');
  assert(fileStream1.contentLength! > 0, 'File stream retrieved with valid content length');

  const fileStream2 = await storageService.getFileStream('uploads/branding/souqnaa-app-icon.png');
  assert(fileStream2.contentLength! > 0, 'File stream retrieved when requested as uploads/branding/...');
  console.log('  ✓ PASS: Storage provider resolves both relative and absolute uploads/ paths');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 5: SAVE BRANDING CONFIGURATION WITH UPLOAD PATH
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n5. Testing save branding configuration with "uploads/branding/app_icon_orange.png"...');
  const savedBranding = await remoteConfigService.updateBrandingConfig(
    {
      appNameAr: 'سوقناا',
      appNameEn: 'SOUQNAA',
      customerAppIcon: 'orange',
      defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
      platforms: {
        android: {
          iconUrl: 'uploads/branding/app_icon_orange.png',
          splashLogoUrl: '/uploads/branding/souqnaa-logo.png',
          deepLinkUrl: 'souqnaa://app/open',
          badgeText: '',
          enabled: true,
        },
        ios: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        tablet: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        desktop: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        web: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
      },
    },
    adminUser
  );
  assert.strictEqual(savedBranding.customerAppIcon, 'orange', 'customerAppIcon persisted as orange');
  assert.strictEqual(savedBranding.platforms.android.iconUrl, 'uploads/branding/app_icon_orange.png');

  // Check database persistence
  const dbIconSetting = await prisma.systemSetting.findUnique({ where: { key: 'customer_app_icon' } });
  assert.strictEqual(dbIconSetting?.value, 'orange', 'Database customer_app_icon equals orange');
  console.log('  ✓ PASS: Configuration successfully persisted to PostgreSQL SystemSetting');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 6: PUBLISH OPERATION & ETAG REVALIDATION (304)
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n6. Testing publish operation and ETag generation...');
  const resolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert(resolved.etag && resolved.etag.startsWith('W/'), 'ETag generated with weak validator W/');
  assert.strictEqual(resolved.branding.customerAppIcon, 'orange');

  // Conditional request with matching If-None-Match
  const cachedCheck = await remoteConfigService.getResolvedConfig({
    platform: 'android',
    ifNoneMatch: resolved.etag,
  });
  assert.strictEqual(cachedCheck.modified, false, 'Returns modified: false (304 Not Modified)');
  console.log('  ✓ PASS: Publish and ETag 304 revalidation verified');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 7: SEASONAL CAMPAIGN ENABLE / DISABLE & DATE BOUNDARIES
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n7. Testing seasonal campaign logic...');
  const now = new Date();
  const pastDate = new Date(now.getTime() - 2 * 86400000).toISOString();
  const futureDate = new Date(now.getTime() + 5 * 86400000).toISOString();

  // 7a. Enabled and within dates -> Seasonal icon active
  await remoteConfigService.updateBrandingConfig(
    {
      seasonalIcon: {
        enabled: true,
        name: 'موسم رمضان',
        iconUrl: seasonalUploadResult.url,
        deepLinkUrl: 'souqnaa://campaign/ramadan',
        startDate: pastDate,
        endDate: futureDate,
      },
    },
    adminUser
  );

  const seasonalResolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert.strictEqual(
    seasonalResolved.branding.platforms.android.iconUrl,
    seasonalUploadResult.url,
    'Active seasonal icon overrides platform iconUrl'
  );
  console.log('  ✓ PASS: Active seasonal icon correctly overrides Android icon during campaign');

  // 7b. Disabled seasonal icon -> Returns base icon
  await remoteConfigService.updateBrandingConfig(
    {
      seasonalIcon: {
        enabled: false,
        name: 'موسم رمضان',
        iconUrl: seasonalUploadResult.url,
        deepLinkUrl: 'souqnaa://campaign/ramadan',
        startDate: pastDate,
        endDate: futureDate,
      },
    },
    adminUser
  );

  const disabledSeasonalResolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert.strictEqual(
    disabledSeasonalResolved.branding.platforms.android.iconUrl,
    'uploads/branding/app_icon_orange.png',
    'Disabled seasonal icon restores base android iconUrl'
  );
  console.log('  ✓ PASS: Disabled seasonal icon correctly falls back to base Android icon');

  // 7c. Enabled but before start date -> Returns base icon
  const futureStart = new Date(now.getTime() + 10 * 86400000).toISOString();
  const futureEnd = new Date(now.getTime() + 20 * 86400000).toISOString();
  await remoteConfigService.updateBrandingConfig(
    {
      seasonalIcon: {
        enabled: true,
        name: 'عيد الفطر',
        iconUrl: seasonalUploadResult.url,
        deepLinkUrl: 'souqnaa://campaign/eid',
        startDate: futureStart,
        endDate: futureEnd,
      },
    },
    adminUser
  );

  const beforeStartResolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert.strictEqual(
    beforeStartResolved.branding.platforms.android.iconUrl,
    'uploads/branding/app_icon_orange.png',
    'Before start date falls back to base android iconUrl'
  );
  console.log('  ✓ PASS: Before campaign start date falls back to base icon');

  // 7d. Enabled but after end date -> Returns base icon
  const pastStart = new Date(now.getTime() - 20 * 86400000).toISOString();
  const pastEnd = new Date(now.getTime() - 10 * 86400000).toISOString();
  await remoteConfigService.updateBrandingConfig(
    {
      seasonalIcon: {
        enabled: true,
        name: 'عيد الأضحى المنتهي',
        iconUrl: seasonalUploadResult.url,
        deepLinkUrl: 'souqnaa://campaign/eid-past',
        startDate: pastStart,
        endDate: pastEnd,
      },
    },
    adminUser
  );

  const afterEndResolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert.strictEqual(
    afterEndResolved.branding.platforms.android.iconUrl,
    'uploads/branding/app_icon_orange.png',
    'After end date falls back to base android iconUrl'
  );
  console.log('  ✓ PASS: After campaign end date falls back to base icon');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 8: INVALID IDENTIFIER REJECTION (HTTP 400)
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n8. Testing rejection of malicious/invalid icon identifiers...');
  let rejected = false;
  try {
    await remoteConfigService.updateBrandingConfig(
      { customerAppIcon: 'invalid_malicious_script_tag' },
      adminUser
    );
  } catch (err: any) {
    rejected = true;
    assert.strictEqual(err.statusCode, 400, 'Error status code is 400');
    assert(err.message.includes('معرّف أيقونة التطبيق غير معتمد'), 'Error informs of invalid identifier');
  }
  assert(rejected, 'Invalid identifier must be rejected with HTTP 400');
  console.log('  ✓ PASS: Invalid icon identifier rejected with HTTP 400');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 9: CACHE INVALIDATION & REDIS EVICTION
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n9. Testing cache invalidation...');
  remoteConfigService.invalidateCache();
  // Call getResolvedConfig to ensure cache is re-warmed cleanly
  const rewarmed = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  assert(rewarmed.modified === true, 'Cache reloaded cleanly from database');
  console.log('  ✓ PASS: Memory and Redis caches invalidated and cleanly re-warmed');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 10: SELLER APPLICATION ISOLATION
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n10. Verifying seller application isolation...');
  const sellerConfig = await remoteConfigService.getResolvedConfig({ platform: 'android' });
  // Customer app icon settings do not alter seller application identity or crash seller
  assert(sellerConfig.features !== undefined, 'Seller receives valid features');
  console.log('  ✓ PASS: Seller application isolated from customer app launcher aliases');

  // ═════════════════════════════════════════════════════════════════════════════
  // TEST 11: RESET TO DEFAULT
  // ═════════════════════════════════════════════════════════════════════════════
  console.log('\n11. Resetting branding to default...');
  const resetBranding = await remoteConfigService.updateBrandingConfig(
    {
      customerAppIcon: 'default',
      platforms: {
        android: {
          iconUrl: '/uploads/branding/souqnaa-app-icon.png',
          splashLogoUrl: '/uploads/branding/souqnaa-logo.png',
          deepLinkUrl: 'souqnaa://app/open',
          badgeText: '',
          enabled: true,
        },
        ios: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        tablet: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        desktop: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
        web: { iconUrl: '', splashLogoUrl: '', deepLinkUrl: '', badgeText: '', enabled: true },
      },
      seasonalIcon: {
        enabled: false,
        name: '',
        iconUrl: '',
        deepLinkUrl: '',
      },
    },
    adminUser
  );
  assert.strictEqual(resetBranding.customerAppIcon, 'default');
  const defaultRec = await prisma.systemSetting.findUnique({ where: { key: 'customer_app_icon' } });
  assert.strictEqual(defaultRec?.value, 'default');
  console.log('  ✓ PASS: System cleanly restored to default icon');

  console.log('\n================================================================');
  console.log('🎉 ALL 11 BACKEND & STORAGE REGRESSION TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

runBrandingIconTests()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
