/**
 * SOUQNA — AR-2.1: JWT Security & Authentication Verification Suite
 * 
 * Scope A:
 * 1. Missing secret safely aborts / throws error
 * 2. Secret with insufficient entropy (<32 chars) fails safely
 * 3. Insecure default placeholder fails safely
 * 4. Valid secret resolution passes
 * 5. Token generation & verification roundtrip with valid config
 * 6. Tampered / wrong secret token verification fails
 * 
 * Scope B:
 * 7. Query parameter ?token= is rejected by authenticate middleware (401)
 * 8. Query parameter ?auth_token= is rejected by authenticate middleware (401)
 * 9. Authorization: Bearer <valid_token> is accepted and extracted
 * 10. Query parameter token is ignored by optionalAuth middleware
 */

import { resolveMandatoryJwtSecret, config } from '../src/config';
import { JwtUtil } from '../src/utils/jwt.util';
import { authenticate, optionalAuth } from '../src/middleware/auth.middleware';
import { AppError } from '../src/middleware/error.middleware';
import { Request, Response } from 'express';

async function runJwtAndAuthTests() {
  console.log('============================================================');
  console.log('🔒 SOUQNA AR-2.1 — JWT & AUTHENTICATION SECURITY TESTS');
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

  // Preserve initial environment
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;

  try {
    // ─────────────────────────────────────────────────────────────
    // SCOPE A: JWT SECRET RESOLUTION & FALLBACK ELIMINATION
    // ─────────────────────────────────────────────────────────────
    console.log('[Scope A] Testing JWT Secret Resolution & Fallback Elimination...');

    // 1. Missing secret
    delete process.env.JWT_SECRET;
    let missingSecretThrew = false;
    let missingErrorMessage = '';
    try {
      resolveMandatoryJwtSecret('JWT_SECRET');
    } catch (err: any) {
      missingSecretThrew = true;
      missingErrorMessage = err.message;
    }
    assert(
      missingSecretThrew && missingErrorMessage.includes('is not set in environment'),
      'Missing JWT_SECRET throws descriptive configuration error at startup',
      missingErrorMessage
    );
    assert(
      !missingErrorMessage.includes(originalJwtSecret || ''),
      'Startup error does not leak any secret data in log message'
    );

    // 2. Short / weak secret (<32 chars)
    process.env.JWT_SECRET = 'short_weak_secret_12345';
    let shortSecretThrew = false;
    let shortErrorMessage = '';
    try {
      resolveMandatoryJwtSecret('JWT_SECRET');
    } catch (err: any) {
      shortSecretThrew = true;
      shortErrorMessage = err.message;
    }
    assert(
      shortSecretThrew && shortErrorMessage.includes('at least 32 characters'),
      'Secret with <32 characters fails startup safely',
      shortErrorMessage
    );

    // 3. Known insecure placeholder defaults
    process.env.JWT_SECRET = 'souqna_super_jwt_secret_2026';
    let placeholderSecretThrew = false;
    let placeholderErrorMessage = '';
    try {
      resolveMandatoryJwtSecret('JWT_SECRET');
    } catch (err: any) {
      placeholderSecretThrew = true;
      placeholderErrorMessage = err.message;
    }
    assert(
      placeholderSecretThrew && placeholderErrorMessage.includes('insecure default placeholder'),
      'Insecure default placeholder "souqna_super_jwt_secret_2026" is strictly rejected',
      placeholderErrorMessage
    );

    // 4. Valid strong secret
    const validStrongSecret = 'souqna_production_super_secret_key_2026_at_least_32_characters';
    process.env.JWT_SECRET = validStrongSecret;
    let resolvedSecret = '';
    try {
      resolvedSecret = resolveMandatoryJwtSecret('JWT_SECRET');
    } catch (err: any) {
      // should not throw
    }
    assert(
      resolvedSecret === validStrongSecret,
      'Valid secret with >= 32 characters is accepted successfully'
    );

    // 5. Token generation & verification roundtrip
    process.env.JWT_REFRESH_SECRET = 'souqna_production_super_refresh_key_2026_at_least_32_characters';
    const testPayload = {
      userId: 'test-user-uuid-12345',
      email: 'security-audit@souqnaa.com',
      role: 'CUSTOMER' as const,
    };

    const tokens = JwtUtil.generateTokens(testPayload);
    assert(
      typeof tokens.accessToken === 'string' && tokens.accessToken.length > 50,
      'Generates valid format JWT access token'
    );
    assert(
      typeof tokens.refreshToken === 'string' && tokens.refreshToken.length > 50,
      'Generates valid format JWT refresh token'
    );

    const decodedAccess = JwtUtil.verifyAccessToken(tokens.accessToken);
    assert(
      decodedAccess.userId === testPayload.userId && decodedAccess.email === testPayload.email,
      'AccessToken decodes and verifies with valid cryptographic signature'
    );

    const decodedRefresh = JwtUtil.verifyRefreshToken(tokens.refreshToken);
    assert(
      decodedRefresh.userId === testPayload.userId && decodedRefresh.email === testPayload.email,
      'RefreshToken decodes and verifies with valid cryptographic signature'
    );

    // 6. Token signature validation failure with tampered token
    let tamperedVerificationFailed = false;
    try {
      const tampered = tokens.accessToken.slice(0, -5) + 'xxxxx';
      JwtUtil.verifyAccessToken(tampered);
    } catch (err) {
      tamperedVerificationFailed = true;
    }
    assert(tamperedVerificationFailed, 'Tampered token signature is rejected by verification');

    // ─────────────────────────────────────────────────────────────
    // SCOPE B: JWT QUERY PARAMETER AUTHENTICATION REJECTION
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Scope B] Testing JWT Query-Parameter Authentication Rejection...');

    // 7. Query param ?token= is rejected by authenticate middleware
    const reqWithQueryToken = {
      headers: {},
      query: { token: tokens.accessToken },
    } as unknown as Request;

    const resMock = {} as Response;
    let queryTokenError: any = null;
    await authenticate(reqWithQueryToken, resMock, (err?: any) => {
      queryTokenError = err;
    });

    assert(
      queryTokenError instanceof AppError && queryTokenError.statusCode === 401,
      'authenticate middleware rejects ?token= in query string with 401 Unauthorized'
    );

    // 8. Query param ?auth_token= is rejected by authenticate middleware
    const reqWithAuthQueryToken = {
      headers: {},
      query: { auth_token: tokens.accessToken },
    } as unknown as Request;

    let authQueryTokenError: any = null;
    await authenticate(reqWithAuthQueryToken, resMock, (err?: any) => {
      authQueryTokenError = err;
    });

    assert(
      authQueryTokenError instanceof AppError && authQueryTokenError.statusCode === 401,
      'authenticate middleware rejects ?auth_token= in query string with 401 Unauthorized'
    );

    // 9. Query param is ignored by optionalAuth middleware
    const reqOptionalQuery = {
      headers: {},
      query: { token: tokens.accessToken },
    } as unknown as Request;
    await optionalAuth(reqOptionalQuery, resMock, () => {});
    assert(
      reqOptionalQuery.user === undefined,
      'optionalAuth middleware ignores query parameters and leaves req.user undefined'
    );

    // 10. Valid Bearer token in header is extracted by optionalAuth
    const reqOptionalHeader = {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
      query: {},
    } as unknown as Request;
    await optionalAuth(reqOptionalHeader, resMock, () => {});
    assert(
      reqOptionalHeader.user?.userId === testPayload.userId,
      'optionalAuth middleware extracts and verifies valid Authorization: Bearer token'
    );

  } finally {
    // Restore original environment
    if (originalJwtSecret) {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    if (originalRefreshSecret) {
      process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
    }
  }

  console.log('\n============================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runJwtAndAuthTests().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
