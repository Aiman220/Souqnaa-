import assert from 'assert';
import fs from 'fs';
import path from 'path';

console.log('============================================================');
console.log('🛡️  SOUQNAA AR-3.0 — REMEDIATION & SECURITY VERIFICATION SUITE');
console.log('============================================================\n');

let passed = 0;
let failed = 0;

function check(title: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ PASS: ${title}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ FAIL: ${title} — ${err.message}`);
    failed++;
  }
}

// -------------------------------------------------------------
// [1] Verify CRT-005: Payment Intent Ownership Check
// -------------------------------------------------------------
console.log('[1] Testing CRT-005: Payment Intent BOLA/IDOR Ownership Check...');

const paymentRoutesPath = path.resolve(__dirname, '../src/modules/payments/payment.routes.ts');
const paymentRoutesContent = fs.readFileSync(paymentRoutesPath, 'utf8');

check('Payment routes file exists', () => {
  assert(fs.existsSync(paymentRoutesPath));
});

check('POST /:orderId/intent enforces order.userId ownership check', () => {
  assert(
    paymentRoutesContent.includes('if (order.userId !== req.user!.userId && req.user!.role !== \'ADMIN\')'),
    'Missing ownership check in /:orderId/intent'
  );
});

check('POST /:orderId/intent throws 403 FORBIDDEN when user does not own order', () => {
  assert(
    paymentRoutesContent.includes('Forbidden: Access denied to other customer orders'),
    'Expected 403 Forbidden message in /:orderId/intent'
  );
});

// -------------------------------------------------------------
// [2] Verify CRT-003: OAuth URL Token Parameter Elimination
// -------------------------------------------------------------
console.log('\n[2] Testing CRT-003: OAuth URL Token Leakage Elimination...');

const authControllerPath = path.resolve(__dirname, '../src/modules/auth/auth.controller.ts');
const authControllerContent = fs.readFileSync(authControllerPath, 'utf8');

check('renderOAuthResultHtml does NOT leak accessToken in query parameters', () => {
  assert(
    !authControllerContent.includes("params.set('token', accessToken)"),
    'Found params.set("token", accessToken) in renderOAuthResultHtml'
  );
});

check('renderOAuthResultHtml does NOT leak refreshToken in query parameters', () => {
  assert(
    !authControllerContent.includes("params.set('refresh', refreshToken)"),
    'Found params.set("refresh", refreshToken) in renderOAuthResultHtml'
  );
});

check('renderOAuthResultHtml preserves opaque sessionKey for secure backchannel exchange', () => {
  assert(
    authControllerContent.includes("params.set('sessionKey', sessionKey)"),
    'Missing sessionKey in renderOAuthResultHtml'
  );
});

// -------------------------------------------------------------
// [3] Verify CRT-002, HIGH-001 & MED-005 in render.yaml
// -------------------------------------------------------------
console.log('\n[3] Testing CRT-002 & Deployment Hardening in render.yaml...');

const renderYamlPath = path.resolve(__dirname, '../../render.yaml');
const renderYamlContent = fs.readFileSync(renderYamlPath, 'utf8');

check('render.yaml eliminates CORS_ORIGIN: "*"', () => {
  assert(
    !renderYamlContent.includes('value: "*"'),
    'render.yaml still has CORS_ORIGIN: "*"'
  );
});

check('render.yaml specifies explicit allowed production origins', () => {
  assert(
    renderYamlContent.includes('https://souqnaa.com') &&
    renderYamlContent.includes('https://www.souqnaa.com') &&
    renderYamlContent.includes('https://souqnaa-customer.web.app'),
    'Missing explicit allowed origins in render.yaml'
  );
});

check('render.yaml completely removes OTP_DEV_BYPASS_CODE="123456"', () => {
  assert(
    !renderYamlContent.includes('OTP_DEV_BYPASS_CODE'),
    'render.yaml still contains OTP_DEV_BYPASS_CODE'
  );
});

check('render.yaml sets BOOTSTRAP_ADMIN_EMAIL to sync: false (not hardcoded)', () => {
  assert(
    !renderYamlContent.includes('value: admin@souqna.online'),
    'render.yaml still hardcodes admin@souqna.online'
  );
});

// -------------------------------------------------------------
// [4] Verify MED-004: requirePermissions stub in auth.middleware.ts
// -------------------------------------------------------------
console.log('\n[4] Testing MED-004: requirePermissions Delegation Guard...');

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.middleware.ts');
const authMiddlewareContent = fs.readFileSync(authMiddlewarePath, 'utf8');

check('requirePermissions in auth.middleware.ts delegates to rbac.middleware requirePermission', () => {
  assert(
    authMiddlewareContent.includes("requirePermission(...permissions)"),
    'requirePermissions does not enforce permissions via requirePermission'
  );
});

// -------------------------------------------------------------
// [5] Verify HIGH-004: Bare-Path Duplicate Mounts Elimination
// -------------------------------------------------------------
console.log('\n[5] Testing HIGH-004: Elimination of Bare-Path Shadow Routes...');

const appTsPath = path.resolve(__dirname, '../src/app.ts');
const appTsContent = fs.readFileSync(appTsPath, 'utf8');

check('app.ts does NOT mount unversioned /admin shadow route', () => {
  assert(
    !appTsContent.includes("app.use('/admin', adminRoutes)"),
    'Found unversioned app.use("/admin", adminRoutes) in app.ts'
  );
});

check('app.ts does NOT mount unversioned /admin statements shadow route', () => {
  assert(
    !appTsContent.includes("app.use('/admin', adminStatementsRouter)"),
    'Found unversioned app.use("/admin", adminStatementsRouter) in app.ts'
  );
});

// -------------------------------------------------------------
// [6] Verify HIGH-002: Next.js CSP Wildcard Script-Src Elimination
// -------------------------------------------------------------
console.log('\n[6] Testing HIGH-002: Next.js CSP Tightening...');

const nextConfigPath = path.resolve(__dirname, '../../apps/web/next.config.ts');
const nextConfigContent = fs.readFileSync(nextConfigPath, 'utf8');

check('next.config.ts eliminates wildcard https: from script-src', () => {
  assert(
    !nextConfigContent.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' https:"),
    'next.config.ts still has wildcard https: in script-src'
  );
  assert(
    nextConfigContent.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
    'next.config.ts missing tightened script-src directive'
  );
});

// -------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------
console.log('\n============================================================');
console.log(`TOTAL AR-3.0 VERIFICATION CHECKS: ${passed + failed}`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
console.log('============================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ ALL AR-3.0 REMEDIATION CHECKS PASSED SUCCESSFULLY.\n');
  process.exit(0);
}

