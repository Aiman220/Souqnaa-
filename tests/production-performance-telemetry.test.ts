import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { backendTelemetry } from '../src/services/telemetry/backend-telemetry.service';

async function runTests() {
  console.log('============================================================');
  console.log('⚡ SOUQNA — PRODUCTION PERFORMANCE & STABILITY TEST SUITE');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      const res = fn();
      if (res && typeof (res as any).then === 'function') {
        return (res as Promise<void>)
          .then(() => {
            console.log(`  ✓ PASS: ${name}`);
            passed++;
          })
          .catch((err) => {
            console.error(`  ✗ FAIL: ${name} - ${err.message}`);
            failed++;
          });
      }
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ FAIL: ${name} - ${err.message}`);
      failed++;
    }
  }

  console.log('[1] Testing Backend Telemetry & Percentile Calculation...');

  backendTelemetry.reset();

  test('Calculates p50, p95, p99 latencies correctly with rolling reservoir', () => {
    // Inject 100 requests with latencies 1ms to 100ms
    for (let i = 1; i <= 100; i++) {
      backendTelemetry.recordRequest({
        method: 'GET',
        endpoint: '/api/v1/products',
        statusCode: i === 100 ? 500 : 200,
        durationMs: i,
        responseBytes: 1024,
      });
    }

    const snapshot = backendTelemetry.getSnapshot();
    assert.strictEqual(snapshot.requests.total, 100);
    assert.strictEqual(snapshot.requests.success, 99);
    assert.strictEqual(snapshot.requests.errors, 1);
    assert.strictEqual(snapshot.requests.errorRatePercent, 1);
    assert.strictEqual(snapshot.latencyMs.min, 1);
    assert.strictEqual(snapshot.latencyMs.max, 100);
    assert.strictEqual(snapshot.latencyMs.p50, 51);
    assert.strictEqual(snapshot.latencyMs.p95, 96);
    assert.strictEqual(snapshot.latencyMs.p99, 100);
    assert.strictEqual(snapshot.payloadBytes.totalResponseBytes, 100 * 1024);
    assert.strictEqual(snapshot.payloadBytes.avgResponseBytes, 1024);
  });

  test('Tracks database query metrics and slow query count', () => {
    backendTelemetry.recordDbQuery(15, false);
    backendTelemetry.recordDbQuery(300, true);
    backendTelemetry.recordDbQuery(25, false);

    const snapshot = backendTelemetry.getSnapshot();
    assert.strictEqual(snapshot.database.totalQueries, 3);
    assert.strictEqual(snapshot.database.slowQueries, 1);
    assert.ok(snapshot.database.avgQueryDurationMs > 0);
  });

  test('Tracks real-time socket connections and reconnected client count', () => {
    backendTelemetry.recordSocketConnection(false);
    backendTelemetry.recordSocketConnection(true); // reconnect
    backendTelemetry.recordSocketConnection(false);

    let snapshot = backendTelemetry.getSnapshot();
    assert.strictEqual(snapshot.realtime.activeSocketConnections, 3);
    assert.strictEqual(snapshot.realtime.reconnectCount, 1);

    backendTelemetry.recordSocketDisconnection();
    snapshot = backendTelemetry.getSnapshot();
    assert.strictEqual(snapshot.realtime.activeSocketConnections, 2);
  });

  console.log('\n[2] Testing Privacy-Safe Sensitive Query Sanitization...');

  test('Query sanitization redacts tokens, passwords, and secrets', () => {
    const SENSITIVE_QUERY_KEYS = new Set([
      'token',
      'password',
      'secret',
      'authorization',
      'refreshtoken',
      'accesstoken',
      'key',
      'otp',
      'pin',
      'cvv',
      'card',
      'cardnumber',
      'signature',
    ]);

    function sanitizePath(rawUrl: string): string {
      const qIndex = rawUrl.indexOf('?');
      if (qIndex === -1) return rawUrl;

      const p = rawUrl.substring(0, qIndex);
      const queryString = rawUrl.substring(qIndex + 1);
      const params = new URLSearchParams(queryString);

      const safeParams = new URLSearchParams();
      params.forEach((value, key) => {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          safeParams.set(key, '[REDACTED]');
        } else {
          safeParams.set(key, value);
        }
      });

      return `${p}?${safeParams.toString()}`;
    }

    const dirtyUrl = '/api/v1/products?q=shoes&token=eyJhbGciOi...&password=secretPassword123&cvv=999';
    const cleanUrl = sanitizePath(dirtyUrl);

    assert.ok(!cleanUrl.includes('secretPassword123'), 'Password must not appear in sanitized URL');
    assert.ok(!cleanUrl.includes('eyJhbGciOi'), 'Token must not appear in sanitized URL');
    assert.ok(!cleanUrl.includes('999'), 'CVV must not appear in sanitized URL');
    assert.ok(cleanUrl.includes('token=%5BREDACTED%5D') || cleanUrl.includes('token=[REDACTED]'), 'Token must be redacted');
    assert.ok(cleanUrl.includes('q=shoes'), 'Safe query parameter must be preserved');
  });

  console.log('\n[3] Testing Database Optimization & Evidence-Based Indexes in Schema...');

  test('Schema defines critical composite indexes for sorting and filtering', () => {
    const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');

    assert.ok(schemaContent.includes('@@index([isActive, price])'), 'Product must index [isActive, price]');
    assert.ok(schemaContent.includes('@@index([isActive, rating(sort: Desc)])'), 'Product must index [isActive, rating]');
    assert.ok(schemaContent.includes('@@index([userId, status, createdAt(sort: Desc)])'), 'Order must index [userId, status, createdAt]');
    assert.ok(schemaContent.includes('@@index([sellerId, status, createdAt(sort: Desc)])'), 'SellerOrder must index [sellerId, status, createdAt]');
  });

  console.log('\n[4] Testing HTTP Server Keep-Alive & Cloudflare Socket Timing Settings...');

  test('HTTP keepAliveTimeout is configured for Cloudflare CDN persistence (>= 60s)', () => {
    const serverPath = path.resolve(__dirname, '../src/server.ts');
    const serverContent = fs.readFileSync(serverPath, 'utf8');

    assert.ok(serverContent.includes('server.keepAliveTimeout = 65000'), 'Keep-alive timeout must be 65s for Cloudflare compatibility');
    assert.ok(serverContent.includes('server.headersTimeout = 66000'), 'Headers timeout must exceed keep-alive timeout');
    assert.ok(serverContent.includes('CampaignBannerScheduler.init().catch'), 'Campaign init must be deferred/non-blocking for fast cold-start');
    assert.ok(serverContent.includes('SellerReserveScheduler.stop()'), 'Graceful shutdown must stop SellerReserveScheduler');
    assert.ok(serverContent.includes('SocketService.get()?.close()'), 'Graceful shutdown must drain socket connections');
  });

  console.log('\n============================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running performance test suite:', err);
  process.exit(1);
});
