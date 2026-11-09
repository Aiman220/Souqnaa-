import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createOAuthSessionKey, hasActiveSession } from '../src/utils/auth-session.util';
import { signSingleUseOAuthState, consumeSingleUseOAuthState } from '../src/utils/oauth-state.util';
import { requireProviderVerifiedPayment } from '../src/modules/payments/payment-confirmation.util';
import { buildScopedIdempotencyKey } from '../src/utils/idempotency-key.util';
import { fetchPublicMedia } from '../src/utils/remote-media-fetch.util';
import { UrlSecurityUtil, isPrivateOrReservedHost } from '../src/utils/url-security.util';
import {
  hasAdminPrivateStoragePermission,
  isRefundEvidenceParticipant,
  isSellerReportOwnedBy,
  isStoredObjectMatch,
} from '../src/utils/storage-access.util';
import { assertUploadFolderRole, validatePresignFileSize } from '../src/utils/upload-policy.util';
import { rotateRefreshTokenAtomically } from '../src/utils/refresh-rotation.util';
import { resolveRefundAmount } from '../src/modules/admin/refund-amount.policy';
import { resolveCustomerDepositApprovalAmount } from '../src/modules/admin/deposit-approval.policy';
import { selectAdminIdsWithPermission } from '../src/modules/admin/admin-rbac-policy';

function expectPolicyError(action: () => unknown, code: string): void {
  assert.throws(action, (error: any) => error?.code === code);
}

function remediationSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', 'src', relativePath), 'utf8');
}

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

  // F-01: privileged events use authorization-aware or user-scoped emitters.
  const walletRoutes = remediationSource('modules/wallet/customer-wallet.routes.ts');
  const adminRoutesSource = remediationSource('modules/admin/admin.routes.ts');
  const sellerRoutes = remediationSource('modules/sellers/seller.routes.ts');
  const orderRoutes = remediationSource('modules/orders/order.routes.ts');
  const refundService = remediationSource('modules/refunds/services/refund.service.ts');
  const disputeService = remediationSource('modules/disputes/dispute.service.ts');
  const financeSources = `${walletRoutes}\n${adminRoutesSource}\n${sellerRoutes}\n${orderRoutes}\n${refundService}\n${disputeService}`;
  assert.match(financeSources, /emitToAdminsWithPermission/);
  assert.doesNotMatch(financeSources, /emitGlobal\(['"](?:admin:customer_withdrawal_created|customer:withdrawal_updated|customer:deposit_created|deposit:created|admin:deposit_created|admin:withdrawal_created|withdrawal:created|REFUND_COMPLETED|refund:completed)['"]/);

  // F-02: admin event recipients fail closed when permission is absent.
  const permissionSets = new Map<string, ReadonlySet<string>>([
    ['finance', new Set(['finance:view', 'finance:payments'])],
    ['support', new Set(['support:view'])],
  ]);
  assert.deepStrictEqual(
    selectAdminIdsWithPermission(['finance', 'support', 'unassigned'], permissionSets, 'finance:payments', ['unassigned']),
    ['finance', 'unassigned']
  );
  assert.match(adminRoutesSource, /router\.post\('\/payments\/:orderId\/reject-wallet', requirePermission\('finance:payments'\)/);
  assert.match(adminRoutesSource, /router\.post\('\/customer-withdrawals\/:id\/complete', requirePermission\('finance:withdrawals'\)/);

  // SOQ-SEC-002: general settings require the explicit settings permission.
  assert.match(adminRoutesSource, /router\.put\('\/settings', requirePermission\('settings:manage'\)/);

  // SOQ-SEC-003: wallet withdrawal status and balances use conditional database transitions.
  const walletServiceSource = remediationSource('modules/wallet/customer-wallet.service.ts');
  assert.match(walletServiceSource, /customerWalletWithdrawal\.updateMany\(\{\s*where:\s*\{\s*id:\s*withdrawalId,\s*status:\s*\{\s*in:\s*\['PENDING', 'APPROVED'\]\s*\}\s*\}/);
  assert.ok(walletServiceSource.includes('"availableBalance" >= ${wr.amount}'));
  assert.ok(walletServiceSource.includes('"pendingBalance" >= ${wr.amount}'));
  assert.ok(walletServiceSource.includes('("availableBalance" - "pendingBalance") >= ${amount}'));

  // SOQ-SEC-004: private storage access for admins is scoped by existing RBAC permissions.
  assert.strictEqual(hasAdminPrivateStoragePermission(new Set(['support:view']), 'chat/thread-1/file.png'), true);
  assert.strictEqual(hasAdminPrivateStoragePermission(new Set(['support:view']), 'finance_proofs/proof-1.png'), false);
  assert.strictEqual(hasAdminPrivateStoragePermission(new Set(['finance:view']), 'finance_proofs/proof-1.png'), true);
  assert.strictEqual(hasAdminPrivateStoragePermission(new Set(), 'documents/seller-id.png'), false);

  // SOQ-SEC-005: customer deposit approval cannot mint funds beyond the submitted deposit.
  assert.strictEqual(resolveCustomerDepositApprovalAmount(500, undefined), 500);
  assert.strictEqual(resolveCustomerDepositApprovalAmount(500, '250'), 250);
  for (const invalid of [-1, 0, 'Infinity', '500.01', '250xyz']) {
    expectPolicyError(() => resolveCustomerDepositApprovalAmount(500, invalid), 'INVALID_APPROVED_DEPOSIT_AMOUNT');
  }

  // F-03: support, order, and dispute room access uses the existing permission model.
  const socketSource = remediationSource('services/websocket/socket.service.ts');
  assert.ok(socketSource.includes("adminPermissions.has('support:view') || adminPermissions.has('support:manage')"));
  assert.ok(socketSource.includes("this.adminHasAnyPermission(userId, ['orders:view'])"));
  assert.ok(socketSource.includes("this.adminHasAnyPermission(userId, ['disputes:resolve'])"));
  assert.ok(socketSource.includes("permissions.has('support:manage')"));
  assert.ok(socketSource.includes("socket.join('room:support_queue')"));
  assert.ok(socketSource.includes("event === 'support:queue:updated'"));

  // F-04: refunds are positive, finite, and capped to the remaining captured amount.
  assert.strictEqual(resolveRefundAmount(undefined, 125, 25), 100);
  assert.strictEqual(resolveRefundAmount('12.50', 125, 25), 12.5);
  for (const invalid of [0, -1, 'nope', Number.POSITIVE_INFINITY, 101]) {
    expectPolicyError(() => resolveRefundAmount(invalid, 125, 25), invalid === 101 ? 'REFUND_AMOUNT_EXCEEDS_REMAINING' : 'INVALID_REFUND_AMOUNT');
  }
  assert.ok(adminRoutesSource.includes('FOR UPDATE') && adminRoutesSource.includes('REFUND_ALREADY_PROCESSED'));

  // F-05: Redis TLS verifies certificates in both connection modes.
  const redisTlsSource = remediationSource('database/redis.ts');
  assert.strictEqual((redisTlsSource.match(/rejectUnauthorized: true/g) || []).length, 2);
  assert.ok(!redisTlsSource.includes('rejectUnauthorized: false'));

  // F-06: password reset invalidates access, refresh, and live socket state.
  const authSource = remediationSource('modules/auth/auth.controller.ts');
  assert.ok(authSource.includes('redis.del(`active_session:${updatedUser.id}`)'));
  assert.ok(authSource.includes('redis.del(`refresh:${updatedUser.id}`)'));
  assert.ok(authSource.includes('disconnectUser(updatedUser.id)'));

  // F-07: every upload entry point shares role-to-folder authorization.
  assertUploadFolderRole('SELLER', 'products');
  assertUploadFolderRole('CUSTOMER', 'general');
  expectPolicyError(() => assertUploadFolderRole('CUSTOMER', 'products'), 'FORBIDDEN_FOLDER');
  expectPolicyError(() => assertUploadFolderRole('SELLER', 'branding'), 'FORBIDDEN_FOLDER');
  const uploadSource = remediationSource('modules/upload/upload.routes.ts');
  assert.ok((uploadSource.match(/assertUploadFolderRole\(/g) || []).length >= 4);

  // F-08: reactions require stored-conversation membership and use its canonical ID.
  assert.ok(socketSource.includes('conversationId_userId: { conversationId: msg.conversationId, userId }'));
  assert.ok(socketSource.includes('const targetConvId = msg.conversationId;'));

  // SOQ-SEC-001: production cannot use the log SMS provider or claim a failed OTP was delivered.
  const smsProviderSource = remediationSource('modules/notifications/providers/sms.provider.ts');
  const otpSource = remediationSource('modules/auth/otp.service.ts');
  assert.match(smsProviderSource, /case 'LOG':[\s\S]*NODE_ENV === 'production'[\s\S]*LOG SMS provider is disabled in production/);
  assert.doesNotMatch(smsProviderSource, /Text: "\$\{text\}"/);
  assert.match(otpSource, /if \(!delivery\.success\)[\s\S]*OTP_DELIVERY_FAILED/);
  const storageSource = remediationSource('modules/storage/storage.routes.ts');
  assert.match(storageSource, /hasAdminPrivateStoragePermission\(await AdminRbacService\.getUserPermissions\(user\.userId\), key\)/);

  console.log('Security remediation regression tests passed (existing checks plus SOQ-SEC-001 through SOQ-SEC-005).');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
