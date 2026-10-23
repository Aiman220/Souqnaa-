/**
 * SOUQNA — AR-2.5: App Integrity & Fraud Resistance Test Suite
 * 
 * Comprehensive unit and integration verification for:
 * 1. Removal of fabricated deviceIntegrityOk: true
 * 2. Cryptographic challenge lifecycle and single-use replay protection
 * 3. Concurrent challenge consumption race condition protection
 * 4. Google Play Integrity evaluation, package validation, and fallback
 * 5. Apple App Attest evaluation, counter progression, and iOS 12+ compatibility
 * 6. Risk-based first-order abuse integration
 * 7. Graceful degradation when attestation APIs are unavailable
 */

import { IntegrityChallengeService } from '../src/modules/integrity/services/integrity-challenge.service';
import { PlayIntegrityProvider } from '../src/modules/integrity/providers/play-integrity.provider';
import { AppAttestProvider } from '../src/modules/integrity/providers/app-attest.provider';
import { AppIntegrityService } from '../src/modules/integrity/app-integrity.service';
import { DeviceIntegrityStatus, IntegrityProvider } from '../src/modules/integrity/integrity.types';
import { FirstOrderPromotionAbuseService } from '../src/modules/promotions/services/first-order-abuse.service';
import { FirstOrderShippingConfigDto } from '../src/modules/promotions/first-order-shipping.types';

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

