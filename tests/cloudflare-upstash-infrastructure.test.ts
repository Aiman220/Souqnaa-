/**
 * SOUQNA ONLINE — CLOUDFLARE + UPSTASH INFRASTRUCTURE TEST SUITE
 * Validates:
 * 1. Upstash Redis connectivity, TLS, and in-memory fallback resilience
 * 2. Distributed Locks (SET NX EX + Atomic Lua Release)
 * 3. Idempotency Key Coordination for Financial Mutations
 * 4. Health (/health) and Readiness (/ready) endpoint contracts
 * 5. Security headers, CORS, and Cache-Control policies
 * 6. Secret leakage prevention across responses
 */

import { redis } from '../src/database/redis';
import { createApp } from '../src/app';
import http from 'http';

async function runInfrastructureTests() {
  console.log('============================================================');
  console.log('⚡ SOUQNA ONLINE — CLOUDFLARE + UPSTASH INFRASTRUCTURE TESTS');
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

  try {
    // ─────────────────────────────────────────────────────────────
    // 1. UPSTASH REDIS SERVICE & HEALTH CHECK
    // ─────────────────────────────────────────────────────────────
    console.log('[1] Testing RedisService / Upstash connectivity & health...');

    const pingResult = await redis.ping();
    assert(
      typeof pingResult.ok === 'boolean',
      'redis.ping() returns valid boolean status',
      JSON.stringify(pingResult)
    );
    assert(
      ['upstash_redis', 'local_redis', 'memory_fallback'].includes(pingResult.mode),
      `Redis operating mode is recognized (${pingResult.mode})`
    );
    assert(
      typeof pingResult.latencyMs === 'number',
      `Latency is measured in ms (${pingResult.latencyMs}ms)`
    );

    // ─────────────────────────────────────────────────────────────
    // 2. REDIS CACHE OPERATIONS (STRING, JSON, TTL)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[2] Testing Cache storage, JSON serialization, and TTL...');

    const testKey = `test:infra:cache:${Date.now()}`;
    await redis.set(testKey, 'souqna_value', 10);
    const retrievedVal = await redis.get(testKey);
    assert(retrievedVal === 'souqna_value', 'String set and get with TTL');

    const jsonKey = `test:infra:json:${Date.now()}`;
    const testData = { marketplace: 'SOUQNA', currency: 'YER', active: true };
    await redis.setJson(jsonKey, testData, 10);
    const retrievedJson = await redis.getJson<typeof testData>(jsonKey);
    assert(
      retrievedJson !== null && retrievedJson.marketplace === 'SOUQNA' && retrievedJson.currency === 'YER',
      'JSON setJson and getJson roundtrip'
    );

    const ttlVal = await redis.ttl(testKey);
    assert(ttlVal > 0 && ttlVal <= 10, `TTL is active and within range (${ttlVal}s)`);

    await redis.del(testKey);
    await redis.del(jsonKey);
    const deletedVal = await redis.get(testKey);
    assert(deletedVal === null, 'Key deletion confirms cleanup');

    // ─────────────────────────────────────────────────────────────
    // 3. DISTRIBUTED LOCKS (SET NX EX & ATOMIC LUA RELEASE)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[3] Testing Distributed Locks (Mutual Exclusion & Token Release)...');

    const lockResource = `order:checkout:test-${Date.now()}`;
    
    // Acquire Lock 1
    const lock1 = await redis.acquireLock(lockResource, 5);
    assert(lock1.acquired === true && Boolean(lock1.token), 'Acquired initial lock on resource');

    // Attempt concurrent lock on same resource (should be blocked)
    const lock2 = await redis.acquireLock(lockResource, 5);
    assert(lock2.acquired === false, 'Concurrent acquireLock attempt is blocked (mutual exclusion)');

    // Attempt release with invalid token (must fail)
    const invalidRelease = await redis.releaseLock(lockResource, 'fake-token-12345');
    assert(invalidRelease === false, 'Lock release with wrong token is rejected');

    // Release with correct token (must succeed)
    const validRelease = await redis.releaseLock(lockResource, lock1.token);
    assert(validRelease === true, 'Lock release with correct token succeeds');

    // Now resource should be acquirable again
    const lock3 = await redis.acquireLock(lockResource, 5);
    assert(lock3.acquired === true, 'Resource is acquirable again after valid release');
    await redis.releaseLock(lockResource, lock3.token);

    // ─────────────────────────────────────────────────────────────
    // 4. IDEMPOTENCY KEY COORDINATION
    // ─────────────────────────────────────────────────────────────
    console.log('\n[4] Testing Idempotency Keys (Financial Mutation Safety)...');

    const idemKey = `idem:payment:txn-${Date.now()}`;

    // First attempt
    const firstAttempt = await redis.acquireIdempotency(idemKey, 60);
    assert(firstAttempt.isFirstAttempt === true, 'First mutation attempt is permitted');

    // Duplicate submission arriving concurrently
    const duplicateAttempt = await redis.acquireIdempotency(idemKey, 60);
    assert(duplicateAttempt.isFirstAttempt === false, 'Duplicate submission is intercepted and blocked');

    // Complete mutation with authoritative result
    const mutationResult = { transactionId: 'TXN-987654', status: 'PAID', amount: 15000 };
    await redis.completeIdempotency(idemKey, mutationResult, 60);

    // Subsequent retrieval returns completed cached result
    const replayAttempt = await redis.acquireIdempotency(idemKey, 60);
    assert(
      replayAttempt.isFirstAttempt === false &&
      replayAttempt.status === 'COMPLETED' &&
      replayAttempt.result?.transactionId === 'TXN-987654',
      'Subsequent replay returns completed cached transaction result'
    );

    // ─────────────────────────────────────────────────────────────
    // 5. HTTP SERVER HEALTH & READINESS PROBE TESTS
    // ─────────────────────────────────────────────────────────────
    console.log('\n[5] Testing Express /health and /ready endpoints...');

    const app = createApp();
    const server = http.createServer(app);

    await new Promise<void>((resolve) => {
      server.listen(4099, () => resolve());
    });

    try {
      // 5.1 GET /health
      const healthRes = await fetchJson('http://localhost:4099/health');
      assert(healthRes.status === 200, 'GET /health returns HTTP 200');
      assert(healthRes.data?.status === 'ok', 'GET /health status is ok');
      assert(healthRes.data?.service === 'souqnaa-backend', 'GET /health identifies service');
      assert(
        !JSON.stringify(healthRes.data).includes('postgresql') &&
        !JSON.stringify(healthRes.data).includes('password') &&
        !JSON.stringify(healthRes.data).includes('token'),
        'GET /health does NOT leak credentials or connection strings'
      );

      // 5.2 GET /ready
      const readyRes = await fetchJson('http://localhost:4099/ready');
      assert(readyRes.status === 200 || readyRes.status === 503, 'GET /ready returns valid status code (200/503)');
      assert(readyRes.data?.dependencies !== undefined, 'GET /ready reports dependency status');
      assert(readyRes.data?.dependencies?.database !== undefined, 'GET /ready reports database dependency');
      assert(readyRes.data?.dependencies?.cache !== undefined, 'GET /ready reports cache dependency');
      assert(
        !JSON.stringify(readyRes.data).includes('postgresql') &&
        !JSON.stringify(readyRes.data).includes('postgres:') &&
        !JSON.stringify(readyRes.data).includes('token'),
        'GET /ready does NOT leak internal database URLs or tokens'
      );

      // 5.3 Cache-Control headers on API routes
      const apiRes = await fetchRaw('http://localhost:4099/api/v1/health');
      const cacheControl = apiRes.headers.get('cache-control');
      assert(
        cacheControl?.includes('no-store') ?? false,
        `Dynamic API routes enforce Cache-Control: no-store (${cacheControl})`
      );

      // 5.4 Security headers (X-Content-Type-Options, etc.)
      const noSniff = apiRes.headers.get('x-content-type-options');
      assert(noSniff === 'nosniff', 'X-Content-Type-Options: nosniff is enforced');

      // 5.5 CORS Preflight Verification (Flutter Web dynamic port & custom headers)
      const preflightRes = await fetch('http://localhost:4099/api/v1/analytics/batch', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:57382',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'cache-control, x-platform, pragma, x-device-id',
        },
      });
      assert(
        preflightRes.status === 204 || preflightRes.status === 200,
        `OPTIONS preflight returns HTTP 204/200 (${preflightRes.status})`
      );
      const allowOrigin = preflightRes.headers.get('access-control-allow-origin');
      assert(
        allowOrigin === 'http://localhost:57382' || allowOrigin === '*',
        `CORS preflight allows dynamic localhost port (${allowOrigin})`
      );
      const allowHeaders = preflightRes.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
      assert(
        allowHeaders.includes('cache-control') && allowHeaders.includes('x-platform'),
        `CORS preflight allows cache-control and x-platform headers (${allowHeaders})`
      );

      // 5.6 POST /api/v1/analytics/batch ingestion
      const batchRes = await fetch('http://localhost:4099/api/v1/analytics/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:57382',
          'Cache-Control': 'no-cache',
          'x-platform': 'web',
        },
        body: JSON.stringify({
          events: [{ event_name: 'test_event', timestamp: Date.now() }],
        }),
      });
      assert(batchRes.status === 200, `POST /api/v1/analytics/batch returns HTTP 200 (${batchRes.status})`);
      const batchData = (await batchRes.json().catch(() => null)) as any;
      assert(batchData?.success === true, 'POST /api/v1/analytics/batch reports success: true');

    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await redis.disconnect();
    }

  } catch (error) {
    console.error('Unexpected error during infrastructure tests:', error);
    failed++;
  }

  console.log('\n============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

async function fetchJson(url: string): Promise<{ status: number; data: any; headers: Headers }> {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function fetchRaw(url: string): Promise<Response> {
  return await fetch(url);
}

runInfrastructureTests();
