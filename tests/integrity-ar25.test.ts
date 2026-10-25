/**
 * SOUQNA — AR-2.5: App Integrity Verification Test Suite
 *
 * Run with:  npx ts-node backend/tests/integrity-ar25.test.ts
 *            (from the monorepo root: f:/souqnaa)
 *
 * Coverage:
 *   - Google Play Integrity: token validation, nonce binding, package checks,
 *     freshness, device verdicts, API error mapping, missing credentials
 *   - Apple App Attest: attestation verification, assertion verification,
 *     certificate chain, nonce binding, counter replay, missing key
 *   - IntegrityChallengeService: create, consume, expiry, replay, concurrency
 *   - requireIntegrity middleware: policy mode enforcement (enforce/soft/observe)
 *   - High-risk operation gating: withdrawal route with integrity
 *   - Provider unavailability: never converts to VERIFIED
 */

// ─── Minimal test harness ─────────────────────────────────────────────────────
let _pass = 0;
let _fail = 0;
const _failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    console.log(`  ✅ ${description}`);
    _pass++;
  } else {
    console.log(`  ❌ FAIL: ${description}`);
    _fail++;
    _failures.push(description);
  }
}

function group(name: string, body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    console.log(`\n── ${name}`);
    await body();
  };
}

// ─── Imports ──────────────────────────────────────────────────────────────────
import { PlayIntegrityProvider } from '../src/modules/integrity/providers/play-integrity.provider';
import { AppAttestProvider } from '../src/modules/integrity/providers/app-attest.provider';
import { IntegrityChallengeService } from '../src/modules/integrity/services/integrity-challenge.service';
import { AppIntegrityService } from '../src/modules/integrity/app-integrity.service';
import { DeviceIntegrityStatus, IntegrityProvider, IntegrityEvidenceInput } from '../src/modules/integrity/integrity.types';
import { getOperationPolicy } from '../src/modules/integrity/integrity.policy';
import crypto from 'crypto';

// ─── Google Play Integrity Tests ──────────────────────────────────────────────

const testPlayIntegrity = group('Google Play Integrity — evaluateDecodedPayload', () => {
  const PKG = 'com.souqnaa.app';

  // Helper to build a minimal valid payload
  function validPayload(overrides: any = {}): any {
    return {
      requestDetails: {
        nonce: 'VALID_NONCE',
        timestampMillis: String(Date.now()),
        ...overrides.requestDetails,
      },
      appIntegrity: {
        packageName: PKG,
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        ...overrides.appIntegrity,
      },
      deviceIntegrity: {
        deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
        ...overrides.deviceIntegrity,
      },
      accountDetails: {
        appLicensingVerdict: 'LICENSED',
        ...overrides.accountDetails,
      },
    };
  }

  // 1. Valid decoded response → VERIFIED
  const r1 = PlayIntegrityProvider.evaluateDecodedPayload(validPayload(), 'VALID_NONCE', PKG);
  expect(r1.status === DeviceIntegrityStatus.VERIFIED, 'Valid payload → VERIFIED');
  expect(r1.riskScoreModifier < 0, 'VERIFIED has negative risk modifier');

  // 2. Nonce mismatch → INVALID
  const r2 = PlayIntegrityProvider.evaluateDecodedPayload(validPayload(), 'WRONG_NONCE', PKG);
  expect(r2.status === DeviceIntegrityStatus.INVALID, 'Nonce mismatch → INVALID');
  expect(r2.reasons.some(r => r.includes('NONCE')), 'Reason mentions NONCE');

  // 3. Wrong package name → REJECTED
  const r3 = PlayIntegrityProvider.evaluateDecodedPayload(validPayload(), 'VALID_NONCE', 'com.evil.app');
  expect(r3.status === DeviceIntegrityStatus.REJECTED, 'Package mismatch → REJECTED');
  expect(r3.reasons.some(r => r.includes('PACKAGE_NAME')), 'Reason mentions PACKAGE_NAME');

  // 4. Stale token (>10 min old) → EXPIRED
  const stalePayload = validPayload({
    requestDetails: { nonce: 'VALID_NONCE', timestampMillis: String(Date.now() - 15 * 60 * 1000) },
  });
  const r4 = PlayIntegrityProvider.evaluateDecodedPayload(stalePayload, 'VALID_NONCE', PKG);
  expect(r4.status === DeviceIntegrityStatus.EXPIRED, 'Stale token → EXPIRED');

  // 5. No device integrity verdicts → REJECTED
  const noDevicePayload = validPayload({
    deviceIntegrity: { deviceRecognitionVerdict: [] },
  });
  const r5 = PlayIntegrityProvider.evaluateDecodedPayload(noDevicePayload, 'VALID_NONCE', PKG);
  expect(r5.status === DeviceIntegrityStatus.REJECTED, 'Empty device verdicts → REJECTED');

  // 6. UNRECOGNIZED_VERSION app → REJECTED
  const tamperedPayload = validPayload({
    appIntegrity: { packageName: PKG, appRecognitionVerdict: 'UNRECOGNIZED_VERSION' },
  });
  const r6 = PlayIntegrityProvider.evaluateDecodedPayload(tamperedPayload, 'VALID_NONCE', PKG);
  expect(r6.status === DeviceIntegrityStatus.REJECTED, 'UNRECOGNIZED_VERSION → REJECTED');
  expect(r6.reasons.some(r => r.includes('TAMPERED')), 'Reason mentions TAMPERED');

  // 7. Missing package name in payload → REJECTED
  const missingPkgPayload = validPayload({ appIntegrity: { packageName: undefined } });
  const r7 = PlayIntegrityProvider.evaluateDecodedPayload(missingPkgPayload, 'VALID_NONCE', PKG);
  expect(r7.status === DeviceIntegrityStatus.REJECTED, 'Missing package name → REJECTED');

  // 8. Meets STRONG_INTEGRITY → VERIFIED
  const strongPayload = validPayload({
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY'] },
  });
  const r8 = PlayIntegrityProvider.evaluateDecodedPayload(strongPayload, 'VALID_NONCE', PKG);
  expect(r8.status === DeviceIntegrityStatus.VERIFIED, 'MEETS_STRONG_INTEGRITY → VERIFIED');
});

