/**
 * SOUQNAA - Production-Grade Remote Configuration & Feature Flags Test Suite
 *
 * Validates:
 * - Fail-safe defaults & sensitive feature security
 * - Database seeding & flag retrieval
 * - Platform targeting & scheduling evaluation
 * - Deterministic user rollout hashing
 * - Feature dependencies resolution
 * - ETag generation & conditional cache validation
 * - Admin updates, quick toggles, & audit logging
 * - Server-side middleware & endpoint enforcement
 */

import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';
import { DEFAULT_FEATURE_FLAGS, DEFAULT_WALLET_PROVIDERS } from '../src/modules/remote-config/feature-flags.defaults';
import { requireFeature, requireWalletProvider } from '../src/modules/remote-config/remote-config.middleware';
import { prisma } from '../src/database/prisma';

async function runRemoteConfigTests() {
  console.log('🧪 Starting SOUQNAA Remote Configuration & Feature Flags Test Suite...\n');
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

  try {
    // Reset database flags to factory safe defaults before testing
    await remoteConfigService.resetToDefaults({ id: 'test-runner', email: 'test@souqnaa.ye' });

    // ── 1. Fail-Safe Defaults & Sensitive Flags ──────────────────────────────
    console.log('--- 1. Fail-Safe Defaults & Sensitive Flags ---');
    
    // Check that sensitive financial flags default to false
    const onlinePaymentDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'online_payment');
    assert(onlinePaymentDef?.enabled === false, 'Fail-safe default: online_payment MUST default to false');
    assert(onlinePaymentDef?.isSensitive === true, 'online_payment is marked as sensitive');

    const walletDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'electronic_wallet_providers');
    assert(walletDef?.enabled === false, 'Fail-safe default: electronic_wallet_providers MUST default to false');
    assert(walletDef?.isSensitive === true, 'electronic_wallet_providers is marked as sensitive');

    const coinsDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'coins_rewards');
    assert(coinsDef?.enabled === false, 'Fail-safe default: coins_rewards MUST default to false');
    assert(coinsDef?.isSensitive === true, 'coins_rewards is marked as sensitive');

    // Marketplace standard flags default to true
    const codDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'cash_on_delivery');
    assert(codDef?.enabled === true, 'Standard default: cash_on_delivery defaults to true');

    const standardDeliveryDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'standard_delivery');
    assert(standardDeliveryDef?.enabled === true, 'Standard default: standard_delivery defaults to true');

    const refundsDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'refunds');
    assert(refundsDef?.enabled === true, 'Standard default: refunds defaults to true');
    assert(refundsDef?.isSensitive === true, 'refunds is marked as sensitive');

    // ── 2. Seeding & Evaluation via Service ─────────────────────────────────
    console.log('\n--- 2. Database Seeding & Evaluation ---');
    const fullConfig = await remoteConfigService.getResolvedConfig();
    const adminFlags = await remoteConfigService.getAllFlagsForAdmin();
    assert(adminFlags.length >= 10, `Database contains all 10 core feature flags (found: ${adminFlags.length})`);
    assert(fullConfig.configVersion >= 1, `Config version is valid: v${fullConfig.configVersion}`);
    assert(fullConfig.etag.length > 5, `Config ETag generated correctly: ${fullConfig.etag}`);

    // ── 3. Platform Targeting Evaluation ───────────────────────────────────
    console.log('\n--- 3. Platform Targeting ---');
    const androidConfig = await remoteConfigService.getResolvedConfig({ platform: 'android' });
    const webConfig = await remoteConfigService.getResolvedConfig({ platform: 'web' });
    assert(typeof androidConfig.features['standard_delivery'] === 'boolean', 'Evaluated config returns booleans for android');
    assert(typeof webConfig.features['standard_delivery'] === 'boolean', 'Evaluated config returns booleans for web');

    // ── 4. Deterministic Rollout Calculation ────────────────────────────────
    console.log('\n--- 4. Deterministic Rollout Calculation ---');
    const userA = 'customer-uuid-1111-aaaa';
    const userB = 'customer-uuid-2222-bbbb';
    
    // Evaluate multiple times for userA — should be strictly deterministic
    const bucketA1 = remoteConfigService.computeRolloutBucket(userA);
    const bucketA2 = remoteConfigService.computeRolloutBucket(userA);
    const bucketB = remoteConfigService.computeRolloutBucket(userB);

    assert(bucketA1 === bucketA2, 'Deterministic rollout: Same user consistently lands in identical hash bucket');
    assert(bucketA1 >= 0 && bucketA1 < 100, `Rollout bucket is within [0, 99]: ${bucketA1}`);
    assert(bucketB >= 0 && bucketB < 100, `Rollout bucket for User B is valid: ${bucketB}`);

    const eval1 = await remoteConfigService.getResolvedConfig({ userId: userA });
    const eval2 = await remoteConfigService.getResolvedConfig({ userId: userA });
    assert(
      JSON.stringify(eval1.features) === JSON.stringify(eval2.features),
      'Deterministic rollout: Same user receives identical feature flag evaluations'
    );

    // ── 5. Feature Dependencies ─────────────────────────────────────────────
    console.log('\n--- 5. Feature Dependencies ---');
    // Ensure dependencies declared in defaults
    const scheduledDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'scheduled_delivery');
    assert(scheduledDef?.dependencies.includes('standard_delivery') === true, 'scheduled_delivery depends on standard_delivery');

    const expressDef = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'express_delivery');
    assert(expressDef?.dependencies.includes('standard_delivery') === true, 'express_delivery depends on standard_delivery');

    const walletDepends = DEFAULT_FEATURE_FLAGS.find(f => f.key === 'electronic_wallet_providers');
    assert(walletDepends?.dependencies.includes('online_payment') === true, 'electronic_wallet_providers depends on online_payment');

    // ── 6. ETag & 304 Cache Validation ──────────────────────────────────────
    console.log('\n--- 6. ETag & 304 Cache Validation ---');
    const resolvedConfig = await remoteConfigService.getResolvedConfig();
    const cachedResponse = await remoteConfigService.getResolvedConfig({ ifNoneMatch: resolvedConfig.etag });
    assert(cachedResponse.modified === false, 'ETag conditional match returns modified: false (HTTP 304 equivalent)');

    // ── 7. Admin Toggle & Audit Logging ─────────────────────────────────────
    console.log('\n--- 7. Admin Toggle & Audit Logging ---');
    
    // Toggle online_payment ON
    const toggleResult = await remoteConfigService.updateFlag(
      'online_payment',
      {
        enabled: true,
        reason: 'Automated test activation for online payments',
      },
      { id: 'admin-001', email: 'admin@souqnaa.ye' }
    );
    assert(toggleResult.enabled === true, 'Admin successfully enabled online_payment');

    // Verify audit log entry was created in DB
    const latestAuditLog = await prisma.featureFlagAuditLog.findFirst({
      where: { featureKey: 'online_payment' },
      orderBy: { createdAt: 'desc' },
    });
    assert(latestAuditLog !== null, 'Audit log record was persisted in database');
    assert(latestAuditLog?.action === 'TOGGLE_ON', `Audit log action is TOGGLE_ON (actual: ${latestAuditLog?.action})`);
    assert(latestAuditLog?.changedBy === 'admin@souqnaa.ye', `Audit log author matches: ${latestAuditLog?.changedBy}`);
    assert(latestAuditLog?.reason === 'Automated test activation for online payments', 'Audit log reason matches');

    // Revert online_payment back to false for safe defaults
    const revertResult = await remoteConfigService.updateFlag(
      'online_payment',
      {
        enabled: false,
        reason: 'Reverting online_payment to secure fail-safe default',
      },
      { id: 'admin-001', email: 'admin@souqnaa.ye' }
    );
    assert(revertResult.enabled === false, 'Admin successfully restored online_payment to false');

    // Verify that wallet dependency is enforced when online_payment is false
    const evalAfterRevert = await remoteConfigService.getResolvedConfig();
    assert(
      evalAfterRevert.features['online_payment'] === false,
      'Authoritative state: online_payment is disabled'
    );
    assert(
      evalAfterRevert.features['electronic_wallet_providers'] === false,
      'Cascaded dependency: electronic_wallet_providers is inactive because online_payment is disabled'
    );

    // ── 8. Server-Side Middleware Enforcement ───────────────────────────────
    console.log('\n--- 8. Server-Side Middleware Enforcement ---');
    
    // Simulate Express req, res, next for requireFeature('online_payment')
    let middlewareError: any = null;
    let nextCalled = false;

    const mockReq: any = { ip: '127.0.0.1', headers: {}, query: {} };
    const mockRes: any = {};
    const mockNext = (err?: any) => {
      if (err) {
        middlewareError = err;
      } else {
        nextCalled = true;
      }
    };

    // Since online_payment is false, middleware must reject the request with 403 AppError
    const middleware = requireFeature('online_payment');
    await middleware(mockReq, mockRes, mockNext);

    assert(!nextCalled, 'Backend Enforcement: next() was NOT called with success when feature is disabled');
    assert(middlewareError !== null, 'Backend Enforcement: next() received an AppError when feature is disabled');
    assert(middlewareError?.statusCode === 403, `Backend Enforcement: HTTP Status 403 returned (actual: ${middlewareError?.statusCode})`);
    assert(middlewareError?.code === 'FEATURE_DISABLED', `Backend Enforcement: Error code is FEATURE_DISABLED (actual: ${middlewareError?.code})`);

    // Test passing middleware for an enabled feature: standard_delivery
    let standardNextCalled = false;
    let standardError: any = null;
    const standardMiddleware = requireFeature('standard_delivery');
    await standardMiddleware(mockReq, mockRes, (err?: any) => {
      if (err) {
        standardError = err;
      } else {
        standardNextCalled = true;
      }
    });
    assert(standardNextCalled, 'Backend Enforcement: next() IS called when standard_delivery is enabled');
    assert(standardError === null, 'No error passed to next() for active feature');

    // ── 9. Wallet Provider Level Configuration ──────────────────────────────
    console.log('\n--- 9. Wallet Provider Sub-level Configuration ---');
    const kuraimiActive = await remoteConfigService.isWalletProviderActive('KURAIMI');
    // Since electronic_wallet_providers is disabled, kuraimiActive should be false
    assert(!kuraimiActive, 'Wallet provider inactive while parent electronic_wallet_providers is disabled');

    // Verify all 12 wallet providers exist in defaults
    const defaultWalletKeys = Object.keys(DEFAULT_WALLET_PROVIDERS);
    assert(defaultWalletKeys.length === 12, `All 12 wallet providers configured (actual: ${defaultWalletKeys.length})`);
    assert(!!DEFAULT_WALLET_PROVIDERS['YEMEN_WALLET'], 'Wallet provider YEMEN_WALLET exists');
    assert(!!DEFAULT_WALLET_PROVIDERS['SABA_CASH'], 'Wallet provider SABA_CASH exists');
    assert(!!DEFAULT_WALLET_PROVIDERS['PAYS'], 'Wallet provider PAYS exists');
    assert(!!DEFAULT_WALLET_PROVIDERS['EASY_PAY'], 'Wallet provider EASY_PAY exists');
    assert(!!DEFAULT_WALLET_PROVIDERS['SHAMIL_MONEY'], 'Wallet provider SHAMIL_MONEY exists');
    assert(!!DEFAULT_WALLET_PROVIDERS['MOBILE_MONEY'], 'Wallet provider MOBILE_MONEY exists');

    // Test updating an individual wallet provider
    const updatedFlag = await remoteConfigService.updateWalletProvider(
      'YEMEN_WALLET',
      false,
      'تعطيل مؤقت للصيانة من البنك',
      { id: 'admin-1', email: 'admin@souqnaa.ye' }
    );
    const updatedMeta = typeof updatedFlag.metadata === 'string' ? JSON.parse(updatedFlag.metadata) : updatedFlag.metadata;
    assert(updatedMeta.providers['YEMEN_WALLET'].enabled === false, 'YEMEN_WALLET individual provider disabled via updateWalletProvider');

    // Re-enable individual wallet provider
    const reenabledFlag = await remoteConfigService.updateWalletProvider(
      'YEMEN_WALLET',
      true,
      'إعادة تفعيل بعد انتهاء الصيانة',
      { id: 'admin-1', email: 'admin@souqnaa.ye' }
    );
    const reenabledMeta = typeof reenabledFlag.metadata === 'string' ? JSON.parse(reenabledFlag.metadata) : reenabledFlag.metadata;
    assert(reenabledMeta.providers['YEMEN_WALLET'].enabled === true, 'YEMEN_WALLET individual provider re-enabled via updateWalletProvider');

    // ── 10. App Branding, Platform Icons & Dynamic Launchers ──────────────────
    console.log('\n--- 10. App Branding, Platform Icons & Dynamic Launchers ---');
    const branding = await remoteConfigService.getBrandingConfig();
    assert(branding.appNameAr === 'سوقناا', 'Default branding has Arabic app name');
    assert(!!branding.platforms.android, 'Branding has android platform icon configuration');
    assert(!!branding.platforms.ios, 'Branding has iOS platform icon configuration');
    assert(!!branding.platforms.tablet, 'Branding has tablet platform icon configuration');
    assert(!!branding.platforms.desktop, 'Branding has desktop platform icon configuration');
    assert(!!branding.platforms.web, 'Branding has web platform icon configuration');

    // Update branding with custom icon and deep-link
    const updatedBranding = await remoteConfigService.updateBrandingConfig({
      seasonalIcon: {
        enabled: false,
        name: '',
        iconUrl: '',
      },
      platforms: {
        ...branding.platforms,
        android: {
          iconUrl: '/uploads/branding/custom-android-icon.png',
          splashLogoUrl: '/uploads/branding/custom-splash.png',
          deepLinkUrl: 'souqnaa://catalog/summer-sale',
          badgeText: 'HOT',
          enabled: true,
        },
      },
    }, { id: 'admin-user-1', email: 'admin@souqnaa.ye' });

    assert(updatedBranding.platforms.android.iconUrl === '/uploads/branding/custom-android-icon.png', 'Branding android icon updated');
    assert(updatedBranding.platforms.android.deepLinkUrl === 'souqnaa://catalog/summer-sale', 'Branding android deep link updated');

    // Verify resolved config includes branding
    const brandingResolvedConfig = await remoteConfigService.getResolvedConfig({ platform: 'android' });
    assert(brandingResolvedConfig.branding.platforms.android.iconUrl === '/uploads/branding/custom-android-icon.png', 'Resolved config serves updated android icon');
    assert(brandingResolvedConfig.branding.platforms.android.deepLinkUrl === 'souqnaa://catalog/summer-sale', 'Resolved config serves updated android deep link');

    // Verify audit log exists for branding change
    const brandingAudit = await prisma.featureFlagAuditLog.findFirst({
      where: { featureKey: 'app_branding_config' },
      orderBy: { createdAt: 'desc' },
    });
    assert(brandingAudit !== null, 'Audit log recorded for app branding update');
    assert(brandingAudit?.action === 'UPDATE', 'Audit log action is UPDATE for branding');

    // Test seasonal override within date range
    const seasonalUpdated = await remoteConfigService.updateBrandingConfig({
      seasonalIcon: {
        enabled: true,
        name: 'Ramadan Edition',
        iconUrl: '/uploads/branding/ramadan-lantern.png',
        deepLinkUrl: 'souqnaa://ramadan-offers',
        startDate: new Date(Date.now() - 3600000).toISOString(),
        endDate: new Date(Date.now() + 3600000).toISOString(),
      },
    }, { id: 'admin-user-1', email: 'admin@souqnaa.ye' });

    const seasonalResolved = await remoteConfigService.getResolvedConfig({ platform: 'android' });
    assert(seasonalResolved.branding.platforms.android.iconUrl === '/uploads/branding/ramadan-lantern.png', 'Seasonal icon active within date window overrides android icon');
    assert(seasonalResolved.branding.platforms.android.deepLinkUrl === 'souqnaa://ramadan-offers', 'Seasonal deep link overrides android deep link');

    // --- 11. Platform Wallet Accounts Configuration & Audit ---
    console.log('\n--- 11. Platform Wallet Accounts Configuration & Audit ---');
    const allPlatformWallets = await remoteConfigService.getPlatformWalletAccounts(undefined, true);
    assert(allPlatformWallets.length === 13, `Platform wallet accounts count is 13 (got ${allPlatformWallets.length})`);

    const kuraimiAcc = allPlatformWallets.find(w => w.provider === 'KURAIMI');
    assert(kuraimiAcc !== undefined, 'Kuraimi platform account exists');
    assert(kuraimiAcc?.accountNumber === '123456789', 'Default Kuraimi account number matches');

    // Admin updates Kuraimi platform wallet number & details
    const updatedKuraimi = await remoteConfigService.updatePlatformWalletAccount('KURAIMI', {
      accountNumber: '777888999',
      phoneNumber: '777888999',
      holderName: 'منصة سوقناا - الإدارة المالية',
      instructionsAr: 'قم بالتحويل لحساب الإدارة المالية الجديد واذكر رقم طلبك',
      minDeposit: 1000,
      badge: 'فوري ومعتمد ⚡',
    }, { id: 'admin-user-1', email: 'finance-admin@souqnaa.ye' });

    assert(updatedKuraimi.accountNumber === '777888999', 'Kuraimi account number updated in PostgreSQL');
    assert(updatedKuraimi.holderName === 'منصة سوقناا - الإدارة المالية', 'Kuraimi holder name updated');
    assert(updatedKuraimi.minDeposit === 1000, 'Kuraimi min deposit updated');

    // Verify resolved config serves updated Kuraimi platform wallet
    const resolvedWithWallets = await remoteConfigService.getResolvedConfig();
    const resolvedKuraimi = resolvedWithWallets.platformWallets.find(w => w.provider === 'KURAIMI');
    assert(resolvedKuraimi?.accountNumber === '777888999', 'Resolved config serves updated Kuraimi account number');
    assert(resolvedKuraimi?.holderName === 'منصة سوقناا - الإدارة المالية', 'Resolved config serves updated Kuraimi holder name');

    // Verify audit log exists for platform wallet update
    const walletAudit = await prisma.featureFlagAuditLog.findFirst({
      where: { featureKey: 'platform_wallet_KURAIMI' },
      orderBy: { createdAt: 'desc' },
    });
    assert(walletAudit !== null, 'Audit log recorded for platform wallet update');
    assert(walletAudit?.action === 'UPDATE', 'Audit log action is UPDATE for platform wallet');

    // Channel filtering: CHECKOUT should exclude BANK_TRANSFER
    const checkoutWallets = await remoteConfigService.getPlatformWalletAccounts('CHECKOUT');
    assert(!checkoutWallets.some(w => w.provider === 'BANK_TRANSFER'), 'Checkout wallets exclude BANK_TRANSFER');
    assert(checkoutWallets.some(w => w.provider === 'KURAIMI'), 'Checkout wallets include KURAIMI');

    // Reset platform wallets back to default
    await remoteConfigService.resetPlatformWalletAccounts({ id: 'admin-user-1', email: 'admin@souqnaa.ye' });
    const resetWallets = await remoteConfigService.getPlatformWalletAccounts(undefined, true);
    const resetKuraimi = resetWallets.find(w => w.provider === 'KURAIMI');
    assert(resetKuraimi?.accountNumber === '123456789', 'Reset restored default Kuraimi account number');

  } catch (err) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    console.log(`\n========================================`);
    console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);
    await prisma.$disconnect();
    if (failed > 0) {
      process.exit(1);
    }
  }
}

runRemoteConfigTests();
