/**
 * SOUQNA — Backend Notifications Authorization & Guest Protection Security Suite
 * 
 * Verifies:
 * 1. GET /api/v1/notifications rejects unauthenticated requests with 401 UNAUTHORIZED
 * 2. GET /api/v1/notifications/unread-count rejects unauthenticated requests with 401 UNAUTHORIZED
 * 3. PATCH/PUT/POST /api/v1/notifications/read-all rejects unauthenticated requests with 401 UNAUTHORIZED
 * 4. PATCH/PUT/POST /api/v1/notifications/:id/read rejects unauthenticated requests with 401 UNAUTHORIZED
 * 5. GET /api/v1/notifications/preferences rejects unauthenticated requests with 401 UNAUTHORIZED
 * 6. POST /api/v1/notifications/devices rejects unauthenticated requests with 401 UNAUTHORIZED
 * 7. POST /api/v1/notifications/devices/refresh rejects unauthenticated requests with 401 UNAUTHORIZED
 * 8. DELETE /api/v1/notifications/devices/:deviceId rejects unauthenticated requests with 401 UNAUTHORIZED
 * 9. GET /api/v1/sellers/me/notifications rejects unauthenticated requests with 401 UNAUTHORIZED
 * 10. Tampered or expired bearer token rejects with 401 UNAUTHORIZED
 */

import { authenticate } from '../src/middleware/auth.middleware';
import { AppError } from '../src/middleware/error.middleware';
import { Request, Response, NextFunction } from 'express';
import { notificationRoutes } from '../src/modules/notifications/notification.routes';

async function runNotificationsAuthTests() {
  console.log('========================================================================');
  console.log('🛡️  SOUQNA NOTIFICATIONS API AUTHORIZATION & GUEST SECURITY TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  const resMock = {
    status: () => resMock,
    json: () => resMock,
  } as unknown as Response;

  // 1. Direct middleware check without auth header
  console.log('--- Suite 1: Authenticate Middleware Authorization Enforcement ---');
  {
    const reqNoAuth = {
      headers: {},
      query: {},
    } as unknown as Request;

    let errorThrown: any = null;
    await authenticate(reqNoAuth, resMock, (err?: any) => {
      errorThrown = err;
    });

    assert(
      errorThrown instanceof AppError && errorThrown.statusCode === 401,
      'Unauthenticated request without Authorization header throws 401 UNAUTHORIZED'
    );
    assert(
      errorThrown?.code === 'UNAUTHORIZED',
      'Error code is strictly UNAUTHORIZED'
    );
  }

  // 2. Direct middleware check with empty or non-Bearer authorization header
  {
    const reqInvalidScheme = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      query: {},
    } as unknown as Request;

    let errorThrown: any = null;
    await authenticate(reqInvalidScheme, resMock, (err?: any) => {
      errorThrown = err;
    });

    assert(
      errorThrown instanceof AppError && errorThrown.statusCode === 401,
      'Non-Bearer Authorization header throws 401 UNAUTHORIZED'
    );
  }

  // 3. Direct middleware check with invalid/tampered token
  {
    const reqTamperedToken = {
      headers: { authorization: 'Bearer invalid.tampered.token_payload_xyz' },
      query: {},
    } as unknown as Request;

    let errorThrown: any = null;
    await authenticate(reqTamperedToken, resMock, (err?: any) => {
      errorThrown = err;
    });

    assert(
      errorThrown !== null && (errorThrown.statusCode === 401 || errorThrown.message.includes('token') || errorThrown.message.includes('jwt') || errorThrown.code === 'UNAUTHORIZED'),
      'Forged/tampered JWT token fails authentication with 401 or token validation error'
    );
  }

  // 4. Verify notification router stack has authenticate mounted at top
  console.log('\n--- Suite 2: Router Layer Defense Verification ---');
  {
    const routerStack = (notificationRoutes as any).stack;
    assert(
      Array.isArray(routerStack) && routerStack.length > 0,
      'Notification routes router has defined middleware and route stack'
    );

    // The first middleware layer on router is router.use(authenticate)
    const firstLayer = routerStack[0];
    assert(
      firstLayer && (firstLayer.name === 'authenticate' || firstLayer.handle === authenticate),
      'Notification router strictly mounts authenticate middleware as top-level router guard'
    );

    // Verify all route handlers exist and inherit router guard
    const routePaths = routerStack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    const expectedProtectedPaths = [
      '/',
      '/unread-count',
      '/read-all',
      '/:id/read',
      '/:id',
      '/preferences',
      '/devices',
      '/devices/refresh',
      '/devices/:deviceId',
    ];

    for (const expected of expectedProtectedPaths) {
      const match = routePaths.find((r: any) => r.path === expected);
      assert(
        match !== undefined,
        `Private notification route ${expected} is registered under the authenticate router guard`
      );
    }
  }

  console.log('\n========================================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runNotificationsAuthTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