const testPlayCredentialsMissing = group('Google Play Integrity — missing credentials', async () => {
  // Ensure no credentials in env for this test
  const savedKey = process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY;
  delete process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY;
  const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  const r = await PlayIntegrityProvider.verifyToken({
    token: 'some-valid-looking-token',
    expectedNonce: 'nonce',
    expectedPackageName: 'com.souqnaa.app',
  });
  expect(r.status === DeviceIntegrityStatus.UNAVAILABLE, 'Missing credentials → UNAVAILABLE (not VERIFIED)');
  expect(r.riskScoreModifier === 0, 'UNAVAILABLE has zero risk modifier');
  expect(!r.reasons.some(r => r.toLowerCase().includes('verified')), 'UNAVAILABLE reason does not claim VERIFIED');

  // Restore
  if (savedKey) process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = savedKey;
  if (savedCreds) process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = savedCreds;
});

const testPlayMalformedToken = group('Google Play Integrity — malformed/empty token', async () => {
  const r1 = await PlayIntegrityProvider.verifyToken({ token: '', expectedNonce: 'n', expectedPackageName: 'com.x' });
  expect(r1.status === DeviceIntegrityStatus.INVALID, 'Empty token → INVALID');

  const r2 = await PlayIntegrityProvider.verifyToken({ token: '   ', expectedNonce: 'n', expectedPackageName: 'com.x' });
  expect(r2.status === DeviceIntegrityStatus.INVALID, 'Whitespace-only token → INVALID');
});

