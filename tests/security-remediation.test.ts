import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createOAuthSessionKey, hasActiveSession } from '../src/utils/auth-session.util';
import { signSingleUseOAuthState, consumeSingleUseOAuthState } from '../src/utils/oauth-state.util';
import { requireProviderVerifiedPayment } from '../src/modules/payments/payment-confirmation.util';
import { buildScopedIdempotencyKey } from '../src/utils/idempotency-key.util';
import { fetchPublicMedia } from '../src/utils/remote-media-fetch.util';
import { UrlSecurityUtil, isPrivateOrReservedHost } from '../src/utils/url-security.util';
import { isRefundEvidenceParticipant, isSellerReportOwnedBy, isStoredObjectMatch } from '../src/utils/storage-access.util';
import { validatePresignFileSize } from '../src/utils/upload-policy.util';
import { rotateRefreshTokenAtomically } from '../src/utils/refresh-rotation.util';

async function run() {
  // VULN-001: opaque OAuth keys and one-use state prevent attacker-selected sessions and replay.
  const oauthKey = createOAuthSessionKey();
  assert.match(oauthKey, /^[a-f0-9]{64}$/);
  assert.notStrictEqual(oauthKey, createOAuthSessionKey());
  const authController = fs.readFileSync(path.join(__dirname, '../src/modules/auth/auth.controller.ts'), 'utf8');
  assert.match(authController, /const sessionKey = createOAuthSessionKey\(\)/);
  assert.doesNotMatch(authController, /req\.query\.session_key|req\.query\.sessionKey/);
  const statePayload = { sessionKey: oauthKey, role: 'CUSTOMER' as any, platform: 'android', provider: 'GOOGLE' };
  const state = signSingleUseOAuthState(statePayload, 'local-test-secret');
  const stateStore = new Map([[state, JSON.stringify(statePayload)]]);
  const consume = (key: string) => Promise.resolve(stateStore.get(key) || null).then((value) => {
    stateStore.delete(key);
    return value;
  });
  assert.deepStrictEqual(await consumeSingleUseOAuthState(state, 'local-test-secret', consume), statePayload);
  assert.strictEqual(await consumeSingleUseOAuthState(state, 'local-test-secret', consume), null, 'OAuth state can only be consumed once');

  // VULN-002: access tokens are valid only for the currently active session.
  assert.strictEqual(hasActiveSession('sid-1', 'sid-1'), true);
  assert.strictEqual(hasActiveSession('sid-1', 'sid-2'), false, 'logout/re-login invalidates the previous access session');
  assert.strictEqual(hasActiveSession(undefined, 'sid-1'), false);

  // VULN-003: direct payment confirmation remains denied until provider verification.
  for (const role of ['CUSTOMER', 'SELLER', 'ADMIN', 'SUPER_ADMIN']) {
    assert.throws(() => requireProviderVerifiedPayment(), (error: any) => error.code === 'PAYMENT_PROVIDER_VERIFICATION_REQUIRED', `${role} cannot self-confirm a payment`);
  }
  const adminRoutes = fs.readFileSync(path.join(__dirname, '../src/modules/admin/admin.routes.ts'), 'utf8');
  const rbacSource = fs.readFileSync(path.join(__dirname, '../src/modules/admin/admin-rbac.service.ts'), 'utf8');
  assert.match(adminRoutes, /verify-wallet', requirePermission\('finance:payments'\)/);
  assert.match(rbacSource, /\[SystemRole\.FINANCE_ADMIN\]: \[[\s\S]*?'finance:payments'/);
  assert.doesNotMatch(rbacSource.match(/\[SystemRole\.SELLER_ORDER_ADMIN\]: \[([\s\S]*?)\n  \],/)?.[1] || '', /finance:payments/);

  // VULN-004: idempotency keys are isolated by principal, method, and endpoint.
  const scoped = buildScopedIdempotencyKey('customer-a', 'POST', '/payments/o1/wallet-transfer', 'same-key');
  assert.strictEqual(scoped, buildScopedIdempotencyKey('customer-a', 'post', '/payments/o1/wallet-transfer', 'same-key'));
  assert.notStrictEqual(scoped, buildScopedIdempotencyKey('customer-b', 'POST', '/payments/o1/wallet-transfer', 'same-key'));
  assert.notStrictEqual(scoped, buildScopedIdempotencyKey('customer-a', 'POST', '/payments/o2/wallet-transfer', 'same-key'));

  // VULN-005/006: private/reserved addresses, redirect pivots, DNS rebinding, and oversized bodies are rejected.
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '192.0.2.4']) {
    assert.strictEqual(isPrivateOrReservedHost(host), true, `${host} is non-public`);
  }
  assert.strictEqual(UrlSecurityUtil.isSafeUrl('http://user:pass@example.com/a'), false);
  let requests = 0;
  await assert.rejects(fetchPublicMedia('https://public.example/start', 128, 500, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => { requests++; return { statusCode: 302, location: 'http://127.0.0.1/admin', body: Buffer.alloc(0) }; },
  }), (error: any) => error.code === 'SSRF_BLOCKED');
  assert.strictEqual(requests, 1, 'redirect target is validated before making a second request');
  let lookups = 0;
  requests = 0;
  await assert.rejects(fetchPublicMedia('https://rebind.example/start', 128, 500, {
    lookup: async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '10.0.0.8', family: 4 }],
    request: async () => { requests++; return { statusCode: 302, location: '/next', body: Buffer.alloc(0) }; },
  }), (error: any) => error.code === 'SSRF_BLOCKED');
  assert.strictEqual(requests, 1, 'DNS is re-resolved and revalidated on every redirect');
  await assert.rejects(fetchPublicMedia('https://public.example/large', 4, 500, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ statusCode: 200, body: Buffer.alloc(5) }),
  }), (error: any) => error.code === 'FILE_TOO_LARGE');
  const fetched = await fetchPublicMedia('https://public.example/image', 8, 500, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ statusCode: 200, contentType: 'image/png', body: Buffer.from([1, 2, 3]) }),
  });
  assert.strictEqual(fetched.body.length, 3, 'legitimate bounded public response remains available');

  // VULN-007: only the exact stored object can be matched to its private owner.
  assert.strictEqual(isStoredObjectMatch('https://assets.example/refunds/proof-1.png', 'refunds/proof-1.png'), true);
  assert.strictEqual(isStoredObjectMatch('https://assets.example/refunds/proof-10.png', 'refunds/proof-1.png'), false);
  assert.strictEqual(isStoredObjectMatch('/api/v1/storage/file/support/chat-1.jpg', 'support/chat-1.jpg'), true);
  assert.strictEqual(isSellerReportOwnedBy('seller-1', 'reports/seller-1/month.csv'), true);
  assert.strictEqual(isSellerReportOwnedBy('seller-1', 'reports/seller-2/month.csv'), false);
  assert.strictEqual(isRefundEvidenceParticipant('customer-1', 'customer-1', 'seller-1'), true);
  assert.strictEqual(isRefundEvidenceParticipant('seller-1', 'customer-1', 'seller-1'), true);
  assert.strictEqual(isRefundEvidenceParticipant('customer-2', 'customer-1', 'seller-1'), false);

  // VULN-008: presigning requires a bounded, positive, exact content length.
  assert.strictEqual(validatePresignFileSize(1024, 2048), 1024);
  for (const invalid of [undefined, null, 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePresignFileSize(invalid, 2048));
  }
  assert.throws(() => validatePresignFileSize(2049, 2048), (error: any) => error.code === 'FILE_TOO_LARGE');

  // VULN-009: simultaneous refresh attempts have one compare-and-set winner; replays fail.
  let storedRefresh = 'refresh-old';
  const cas = async (_key: string, expected: string, replacement: string) => {
    if (storedRefresh !== expected) return false;
    storedRefresh = replacement;
    return true;
  };
  const results = await Promise.all([
    rotateRefreshTokenAtomically(cas, 'user-1', 'refresh-old', 'refresh-next-a', 60),
    rotateRefreshTokenAtomically(cas, 'user-1', 'refresh-old', 'refresh-next-b', 60),
  ]);
  assert.deepStrictEqual(results.sort(), [false, true]);
  assert.strictEqual(await rotateRefreshTokenAtomically(cas, 'user-1', 'refresh-old', 'refresh-replay', 60), false);
  const redisSource = fs.readFileSync(path.join(__dirname, '../src/database/redis.ts'), 'utf8');
  assert.match(redisSource, /redis\.call\('GET', KEYS\[1\]\).*redis\.call\('SET', KEYS\[1\]/s);

  console.log('Security remediation regression tests passed (VULN-001 through VULN-009).');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
