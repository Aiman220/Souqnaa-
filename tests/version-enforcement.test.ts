/**
 * SOUQNA — AR-2.4: Backend Minimum App-Version Enforcement Test Suite
 * 
 * Verifies:
 * 1. Numeric version parsing & comparison
 * 2. Supported vs unsupported version enforcement (HTTP 426)
 * 3. Missing and malformed header policies
 * 4. App identity isolation (Role override prevents spoofing)
 * 5. Route exemptions (Health, lifecycle/config, public browsing, auth bootstrap)
 * 6. High-risk route protections (Orders, payments, wallet, refunds)
 * 7. Observe-only vs enforcing mode behavior
 */

import { parseAppVersion, compareAppVersions, isVersionSupported } from '../src/utils/version-comparator.util';
import {
  createAppVersionGate,
  resolveAppType,
  resolvePlatform,
  isExemptRoute,
} from '../src/middleware/app-version.middleware';
import { AppTypeEnum, AppPlatformEnum } from '@prisma/client';
import { Request, Response } from 'express';

async function runVersionEnforcementTests() {
  console.log('============================================================');
  console.log('🔒 SOUQNA AR-2.4 — MINIMUM VERSION ENFORCEMENT TESTS');
  console.log('============================================================\n');

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

  // ==========================================
  // [Scope 1] Numeric Version Comparison Utility
  // ==========================================
  console.log('[Scope 1] Testing Numeric Version Parsing & Comparison...');

  // Parsing
  assert(parseAppVersion('1.10.0')?.major === 1 && parseAppVersion('1.10.0')?.minor === 10, 'Parses standard semver (1.10.0)');
  assert(parseAppVersion('v2.3.4')?.patch === 4, 'Strips optional leading v (v2.3.4)');
  assert(parseAppVersion('1.5')?.patch === 0, 'Defaults omitted patch to 0 (1.5 -> 1.5.0)');
  assert(parseAppVersion('1.80.37+202610')?.build === 202610, 'Parses build number metadata (+202610)');
  assert(parseAppVersion('invalid') === null, 'Rejects non-numeric version string');
  assert(parseAppVersion('') === null, 'Rejects empty version string');
  assert(parseAppVersion(null) === null, 'Rejects null input');
  assert(parseAppVersion('1.2.3.4.5') === null, 'Rejects multiple dot segments');
  assert(parseAppVersion('a'.repeat(70)) === null, 'Rejects excessively long string (>64 chars)');

  // Component comparisons
  assert(compareAppVersions('1.10.0', '1.9.0') > 0, '1.10.0 is newer than 1.9.0 (numeric > lexicographical)');
  assert(compareAppVersions('1.2.0', '1.2.0') === 0, '1.2.0 equals 1.2.0');
  assert(compareAppVersions('1.1.9', '1.2.0') < 0, '1.1.9 is older than 1.2.0');
  assert(compareAppVersions('2.0.0', '1.99.99') > 0, '2.0.0 is newer than 1.99.99 (major dominates)');
  assert(compareAppVersions('1.5.1', '1.5.0') > 0, '1.5.1 is newer than 1.5.0 (patch dominates)');
  assert(compareAppVersions('1.0.0+200', '1.0.0+100') > 0, 'Higher build number dominates when semver is equal');
  assert(compareAppVersions('1.0.0', '1.0.0', 200, 100) > 0, 'Override build number dominates when semver is equal');

  // isVersionSupported
  assert(isVersionSupported('1.10.0', '1.9.0') === true, '1.10.0 satisfies minimum 1.9.0');
  assert(isVersionSupported('1.2.0', '1.2.0') === true, '1.2.0 satisfies minimum 1.2.0');
  assert(isVersionSupported('1.1.9', '1.2.0') === false, '1.1.9 fails minimum 1.2.0');
  assert(isVersionSupported('invalid', '1.2.0') === false, 'Invalid client version fails safely');

  // ==========================================
  // [Scope 2] App Identity Resolution & Isolation
  // ==========================================
  console.log('\n[Scope 2] Testing App Identity & Role Override Isolation...');

  const mockReqCustomer = {
    path: '/api/v1/orders',
    headers: { 'x-app-type': 'customer' },
  } as unknown as Request;
  assert(resolveAppType(mockReqCustomer) === AppTypeEnum.CUSTOMER, 'Resolves CUSTOMER from x-app-type header');

  const mockReqSellerSpoof = {
    path: '/api/v1/seller/orders',
    headers: { 'x-app-type': 'customer' }, // Client attempts to spoof customer
    user: { role: 'SELLER' },
  } as unknown as Request;
  assert(resolveAppType(mockReqSellerSpoof) === AppTypeEnum.SELLER, 'Role/Path overrides client spoofed x-app-type');

  const mockReqAdmin = {
    path: '/api/v1/admin/app/releases',
    headers: {},
    user: { role: 'ADMIN' },
  } as unknown as Request;
  assert(resolveAppType(mockReqAdmin) === AppTypeEnum.ADMIN, 'Resolves ADMIN from authenticated admin role and path');

  // Platform Resolution
  const mockReqIos = {
    headers: { 'x-app-platform': 'ios' },
  } as unknown as Request;
  assert(resolvePlatform(mockReqIos) === AppPlatformEnum.IOS, 'Resolves IOS from x-app-platform');

  const mockReqUaAndroid = {
    headers: { 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/UD1A.230803.041)' },
  } as unknown as Request;
  assert(resolvePlatform(mockReqUaAndroid) === AppPlatformEnum.ANDROID, 'Resolves ANDROID from User-Agent fallback');

  // ==========================================
  // [Scope 3] Route Exemptions
  // ==========================================
  console.log('\n[Scope 3] Testing Route Exemptions (Health, Config, Catalog, Auth)...');

  assert(isExemptRoute({ path: '/health', method: 'GET' } as Request), 'Exempts /health');
  assert(isExemptRoute({ path: '/ready', method: 'GET' } as Request), 'Exempts /ready');
  assert(isExemptRoute({ path: '/api/v1/app/config', method: 'GET' } as Request), 'Exempts /api/v1/app/config');
  assert(isExemptRoute({ path: '/api/v1/app/version-policy', method: 'GET' } as Request), 'Exempts /api/v1/app/version-policy');
  assert(isExemptRoute({ path: '/api/v1/config/remote', method: 'GET' } as Request), 'Exempts /api/v1/config/remote');
  assert(isExemptRoute({ path: '/api/v1/auth/login', method: 'POST' } as Request), 'Exempts auth bootstrap /api/v1/auth/login');
  assert(isExemptRoute({ path: '/api/v1/auth/refresh', method: 'POST' } as Request), 'Exempts auth bootstrap /api/v1/auth/refresh');
  assert(isExemptRoute({ path: '/api/v1/products', method: 'GET' } as Request), 'Exempts public catalog GET /api/v1/products');
  assert(!isExemptRoute({ path: '/api/v1/products', method: 'POST' } as Request), 'Does NOT exempt mutation POST /api/v1/products');
  assert(!isExemptRoute({ path: '/api/v1/orders', method: 'POST' } as Request), 'Does NOT exempt order creation POST /api/v1/orders');
  assert(!isExemptRoute({ path: '/api/v1/payments/123/confirm', method: 'POST' } as Request), 'Does NOT exempt payment confirm');

  // ==========================================
  // [Scope 4] Middleware Execution & Rejection Tests
  // ==========================================
  console.log('\n[Scope 4] Testing Middleware Enforcement & Responses...');

  // Helper to run middleware
  async function testGate(req: Partial<Request>, options: any = {}): Promise<{ status: number; body?: any; headers: Record<string, string>; nextCalled: boolean }> {
    const middleware = createAppVersionGate({
      enforcementMode: options.enforcementMode ?? 'enforcing',
      allowLegacyWithoutVersion: options.allowLegacyWithoutVersion ?? true,
      ...options,
    });

    let statusCode = 200;
    let responseBody: any = null;
    const responseHeaders: Record<string, string> = {};
    let nextCalled = false;

    const res: Partial<Response> = {
      status(code: number) {
        statusCode = code;
        return this as Response;
      },
      json(body: any) {
        responseBody = body;
        return this as Response;
      },
      setHeader(name: string, value: string) {
        responseHeaders[name.toLowerCase()] = value;
        return this as Response;
      },
    };

    await middleware(req as Request, res as Response, () => {
      nextCalled = true;
    });

    return { status: statusCode, body: responseBody, headers: responseHeaders, nextCalled };
  }

  // 1. Supported version passes
  const supportedResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-version': '1.80.37', 'x-app-type': 'customer' },
  });
  assert(supportedResult.nextCalled && supportedResult.status === 200, 'Supported version (1.80.37) passes to next()');
  assert(supportedResult.headers['x-app-version-status'] === 'supported', 'Sets X-App-Version-Status: supported');

  // 2. Outdated version rejected with HTTP 426
  const outdatedResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-version': '0.9.0', 'x-app-type': 'customer' },
  });
  assert(!outdatedResult.nextCalled, 'Outdated version does not call next()');
  assert(outdatedResult.status === 426, 'Outdated version returns HTTP 426 Upgrade Required');
  assert(outdatedResult.headers['upgrade'] === 'SOUQNA-App', 'Includes Upgrade: SOUQNA-App header');
  assert(outdatedResult.body?.error?.code === 'UPGRADE_REQUIRED', 'Returns UPGRADE_REQUIRED error code');
  assert(outdatedResult.body?.error?.forceUpdate === true, 'Returns forceUpdate: true');
  assert(outdatedResult.body?.error?.storeUrl?.includes('play.google.com') || outdatedResult.body?.error?.storeUrl?.includes('http'), 'Returns storeUrl');
  assert(outdatedResult.body?.error?.configUrl === '/api/v1/app/config', 'Returns reference configUrl');

  // 3. Missing version on legacy client (migration period)
  const legacyResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-type': 'customer' },
  }, { allowLegacyWithoutVersion: true });
  assert(legacyResult.nextCalled && legacyResult.status === 200, 'Missing version passes during legacy compatibility period');
  assert(legacyResult.headers['x-app-version-status'] === 'legacy-unversioned', 'Sets X-App-Version-Status: legacy-unversioned');

  // 4. Missing version when legacy is disabled
  const strictResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-type': 'customer' },
  }, { allowLegacyWithoutVersion: false });
  assert(!strictResult.nextCalled && strictResult.status === 400, 'Missing version returns HTTP 400 when legacy is disallowed');
  assert(strictResult.body?.error?.code === 'MISSING_APP_VERSION', 'Returns MISSING_APP_VERSION error code');

  // 5. Malformed version header
  const malformedResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-version': 'bad_version_string!#@', 'x-app-type': 'customer' },
  });
  assert(!malformedResult.nextCalled && malformedResult.status === 400, 'Malformed version returns HTTP 400');
  assert(malformedResult.body?.error?.code === 'INVALID_APP_VERSION', 'Returns INVALID_APP_VERSION error code');

  // 6. Observe-only mode
  const observeResult = await testGate({
    path: '/api/v1/orders',
    method: 'POST',
    headers: { 'x-app-version': '0.9.0', 'x-app-type': 'customer' },
  }, { enforcementMode: 'observe_only' });
  assert(observeResult.nextCalled && observeResult.status === 200, 'Observe-only mode does not block outdated client');
  assert(observeResult.headers['x-app-version-status'] === 'upgrade-required', 'Observe-only mode records upgrade-required header');

  // 7. Exempt route passes even with outdated version
  const exemptResult = await testGate({
    path: '/api/v1/app/config',
    method: 'GET',
    headers: { 'x-app-version': '0.1.0' },
  });
  assert(exemptResult.nextCalled && exemptResult.status === 200, 'Exempt update endpoint passes regardless of version');

  console.log('\n============================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('============================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runVersionEnforcementTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