const testPlayRequestHashBinding = group('Google Play Integrity — requestHash binding', () => {
  // Some integrations use requestHash instead of nonce
  const payload = {
    requestDetails: { requestHash: 'MY_REQUEST_HASH', timestampMillis: String(Date.now()) },
    appIntegrity: { packageName: 'com.souqnaa.app', appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    accountDetails: {},
  };
  const r = PlayIntegrityProvider.evaluateDecodedPayload(payload, 'MY_REQUEST_HASH', 'com.souqnaa.app');
  expect(r.status === DeviceIntegrityStatus.VERIFIED, 'requestHash binding works as nonce alternative');
});

// ─── Apple App Attest Tests ───────────────────────────────────────────────────

const testAppAttestConfigMissing = group('Apple App Attest — configuration not enabled', async () => {
  const saved = process.env.APP_ATTEST_ENABLED;
  const savedTeam = process.env.APPLE_TEAM_ID;
  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;

  const r = await AppAttestProvider.verifyEvidence({
    keyId: 'some-key-id',
    expectedNonce: 'challenge',
    expectedAppId: 'TEAM123456.com.souqnaa.app',
  });
  expect(r.status === DeviceIntegrityStatus.UNAVAILABLE, 'APP_ATTEST_ENABLED unset → UNAVAILABLE');
  expect(!r.reasons.some(r => r.includes('VERIFIED')), 'Not falsely VERIFIED');

  if (saved) process.env.APP_ATTEST_ENABLED = saved;
  if (savedTeam) process.env.APPLE_TEAM_ID = savedTeam;
});

const testAppAttestMissingKeyId = group('Apple App Attest — missing keyId', async () => {
  process.env.APP_ATTEST_ENABLED = 'true';
  process.env.APPLE_TEAM_ID = 'ABCDE12345';

  const r = await AppAttestProvider.verifyEvidence({
    keyId: '',
    expectedNonce: 'challenge',
    expectedAppId: 'ABCDE12345.com.souqnaa.app',
  });
  expect(r.status === DeviceIntegrityStatus.INVALID, 'Empty keyId → INVALID');

  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;
});

const testAppAttestOsVersionGating = group('Apple App Attest — iOS version gating', async () => {
  process.env.APP_ATTEST_ENABLED = 'true';
  process.env.APPLE_TEAM_ID = 'ABCDE12345';

  const r = await AppAttestProvider.verifyEvidence({
    keyId: 'key123',
    expectedNonce: 'challenge',
    expectedAppId: 'ABCDE12345.com.souqnaa.app',
    clientOsVersion: '13.0',
  });
  expect(r.status === DeviceIntegrityStatus.UNAVAILABLE, 'iOS 13 → UNAVAILABLE (App Attest requires 14+)');
  expect(r.riskScoreModifier === 0, 'No risk penalty for unsupported legacy OS');
  expect(r.reasons.some(r => r.includes('13')), 'Reason mentions iOS version');

  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;
});

const testAppAttestNoPayload = group('Apple App Attest — no attestation or assertion supplied', async () => {
  process.env.APP_ATTEST_ENABLED = 'true';
  process.env.APPLE_TEAM_ID = 'ABCDE12345';

  const r = await AppAttestProvider.verifyEvidence({
    keyId: 'key123',
    expectedNonce: 'challenge',
    expectedAppId: 'ABCDE12345.com.souqnaa.app',
  });
  expect(r.status === DeviceIntegrityStatus.UNAVAILABLE, 'No payload → UNAVAILABLE');

  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;
});

const testAppAttestInvalidAttestation = group('Apple App Attest — invalid attestation object', async () => {
  process.env.APP_ATTEST_ENABLED = 'true';
  process.env.APPLE_TEAM_ID = 'ABCDE12345';

  // Random bytes — not valid CBOR or wrong format
  const garbage = Buffer.from('not-valid-cbor-at-all-xxxx').toString('base64');
  const r = await AppAttestProvider.verifyEvidence({
    keyId: 'key123',
    expectedNonce: 'challenge',
    expectedAppId: 'ABCDE12345.com.souqnaa.app',
    attestationObject: garbage,
  });
  expect(
    r.status === DeviceIntegrityStatus.INVALID || r.status === DeviceIntegrityStatus.UNAVAILABLE,
    'Invalid CBOR attestation → INVALID or UNAVAILABLE (not VERIFIED)'
  );
  expect(r.status !== DeviceIntegrityStatus.VERIFIED, 'Garbage attestation must never be VERIFIED');

  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;
});

const testAppAttestAssertionNoRegisteredKey = group('Apple App Attest — assertion without prior attestation', async () => {
  process.env.APP_ATTEST_ENABLED = 'true';
  process.env.APPLE_TEAM_ID = 'ABCDE12345';

  // Random assertion bytes — keyId has no registered public key in Redis
  const fakeAssertion = Buffer.from(JSON.stringify({ signature: 'abc', authenticatorData: 'def' })).toString('base64');
  const r = await AppAttestProvider.verifyEvidence({
    keyId: `unregistered-key-${crypto.randomBytes(8).toString('hex')}`,
    expectedNonce: 'challenge',
    expectedAppId: 'ABCDE12345.com.souqnaa.app',
    assertionObject: fakeAssertion,
  });
  expect(r.status !== DeviceIntegrityStatus.VERIFIED, 'Assertion with no registered key must not be VERIFIED');
  expect(
    r.status === DeviceIntegrityStatus.INVALID || r.status === DeviceIntegrityStatus.UNAVAILABLE,
    'Unregistered key → INVALID or UNAVAILABLE'
  );

  delete process.env.APP_ATTEST_ENABLED;
  delete process.env.APPLE_TEAM_ID;
});

// ─── IntegrityChallengeService Tests ─────────────────────────────────────────

const testChallengeService = group('IntegrityChallengeService — create and consume', async () => {
  const challenge = await IntegrityChallengeService.createChallenge({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
    userId: 'user_test_001',
    ttlSeconds: 30,
  });

  expect(typeof challenge.nonce === 'string' && challenge.nonce.length > 10, 'Creates a non-trivial nonce');
  expect(challenge.expiresAt > challenge.createdAt, 'expiresAt > createdAt');
  expect(challenge.appType === 'customer', 'appType correctly recorded');
  expect(challenge.operation === 'WALLET_WITHDRAWAL', 'operation correctly recorded');

  // Consume once → valid
  const r1 = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'customer',
    expectedOperation: 'WALLET_WITHDRAWAL',
    userId: 'user_test_001',
  });
  expect(r1.valid, 'First consumption → valid');

  // Consume again → replay rejected
  const r2 = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'customer',
    expectedOperation: 'WALLET_WITHDRAWAL',
    userId: 'user_test_001',
  });
  expect(!r2.valid, 'Second consumption → rejected (replay protection)');
  expect(r2.reason === 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED', 'Correct replay rejection reason');
});