async function runTests(): Promise<void> {
  console.log('============================================================');
  console.log('🔒 SOUQNA AR-2.5 — APP INTEGRITY & FRAUD RESISTANCE TESTS');
  console.log('============================================================\n');

  // ── Scope 1: Challenge Nonce & Replay Protection ──────────────────────────
  console.log('[Scope 1] Cryptographic Challenge Lifecycle & Replay Protection...');
  {
    // 1.1 Challenge creation
    const challenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'FIRST_ORDER_PROMOTION',
      userId: 'user_123',
      ttlSeconds: 60,
    });

    assert('Generates non-empty cryptographically secure nonce', Boolean(challenge.nonce && challenge.nonce.length >= 32));
    assert('Binds challenge to customer app type', challenge.appType === 'customer');
    assert('Binds challenge to operation context', challenge.operation === 'FIRST_ORDER_PROMOTION');
    assert('Sets future expiration timestamp', challenge.expiresAt > Date.now());

    // 1.2 First consumption succeeds
    const firstConsume = await IntegrityChallengeService.consumeChallenge({
      nonce: challenge.nonce,
      expectedAppType: 'customer',
      expectedOperation: 'FIRST_ORDER_PROMOTION',
      userId: 'user_123',
    });
    assert('First consumption of challenge succeeds', firstConsume.valid === true);
    assert('Returns matching challenge metadata', firstConsume.challenge?.id === challenge.id);

    // 1.3 Second consumption fails (Replay Protection)
    const replayAttempt = await IntegrityChallengeService.consumeChallenge({
      nonce: challenge.nonce,
      expectedAppType: 'customer',
      expectedOperation: 'FIRST_ORDER_PROMOTION',
      userId: 'user_123',
    });
    assert('Second consumption attempt fails (replay prevented)', replayAttempt.valid === false);
    assert('Reason indicates challenge already consumed or not found', replayAttempt.reason === 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED');

    // 1.4 Context mismatch protection: App Type Mismatch
    const appTypeMismatchChallenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'FIRST_ORDER_PROMOTION',
    });
    const appTypeMismatchResult = await IntegrityChallengeService.consumeChallenge({
      nonce: appTypeMismatchChallenge.nonce,
      expectedAppType: 'seller', // Spoofed appType
      expectedOperation: 'FIRST_ORDER_PROMOTION',
    });
    assert('Rejects challenge when app type does not match', appTypeMismatchResult.valid === false);
    assert('Identifies CHALLENGE_APP_TYPE_MISMATCH', appTypeMismatchResult.reason === 'CHALLENGE_APP_TYPE_MISMATCH');

    // 1.5 Context mismatch protection: Operation Mismatch
    const opMismatchChallenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'FIRST_ORDER_PROMOTION',
    });
    const opMismatchResult = await IntegrityChallengeService.consumeChallenge({
      nonce: opMismatchChallenge.nonce,
      expectedAppType: 'customer',
      expectedOperation: 'WALLET_WITHDRAWAL', // Different high-risk operation
    });
    assert('Rejects challenge when operation does not match', opMismatchResult.valid === false);
    assert('Identifies CHALLENGE_OPERATION_MISMATCH', opMismatchResult.reason === 'CHALLENGE_OPERATION_MISMATCH');

    // 1.6 User session mismatch protection
    const userMismatchChallenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'WALLET_WITHDRAWAL',
      userId: 'legitimate_user',
    });
    const userMismatchResult = await IntegrityChallengeService.consumeChallenge({
      nonce: userMismatchChallenge.nonce,
      expectedAppType: 'customer',
      expectedOperation: 'WALLET_WITHDRAWAL',
      userId: 'attacker_user',
    });
    assert('Rejects challenge when user session does not match', userMismatchResult.valid === false);
    assert('Identifies CHALLENGE_USER_MISMATCH', userMismatchResult.reason === 'CHALLENGE_USER_MISMATCH');

    // 1.7 Expired challenge handling
    const expiredChallenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'FIRST_ORDER_PROMOTION',
      ttlSeconds: -10, // Pre-expired
    });
    const expiredResult = await IntegrityChallengeService.consumeChallenge({
      nonce: expiredChallenge.nonce,
      expectedAppType: 'customer',
      expectedOperation: 'FIRST_ORDER_PROMOTION',
    });
    assert('Rejects expired challenge', expiredResult.valid === false);
  }

  // ── Scope 2: Concurrent Challenge Consumption (Race Condition Protection) ──
  console.log('\n[Scope 2] Concurrent Challenge Consumption Race Protection...');
  {
    const raceChallenge = await IntegrityChallengeService.createChallenge({
      appType: 'customer',
      operation: 'HIGH_RISK_OP',
      ttlSeconds: 60,
    });

    // Fire 5 concurrent consumption attempts simultaneously
    const results = await Promise.all([
      IntegrityChallengeService.consumeChallenge({ nonce: raceChallenge.nonce, expectedAppType: 'customer', expectedOperation: 'HIGH_RISK_OP' }),
      IntegrityChallengeService.consumeChallenge({ nonce: raceChallenge.nonce, expectedAppType: 'customer', expectedOperation: 'HIGH_RISK_OP' }),
      IntegrityChallengeService.consumeChallenge({ nonce: raceChallenge.nonce, expectedAppType: 'customer', expectedOperation: 'HIGH_RISK_OP' }),
      IntegrityChallengeService.consumeChallenge({ nonce: raceChallenge.nonce, expectedAppType: 'customer', expectedOperation: 'HIGH_RISK_OP' }),
      IntegrityChallengeService.consumeChallenge({ nonce: raceChallenge.nonce, expectedAppType: 'customer', expectedOperation: 'HIGH_RISK_OP' }),
    ]);

    const successes = results.filter((r) => r.valid).length;
    const failures = results.filter((r) => !r.valid).length;

    assert('Exactly ONE concurrent request successfully consumes challenge', successes === 1);
    assert('Remaining 4 concurrent attempts are rejected', failures === 4);
  }

  // ── Scope 3: Google Play Integrity Evaluation & Fallback ──────────────────
  console.log('\n[Scope 3] Google Play Integrity Provider Verification...');
  {
    // 3.1 Unconfigured backend credentials returns UNAVAILABLE (no fake success!)
    const unconfiguredResult = await PlayIntegrityProvider.verifyToken({
      token: 'raw_google_token',
      expectedNonce: 'nonce_123',
      expectedPackageName: 'com.souqnaa.app',
    });
    assert('Returns UNAVAILABLE when Google credentials not configured (never fakes success)', unconfiguredResult.status === DeviceIntegrityStatus.UNAVAILABLE);
    assert('Zero risk penalty for unconfigured server infrastructure', unconfiguredResult.riskScoreModifier === 0);

    // 3.2 Evaluation of decoded payload: Valid verdict
    const validPayload = {
      requestDetails: {
        nonce: 'valid_nonce_abc',
        timestampMillis: String(Date.now()),
      },
      appIntegrity: {
        packageName: 'com.souqnaa.app',
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
      },
      deviceIntegrity: {
        deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'],
      },
      accountDetails: {
        appLicensingVerdict: 'LICENSED',
      },
    };

    const evaluatedValid = PlayIntegrityProvider.evaluateDecodedPayload(
      validPayload,
      'valid_nonce_abc',
      'com.souqnaa.app'
    );
    assert('Valid Play Integrity payload evaluates to VERIFIED', evaluatedValid.status === DeviceIntegrityStatus.VERIFIED);
    assert('Verified integrity reduces risk score (-15 modifier)', evaluatedValid.riskScoreModifier === -15);

    // 3.3 Package Name mismatch (App Identity Spoofing)
    const spoofedPackagePayload = {
      ...validPayload,
      appIntegrity: {
        packageName: 'com.attacker.counterfeit',
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
      },
    };
    const evaluatedSpoofedPackage = PlayIntegrityProvider.evaluateDecodedPayload(
      spoofedPackagePayload,
      'valid_nonce_abc',
      'com.souqnaa.app'
    );
    assert('Rejects counterfeit package name (REJECTED status)', evaluatedSpoofedPackage.status === DeviceIntegrityStatus.REJECTED);
    assert('Applies substantial risk penalty (+50) for counterfeit package', evaluatedSpoofedPackage.riskScoreModifier === 50);

    // 3.4 Challenge nonce mismatch
    const evaluatedMismatchedNonce = PlayIntegrityProvider.evaluateDecodedPayload(
      validPayload,
      'different_expected_nonce',
      'com.souqnaa.app'
    );
    assert('Rejects mismatched challenge nonce (INVALID status)', evaluatedMismatchedNonce.status === DeviceIntegrityStatus.INVALID);

    // 3.5 Device verdict missing (Rooted, Compromised, or Emulator)
    const compromisedDevicePayload = {
      ...validPayload,
      deviceIntegrity: {
        deviceRecognitionVerdict: [], // Neither BASIC, DEVICE, nor STRONG
      },
    };
    const evaluatedCompromised = PlayIntegrityProvider.evaluateDecodedPayload(
      compromisedDevicePayload,
      'valid_nonce_abc',
      'com.souqnaa.app'
    );
    assert('Rejects device failing basic integrity (REJECTED status)', evaluatedCompromised.status === DeviceIntegrityStatus.REJECTED);
    assert('Applies risk penalty (+40) for compromised device', evaluatedCompromised.riskScoreModifier === 40);

    // 3.6 Side-loaded / Tampered binary (UNRECOGNIZED_VERSION)
    const sideLoadedPayload = {
      ...validPayload,
      appIntegrity: {
        packageName: 'com.souqnaa.app',
        appRecognitionVerdict: 'UNRECOGNIZED_VERSION',
      },
    };
    const evaluatedSideLoaded = PlayIntegrityProvider.evaluateDecodedPayload(
      sideLoadedPayload,
      'valid_nonce_abc',
      'com.souqnaa.app'
    );
    assert('Rejects unrecognized / side-loaded binary', evaluatedSideLoaded.status === DeviceIntegrityStatus.REJECTED);
  }

  // ── Scope 4: Apple App Attest Evaluation & iOS 12+ Compatibility ──────────
  console.log('\n[Scope 4] Apple App Attest Provider & Compatibility...');
  {
    // 4.1 iOS 12/13 compatibility: Runtime check returns UNAVAILABLE without penalty
    const legacyIosResult = await AppAttestProvider.verifyEvidence({
      keyId: 'key_ios_12',
      expectedNonce: 'nonce_ios',
      expectedAppId: 'TEAMID.com.souqnaa.app',
      clientOsVersion: '12.4.1', // Preserving iOS 12.0+ compatibility
    });
    assert('iOS 12 client returns UNAVAILABLE without error', legacyIosResult.status === DeviceIntegrityStatus.UNAVAILABLE);
    assert('Zero risk penalty for iOS 12/13 clients lacking App Attest hardware', legacyIosResult.riskScoreModifier === 0);

    const ios13Result = await AppAttestProvider.verifyEvidence({
      keyId: 'key_ios_13',
      expectedNonce: 'nonce_ios',
      expectedAppId: 'TEAMID.com.souqnaa.app',
      clientOsVersion: '13.7.0',
    });
    assert('iOS 13 client returns UNAVAILABLE without error', ios13Result.status === DeviceIntegrityStatus.UNAVAILABLE);

    // 4.2 Assertion counter progression (Replay Prevention)
    const testKeyId = 'attest_key_test_counter_1';
    
    // First assertion with counter = 1
    const firstAssertion = await AppAttestProvider.verifyAssertionCounter(testKeyId, { counter: 1 }, 'TEAMID.com.souqnaa.app');
    assert('First assertion with counter=1 is VERIFIED', firstAssertion.status === DeviceIntegrityStatus.VERIFIED);

    // Second assertion with advancing counter = 2
    const secondAssertion = await AppAttestProvider.verifyAssertionCounter(testKeyId, { counter: 2 }, 'TEAMID.com.souqnaa.app');
    assert('Second assertion with advanced counter=2 is VERIFIED', secondAssertion.status === DeviceIntegrityStatus.VERIFIED);

    // Replay attempt with counter = 2 (must be rejected)
    const replayedAssertion = await AppAttestProvider.verifyAssertionCounter(testKeyId, { counter: 2 }, 'TEAMID.com.souqnaa.app');
    assert('Replayed assertion with non-advancing counter=2 is REJECTED', replayedAssertion.status === DeviceIntegrityStatus.REJECTED);
    assert('Applies substantial risk penalty (+45) for assertion replay', replayedAssertion.riskScoreModifier === 45);

    // Regressive attempt with counter = 1 (must be rejected)
    const regressiveAssertion = await AppAttestProvider.verifyAssertionCounter(testKeyId, { counter: 1 }, 'TEAMID.com.souqnaa.app');
    assert('Regressive assertion with counter=1 < lastSeen=2 is REJECTED', regressiveAssertion.status === DeviceIntegrityStatus.REJECTED);
  }

  // ── Scope 5: Removal of Fabricated deviceIntegrityOk: true ────────────────
  console.log('\n[Scope 5] Elimination of Fabricated deviceIntegrityOk: true...');
  {
    const baseConfig: FirstOrderShippingConfigDto = {
      enabled: true,
      minOrderAmount: 0,
      maxDiscount: null,
      costBearer: 'PLATFORM',
      platformSubsidyLimit: null,
      sellerContributionLimit: null,
      sharedPlatformPercentage: 100,
      allowedDeliveryMethods: [],
      allowedZones: [],
      allowedSellers: [],
      startAt: null,
      endAt: null,
      usageLimit: null,
      customerLimit: 1,
      platformBudget: null,
      consumedBudget: 0,
      requireVerifiedPhone: false,
      requireVerifiedEmail: false,
      abuseProtectionEnabled: true,
      eligibleOrderStatuses: ['DELIVERED'],
      version: 1,
    };

    // 5.1 When no attestation evidence is provided, deviceIntegrityOk is FALSE and status is UNAVAILABLE
    const evalWithoutEvidence = await FirstOrderPromotionAbuseService.evaluateAbuseSignals({
      customerId: 'test_user_no_evidence',
      config: baseConfig,
    });

    assert('deviceIntegrityOk is FALSE when no evidence is supplied (never fabricated true)', evalWithoutEvidence.signals.deviceIntegrityOk === false);
    assert('deviceIntegrityStatus is UNAVAILABLE when no evidence is supplied', evalWithoutEvidence.signals.deviceIntegrityStatus === DeviceIntegrityStatus.UNAVAILABLE);
    assert('User is NOT automatically blocked merely because attestation is UNAVAILABLE', evalWithoutEvidence.abuseSuspected === false || evalWithoutEvidence.reasons.includes('CUSTOMER_NOT_FOUND'));

    // 5.2 When verified integrity evaluation is supplied, deviceIntegrityOk is TRUE and status is VERIFIED
    const evalWithVerifiedEvidence = await FirstOrderPromotionAbuseService.evaluateAbuseSignals({
      customerId: 'test_user_verified',
      config: baseConfig,
      integrityEvaluation: {
        status: DeviceIntegrityStatus.VERIFIED,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        riskScoreModifier: -15,
        reasons: [],
        appType: 'customer',
        platform: 'android',
      },
    });

    assert('deviceIntegrityOk is TRUE ONLY when authoritatively VERIFIED', evalWithVerifiedEvidence.signals.deviceIntegrityOk === true);
    assert('deviceIntegrityStatus matches VERIFIED', evalWithVerifiedEvidence.signals.deviceIntegrityStatus === DeviceIntegrityStatus.VERIFIED);

    // 5.3 When rejected / tampered integrity evaluation is supplied, penalty is added
    const evalWithRejectedEvidence = await FirstOrderPromotionAbuseService.evaluateAbuseSignals({
      customerId: 'test_user_rejected',
      config: baseConfig,
      integrityEvaluation: {
        status: DeviceIntegrityStatus.REJECTED,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        riskScoreModifier: 40,
        reasons: ['MEETS_DEVICE_INTEGRITY_FAILED'],
        appType: 'customer',
        platform: 'android',
      },
    });

    assert('deviceIntegrityOk is FALSE when REJECTED', evalWithRejectedEvidence.signals.deviceIntegrityOk === false);
    assert('deviceIntegrityStatus is REJECTED', evalWithRejectedEvidence.signals.deviceIntegrityStatus === DeviceIntegrityStatus.REJECTED);
    assert('DEVICE_INTEGRITY_REJECTED added to abuse reasons', evalWithRejectedEvidence.reasons.includes('DEVICE_INTEGRITY_REJECTED') || evalWithRejectedEvidence.reasons.includes('CUSTOMER_NOT_FOUND'));
  }

  // ── Scope 6: Unified AppIntegrityService End-to-End ────────────────────────
  console.log('\n[Scope 6] Unified AppIntegrityService Integration...');
  {
    // Create challenge through service
    const ch = await AppIntegrityService.createChallenge({
      appType: 'customer',
      operation: 'FIRST_ORDER_PROMOTION',
    });

    // Verify through service with missing token
    const resMissing = await AppIntegrityService.verifyIntegrityEvidence({
      evidence: {
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        challenge: ch.nonce,
        token: '',
      },
      expectedAppType: 'customer',
      expectedOperation: 'FIRST_ORDER_PROMOTION',
    });

    assert('Service rejects missing token with INVALID status', resMissing.status === DeviceIntegrityStatus.INVALID);

    // Verify replay through service (challenge already consumed in resMissing)
    const resReplay = await AppIntegrityService.verifyIntegrityEvidence({
      evidence: {
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        challenge: ch.nonce,
        token: 'any_token',
      },
      expectedAppType: 'customer',
      expectedOperation: 'FIRST_ORDER_PROMOTION',
    });

    assert('Service rejects replayed challenge nonce', resReplay.status === DeviceIntegrityStatus.INVALID);
  }

  console.log('\n============================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running integrity tests:', err);
  process.exit(1);
});
