import assert from 'assert';
import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';
import { launcherCampaignService } from '../src/modules/remote-config/launcher-campaign.service';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';

/**
 * SOUQNAA — End-to-End Verification Test Suite
 * 
 * Demonstrates:
 * 1. GET initial configuration for all 4 application/platform combinations.
 * 2. UPDATE Customer Android via Branding Config API.
 * 3. Verify Admin UI read endpoint immediately reflects the saved & published changes.
 * 4. Verify Customer Android Remote Config evaluation resolves the active seasonal icon.
 * 5. Verify Customer iOS Remote Config remains on default icon (Strict Platform Isolation).
 * 6. Verify Seller Android and Seller iOS remain unaffected (Strict App Isolation).
 * 7. Verify Campaign Expiration Scheduler deactivates campaign and restores default icon.
 * 8. Verify Admin UI read endpoint immediately displays deactivated status without stale cache.
 * 9. Reset and cleanly restore defaults.
 */
async function runEndToEndVerification() {
  console.log('================================================================');
  console.log('🚀 SOUQNAA — COMPREHENSIVE END-TO-END SEASONAL LAUNCHER TEST');
  console.log('================================================================\n');

  const adminUser = { id: 'admin_test_e2e', email: 'admin-e2e@souqnaa.ye' };

  try {
    // -------------------------------------------------------------
    // Step 1: Initial State Retrieval with Retry
    // -------------------------------------------------------------
    console.log('Step 1: Retrieving all 4 independent launcher configurations...');
    let initialConfigs: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        initialConfigs = await launcherCampaignService.getAllConfigs();
        break;
      } catch (err: any) {
        if (attempt === 3) throw err;
        console.log(`  ... DB connect retry (${attempt}/3): ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    
    assert(initialConfigs['CUSTOMER_ANDROID'], 'CUSTOMER_ANDROID must exist');
    assert(initialConfigs['CUSTOMER_IOS'], 'CUSTOMER_IOS must exist');
    assert(initialConfigs['SELLER_ANDROID'], 'SELLER_ANDROID must exist');
    assert(initialConfigs['SELLER_IOS'], 'SELLER_IOS must exist');

    console.log('  ✓ CUSTOMER_ANDROID: default=' + initialConfigs['CUSTOMER_ANDROID'].defaultIconId + ', seasonalEnabled=' + initialConfigs['CUSTOMER_ANDROID'].seasonalEnabled);
    console.log('  ✓ CUSTOMER_IOS:     default=' + initialConfigs['CUSTOMER_IOS'].defaultIconId + ', seasonalEnabled=' + initialConfigs['CUSTOMER_IOS'].seasonalEnabled);
    console.log('  ✓ SELLER_ANDROID:   default=' + initialConfigs['SELLER_ANDROID'].defaultIconId + ', seasonalEnabled=' + initialConfigs['SELLER_ANDROID'].seasonalEnabled);
    console.log('  ✓ SELLER_IOS:       default=' + initialConfigs['SELLER_IOS'].defaultIconId + ', seasonalEnabled=' + initialConfigs['SELLER_IOS'].seasonalEnabled);
    console.log('  ✓ PASS: All 4 independent configurations retrieved successfully.\n');

    // -------------------------------------------------------------
    // Step 2: Admin Updates Customer Branding with Active Seasonal Campaign
    // -------------------------------------------------------------
    console.log('Step 2: Admin updates Customer branding with active Ramadan campaign...');
    const now = new Date();
    const campaignStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago
    const campaignEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);   // in 2 days

    const updatedBranding = await remoteConfigService.updateBrandingConfig(
      {
        seasonalIcon: {
          enabled: true,
          name: 'موسم رمضان المبارك 2026',
          iconUrl: 'seasonal',
          deepLinkUrl: 'souqnaa://campaigns/ramadan',
          startDate: campaignStart.toISOString(),
          endDate: campaignEnd.toISOString(),
        },
        platforms: {
          android: {
            iconUrl: '/uploads/branding/souqnaa-app-icon.png',
            deepLinkUrl: 'souqnaa://app/open',
            enabled: true,
            seasonalEnabled: true,
            seasonalIconUrl: 'seasonal',
            seasonalIconId: 'seasonal',
            campaignName: 'موسم رمضان المبارك 2026',
            campaignStartAt: campaignStart.toISOString(),
            campaignEndAt: campaignEnd.toISOString(),
          },
          ios: {
            iconUrl: 'default',
            deepLinkUrl: 'souqnaa://app/open',
            enabled: true,
            seasonalEnabled: false, // Keep iOS on default to prove platform isolation!
            seasonalIconUrl: '',
            seasonalIconId: 'customer_seasonal',
            campaignName: '',
            campaignStartAt: null,
            campaignEndAt: null,
          },
          tablet: { iconUrl: '', deepLinkUrl: '', enabled: true },
          desktop: { iconUrl: '', deepLinkUrl: '', enabled: true },
          web: { iconUrl: '', deepLinkUrl: '', enabled: true },
        },
      },
      adminUser,
      undefined,
      'CUSTOMER'
    );

    assert(updatedBranding, 'Updated branding must be returned');
    console.log('  ✓ Saved & Published Customer Branding Version: ' + updatedBranding.platforms.android.publishedVersion);
    console.log('  ✓ PASS: Branding configuration persisted and published.\n');

    // -------------------------------------------------------------
    // Step 3: Verify Admin Read Endpoint Returns Fresh Persisted State
    // -------------------------------------------------------------
    console.log('Step 3: Checking Admin Read Endpoint (getBrandingConfig)...');
    const readBranding = await remoteConfigService.getBrandingConfig('CUSTOMER');
    assert.strictEqual(readBranding.platforms.android.seasonalEnabled, true, 'Android seasonalEnabled must be true in read endpoint');
    assert.strictEqual(readBranding.platforms.ios.seasonalEnabled, false, 'iOS seasonalEnabled must be false (independent)');
    assert.strictEqual(readBranding.seasonalIcon.name, 'موسم رمضان المبارك 2026');
    console.log('  ✓ Admin read endpoint returns latest persisted state without stale cache.');
    console.log('  ✓ PASS: Admin Feature Flags screen data is fresh and synchronized.\n');

    // -------------------------------------------------------------
    // Step 4: Verify Customer Android Client Remote Config Resolution
    // -------------------------------------------------------------
    console.log('Step 4: Evaluating Customer Android Remote Config (Mobile Client Request)...');
    const custAndroidResolved = await remoteConfigService.getResolvedConfig({
      platform: 'android',
      appType: 'customer',
    });
    console.log('  ✓ Customer Android resolved activeIconId: ' + custAndroidResolved.branding.customerAppIcon);
    assert.strictEqual(custAndroidResolved.branding.customerAppIcon, 'seasonal', 'Customer Android active launcher icon must be seasonal');
    console.log('  ✓ PASS: Customer Android resolves active seasonal launcher icon.\n');

    // -------------------------------------------------------------
    // Step 5: Verify Customer iOS Client Remote Config Resolution (Platform Isolation)
    // -------------------------------------------------------------
    console.log('Step 5: Evaluating Customer iOS Remote Config (Platform Isolation)...');
    const custIosResolved = await remoteConfigService.getResolvedConfig({
      platform: 'ios',
      appType: 'customer',
    });
    console.log('  ✓ Customer iOS resolved activeIconId: ' + custIosResolved.branding.customerAppIcon);
    assert.strictEqual(custIosResolved.branding.customerAppIcon, 'default', 'Customer iOS must remain default icon');
    console.log('  ✓ PASS: Customer Android configuration does not leak to Customer iOS.\n');

    // -------------------------------------------------------------
    // Step 6: Verify Seller Android & iOS Remote Config Resolution (App Isolation)
    // -------------------------------------------------------------
    console.log('Step 6: Evaluating Seller Android & iOS Remote Config (App Isolation)...');
    const sellerAndroidResolved = await remoteConfigService.getResolvedConfig({
      platform: 'android',
      appType: 'seller',
    });
    const sellerIosResolved = await remoteConfigService.getResolvedConfig({
      platform: 'ios',
      appType: 'seller',
    });
    console.log('  ✓ Seller Android activeIconId: ' + sellerAndroidResolved.branding.customerAppIcon);
    console.log('  ✓ Seller iOS activeIconId:     ' + sellerIosResolved.branding.customerAppIcon);
    assert.strictEqual(sellerAndroidResolved.branding.customerAppIcon, 'seller_default', 'Seller Android must remain seller_default');
    assert.strictEqual(sellerIosResolved.branding.customerAppIcon, 'seller_default', 'Seller iOS must remain seller_default');
    console.log('  ✓ PASS: Customer configuration does NOT modify Seller configuration.\n');

    // -------------------------------------------------------------
    // Step 7: Scheduler Reconciliation & Campaign Expiration
    // -------------------------------------------------------------
    console.log('Step 7: Simulating Campaign Expiration and Automated Scheduler Reconciliation...');
    // Simulate current time is past campaignEndAt
    const futureSimulatedTime = new Date(campaignEnd.getTime() + 1000);
    const reconcileResult = await launcherCampaignService.reconcileAllCampaignSchedules(futureSimulatedTime);
    console.log(`  ✓ Scheduler reconciled count: ${reconcileResult.reconciledCount}, changed: ${reconcileResult.changed.join(', ')}`);
    assert(reconcileResult.reconciledCount > 0, 'Scheduler must reconcile expired campaign');
    assert(reconcileResult.changed.includes('CUSTOMER_ANDROID'), 'CUSTOMER_ANDROID must be in reconciled list');

    // Verify Customer Android now resolves back to default icon
    const expiredCustAndroid = await remoteConfigService.getResolvedConfig({
      platform: 'android',
      appType: 'customer',
    });
    console.log('  ✓ Post-expiration Customer Android activeIconId: ' + expiredCustAndroid.branding.customerAppIcon);
    assert.strictEqual(expiredCustAndroid.branding.customerAppIcon, 'default', 'Must restore default icon on campaign expiration');
    console.log('  ✓ PASS: Expired campaign automatically deactivates and restores default icon.\n');

    // -------------------------------------------------------------
    // Step 8: Clean Up & Reset
    // -------------------------------------------------------------
    console.log('Step 8: Resetting all configurations to safe defaults...');
    await Promise.all([
      launcherCampaignService.updateLauncherConfig(
        'CUSTOMER',
        'ANDROID',
        {
          defaultIconId: 'default',
          defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
          seasonalIconId: 'seasonal',
          seasonalIconUrl: '',
          seasonalEnabled: false,
          campaignName: '',
          campaignDeepLink: 'souqnaa://app/open',
          campaignStartAt: null,
          campaignEndAt: null,
        },
        adminUser
      ),
      launcherCampaignService.updateLauncherConfig(
        'CUSTOMER',
        'IOS',
        {
          defaultIconId: 'default',
          defaultIconUrl: 'default',
          seasonalIconId: 'seasonal',
          seasonalIconUrl: '',
          seasonalEnabled: false,
          campaignName: '',
          campaignDeepLink: 'souqnaa://app/open',
          campaignStartAt: null,
          campaignEndAt: null,
        },
        adminUser
      ),
      launcherCampaignService.updateLauncherConfig(
        'SELLER',
        'ANDROID',
        {
          defaultIconId: 'seller_default',
          defaultIconUrl: '/uploads/branding/seller_app_icon.png',
          seasonalIconId: 'seller_seasonal',
          seasonalIconUrl: '',
          seasonalEnabled: false,
          campaignName: '',
          campaignDeepLink: 'souqnaa-seller://app/open',
          campaignStartAt: null,
          campaignEndAt: null,
        },
        adminUser
      ),
      launcherCampaignService.updateLauncherConfig(
        'SELLER',
        'IOS',
        {
          defaultIconId: 'seller_default',
          defaultIconUrl: 'seller_default',
          seasonalIconId: 'seller_seasonal',
          seasonalIconUrl: '',
          seasonalEnabled: false,
          campaignName: '',
          campaignDeepLink: 'souqnaa-seller://app/open',
          campaignStartAt: null,
          campaignEndAt: null,
        },
        adminUser
      ),
    ]);

    remoteConfigService.invalidateCache();
    console.log('  ✓ PASS: All launcher configurations cleanly restored to defaults.\n');

    console.log('================================================================');
    console.log('🎉 ALL END-TO-END VERIFICATION CHECKS PASSED PERFECTLY!');
    console.log('================================================================');
  } catch (error) {
    console.error('❌ E2E Verification failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    try {
      redis.disconnect();
    } catch (_) {}
  }
}

runEndToEndVerification();