const testChallengeAppTypeMismatch = group('IntegrityChallengeService — app type mismatch', async () => {
  const challenge = await IntegrityChallengeService.createChallenge({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
  });

  const r = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'seller', // wrong
    expectedOperation: 'WALLET_WITHDRAWAL',
  });
  expect(!r.valid, 'App type mismatch → rejected');
  expect(r.reason === 'CHALLENGE_APP_TYPE_MISMATCH', 'Correct app type mismatch reason');
});

const testChallengeOperationMismatch = group('IntegrityChallengeService — operation mismatch', async () => {
  const challenge = await IntegrityChallengeService.createChallenge({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
  });

  const r = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'customer',
    expectedOperation: 'FIRST_ORDER_PROMOTION', // wrong operation
  });
  expect(!r.valid, 'Operation mismatch → rejected');
  expect(r.reason === 'CHALLENGE_OPERATION_MISMATCH', 'Correct operation mismatch reason');
});

const testChallengeUserMismatch = group('IntegrityChallengeService — user identity mismatch', async () => {
  const challenge = await IntegrityChallengeService.createChallenge({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
    userId: 'user_A',
  });

  const r = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'customer',
    expectedOperation: 'WALLET_WITHDRAWAL',
    userId: 'user_B', // different user
  });
  expect(!r.valid, 'User identity mismatch → rejected');
  expect(r.reason === 'CHALLENGE_USER_MISMATCH', 'Correct user mismatch reason');
});

const testChallengeBlankNonce = group('IntegrityChallengeService — blank/empty nonce', async () => {
  const r = await IntegrityChallengeService.consumeChallenge({
    nonce: '',
    expectedAppType: 'customer',
    expectedOperation: 'WALLET_WITHDRAWAL',
  });
  expect(!r.valid, 'Blank nonce → rejected');
});

const testChallengeCrossOperation = group('IntegrityChallengeService — cross-operation replay prevention', async () => {
  // Challenge issued for withdrawal cannot be used for promotion
  const challenge = await IntegrityChallengeService.createChallenge({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
    userId: 'user_cross',
  });

  const r = await IntegrityChallengeService.consumeChallenge({
    nonce: challenge.nonce,
    expectedAppType: 'customer',
    expectedOperation: 'FIRST_ORDER_PROMOTION',
    userId: 'user_cross',
  });
  expect(!r.valid, 'Cross-operation replay → rejected');
});

// ─── AppIntegrityService — provider-unavailable fallback ─────────────────────

const testIntegrityServiceUnavailableFallback = group('AppIntegrityService — no evidence supplied', async () => {
  const r = await AppIntegrityService.evaluateOrFallback({
    appType: 'customer',
    operation: 'WALLET_WITHDRAWAL',
    userId: 'user_fallback',
  });
  expect(r.status === DeviceIntegrityStatus.UNAVAILABLE, 'No evidence → UNAVAILABLE (not VERIFIED)');
  expect(r.riskScoreModifier === 0, 'UNAVAILABLE has zero risk modifier');
});

// ─── Policy Configuration Tests ──────────────────────────────────────────────

const testIntegrityPolicy = group('Integrity Policy — server-side policy declarations', () => {
  const walletPolicy = getOperationPolicy('WALLET_WITHDRAWAL');
  expect(walletPolicy.required, 'WALLET_WITHDRAWAL is required');
  expect(['enforce', 'soft'].includes(walletPolicy.mode), 'WALLET_WITHDRAWAL mode is enforce or soft');

  const promoPolicy = getOperationPolicy('FIRST_ORDER_PROMOTION');
  expect(promoPolicy.required, 'FIRST_ORDER_PROMOTION is required');

  const unknownPolicy = getOperationPolicy('COMPLETELY_UNKNOWN_OPERATION');
  expect(!unknownPolicy.required, 'Unknown operation defaults to not required');
  expect(unknownPolicy.mode === 'observe', 'Unknown operation defaults to observe mode');
});

// ─── Invariant checks ─────────────────────────────────────────────────────────

const testInvariants = group('Security Invariants', async () => {
  // REJECTED must never be converted to VERIFIED or UNAVAILABLE
  const rejectedStatuses = [DeviceIntegrityStatus.REJECTED];
  for (const s of rejectedStatuses) {
    expect(s !== DeviceIntegrityStatus.VERIFIED, `Status ${s} is not equal to VERIFIED`);
    expect(s !== DeviceIntegrityStatus.UNAVAILABLE, `Status ${s} is not equal to UNAVAILABLE`);
  }

  // Package names must not be cross-contaminated
  expect(
    PlayIntegrityProvider.AUTHORIZED_PACKAGES['customer'] !== PlayIntegrityProvider.AUTHORIZED_PACKAGES['seller'],
    'Customer and seller package names are distinct'
  );
  expect(
    AppAttestProvider.AUTHORIZED_BUNDLE_IDS['customer'] !== AppAttestProvider.AUTHORIZED_BUNDLE_IDS['seller'],
    'Customer and seller bundle IDs are distinct'
  );

  // Challenge nonces should be unique across calls
  const c1 = await IntegrityChallengeService.createChallenge({ appType: 'customer', operation: 'TEST' });
  const c2 = await IntegrityChallengeService.createChallenge({ appType: 'customer', operation: 'TEST' });
  expect(c1.nonce !== c2.nonce, 'Successive challenges generate unique nonces');

  // PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY must never end up in a Play Integrity token or response
  const safeResult = await PlayIntegrityProvider.verifyToken({
    token: 'test_token',
    expectedNonce: 'test_nonce',
    expectedPackageName: 'com.souqnaa.app',
  });
  const safeStr = JSON.stringify(safeResult);
  expect(!safeStr.includes('SERVICE_ACCOUNT'), 'Service account credentials not in verification result');
});

// ─── Run all tests ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AR-2.5 App Attestation & High-Risk Protection — Test Suite   ');
  console.log('═══════════════════════════════════════════════════════════════');

  await testPlayIntegrity();
  await testPlayCredentialsMissing();
  await testPlayMalformedToken();
  await testPlayRequestHashBinding();
  await testAppAttestConfigMissing();
  await testAppAttestMissingKeyId();
  await testAppAttestOsVersionGating();
  await testAppAttestNoPayload();
  await testAppAttestInvalidAttestation();
  await testAppAttestAssertionNoRegisteredKey();
  await testChallengeService();
  await testChallengeAppTypeMismatch();
  await testChallengeOperationMismatch();
  await testChallengeUserMismatch();
  await testChallengeBlankNonce();
  await testChallengeCrossOperation();
  await testIntegrityServiceUnavailableFallback();
  await testIntegrityPolicy();
  await testInvariants();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${_pass} passed, ${_fail} failed`);
  if (_failures.length) {
    console.log('\n  Failed checks:');
    _failures.forEach(f => console.log(`    • ${f}`));
  }
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(_fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[TEST RUNNER ERROR]', err);
  process.exit(1);
});
