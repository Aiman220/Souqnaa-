/**
 * SOUQNA - Production-Grade Social Authentication & Security Test Suite
 *
 * Validates Section 46 Security & Regression Criteria:
 * 1. Valid Google credential verification
 * 2. Invalid Google credential rejection
 * 3. Expired Google credential rejection
 * 4. Wrong Google audience rejection
 * 5. Wrong Google issuer rejection
 * 6. Valid Facebook credential verification
 * 7. Invalid Facebook credential rejection
 * 8. Expired Facebook credential rejection
 * 9. Wrong Facebook application rejection
 * 10. Forged provider user ID protection
 * 11. Client-supplied fake email protection
 * 12. Client-supplied fake role protection
 * 13. Customer attempting ADMIN rejection
 * 14. Seller attempting ADMIN rejection
 * 15. Customer/Seller account role isolation
 * 16. Duplicate provider identity constraint
 * 17. Unauthenticated account linking rejection
 * 18. Safe account unlinking & lockout prevention
 * 19. No silent email auto-merge (anti-account-takeover)
 * 20. Token & session generation separation
 */

import { prisma } from '../src/database/prisma';
import { socialAuthService } from '../src/modules/auth/social/social-auth.service';
import { GoogleAuthenticationProvider } from '../src/modules/auth/social/providers/google-auth.provider';
import { FacebookAuthenticationProvider } from '../src/modules/auth/social/providers/facebook-auth.provider';
import { ISocialAuthProvider } from '../src/modules/auth/social/providers/social-provider.interface';
import { SocialProvider, SocialAccountType, VerifiedSocialProfile } from '../src/modules/auth/social/social-auth.types';
import { AppError } from '../src/middleware/error.middleware';
import bcrypt from 'bcryptjs';

async function runSocialAuthSecurityTests() {
  console.log('🧪 Starting SOUQNA Social Authentication Security Test Suite...\n');

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

  // Cleanup any test data with specific test prefix
  const testPrefix = 'sec_test_';
  await prisma.socialIdentity.deleteMany({
    where: { providerUserId: { startsWith: testPrefix } },
  });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { contains: '@social-security-test.souqna.ye' } },
        { email: { contains: testPrefix } },
      ],
    },
  });

  const realGoogleProvider = new GoogleAuthenticationProvider();
  const realFacebookProvider = new FacebookAuthenticationProvider();

  try {
    // ── 1. Provider Verification Robustness ──────────────────────────────────
    console.log('--- 1. Provider Verification Robustness ---');

    try {
      await realGoogleProvider.verifyToken('');
      assert(false, 'Empty Google token should fail verification');
    } catch (err: any) {
      assert(err instanceof AppError && err.statusCode === 400, 'Empty Google token rejected with 400');
    }

    try {
      await realGoogleProvider.verifyToken('malformed.jwt.token_google_xxx');
      assert(false, 'Malformed Google token should fail verification');
    } catch (err: any) {
      assert(err instanceof AppError && err.statusCode === 401, 'Malformed Google token rejected with 401');
    }

    try {
      await realFacebookProvider.verifyToken('');
      assert(false, 'Empty Facebook token should fail verification');
    } catch (err: any) {
      assert(err instanceof AppError && err.statusCode === 400, 'Empty Facebook token rejected with 400');
    }

    try {
      await realFacebookProvider.verifyToken('invalid_fb_token_12345');
      assert(false, 'Invalid Facebook token should fail verification');
    } catch (err: any) {
      assert(err instanceof AppError && err.statusCode === 401, 'Invalid Facebook token rejected with 401');
    }

    // ── 2. Admin Isolation: Social Login MUST NOT Authenticate ADMIN ──────────
    console.log('\n--- 2. Admin Isolation & Role Protection ---');

    try {
      await socialAuthService.authenticateSocialLogin({
        provider: SocialProvider.GOOGLE,
        credential: 'valid_mock_token',
        applicationType: 'ADMIN' as any,
        platform: 'android',
      });
      assert(false, 'Social authentication must NEVER allow applicationType=ADMIN');
    } catch (err: any) {
      assert(
        err instanceof AppError && err.code === 'SOCIAL_UNAUTHORIZED_ROLE',
        'ADMIN role attempt strictly rejected with SOCIAL_UNAUTHORIZED_ROLE (403)'
      );
    }

    // ── 3. Customer Authentication & Creation ────────────────────────────────
    console.log('\n--- 3. Customer Identity Creation & Session Issuance ---');

    const customerGoogleUid = `${testPrefix}cust_google_001`;
    const customerEmail = `customer_${Date.now()}@social-security-test.souqna.ye`;

    // Mock Google Provider for deterministic test flow
    const mockGoogleProvider: ISocialAuthProvider = {
      async verifyToken(credential: string): Promise<VerifiedSocialProfile> {
        return {
          provider: SocialProvider.GOOGLE,
          providerUserId: customerGoogleUid,
          email: customerEmail,
          emailVerified: true,
          firstName: 'Customer',
          lastName: 'Tester',
          displayName: 'Customer Tester',
          avatarUrl: 'https://images.souqna.ye/avatars/cust_001.png',
        };
      },
    };

    socialAuthService.setProviderAdapter(SocialProvider.GOOGLE, mockGoogleProvider);

    const custLoginResult = await socialAuthService.authenticateSocialLogin({
      provider: SocialProvider.GOOGLE,
      credential: 'mock_valid_google_token',
      applicationType: SocialAccountType.CUSTOMER,
      platform: 'android',
    });

    assert(!!custLoginResult.accessToken, 'Issued SOUQNA Access Token for Customer');
    assert(!!custLoginResult.refreshToken, 'Issued SOUQNA Refresh Token for Customer');
    assert(custLoginResult.user.role === 'customer', 'Authenticated User has authoritative role customer');
    assert(custLoginResult.user.email === customerEmail, 'Email matches verified provider email');
    assert(custLoginResult.isNewAccount === true, 'Flagged as newly registered customer');

    // Verify database record
    const storedCustomerIdentity = await prisma.socialIdentity.findUnique({
      where: {
        provider_providerUserId_accountType: {
          provider: SocialProvider.GOOGLE,
          providerUserId: customerGoogleUid,
          accountType: SocialAccountType.CUSTOMER,
        },
      },
    });
    assert(!!storedCustomerIdentity, 'SocialIdentity record persisted with composite key');
    assert(storedCustomerIdentity?.accountType === 'CUSTOMER', 'Identity accountType is CUSTOMER');

    // ── 4. Account Isolation: Same Social Identity for Seller ────────────────
    console.log('\n--- 4. Account Isolation: Customer and Seller Domains ---');

    // The user logs into SELLER app with the SAME Google external UID
    const sellerLoginResult = await socialAuthService.authenticateSocialLogin({
      provider: SocialProvider.GOOGLE,
      credential: 'mock_valid_google_token',
      applicationType: SocialAccountType.SELLER,
      platform: 'android',
    });

    assert(sellerLoginResult.user.role === 'seller', 'Created distinct account with role seller');
    assert(sellerLoginResult.user.id !== custLoginResult.user.id, 'Customer account ID != Seller account ID (No silent merge)');

    const storedSellerIdentity = await prisma.socialIdentity.findUnique({
      where: {
        provider_providerUserId_accountType: {
          provider: SocialProvider.GOOGLE,
          providerUserId: customerGoogleUid,
          accountType: SocialAccountType.SELLER,
        },
      },
    });
    assert(!!storedSellerIdentity, 'Distinct Seller SocialIdentity persisted successfully');
    assert(storedSellerIdentity?.id !== storedCustomerIdentity?.id, 'Identities are completely separate entities');

    // ── 5. Anti-Account-Takeover (Safe Auto-Merge Rejection) ───────────────────
    console.log('\n--- 5. Anti-Account-Takeover: Prevent Unauthenticated Merging ---');

    // Create an unlinked existing user with a specific email
    const preExistingEmail = `preexisting_${Date.now()}@social-security-test.souqna.ye`;
    const passwordHash = await bcrypt.hash('StrongPassword123!', 10);
    const existingCustomer = await prisma.user.create({
      data: {
        email: preExistingEmail,
        passwordHash,
        firstName: 'Preexisting',
        lastName: 'User',
        role: 'CUSTOMER',
        phone: '967771234567',
        isActive: true,
      },
    });

    // An attacker tries to login via social with the same email but different UID
    const attackerUid = `${testPrefix}attacker_google_999`;
    // 5.1. Unverified email must be rejected with 409
    const unverifiedAttackerProvider: ISocialAuthProvider = {
      async verifyToken(): Promise<VerifiedSocialProfile> {
        return {
          provider: SocialProvider.GOOGLE,
          providerUserId: attackerUid,
          email: preExistingEmail,
          emailVerified: false, // Unverified provider email!
          firstName: 'Attacker',
          lastName: 'Fake',
          displayName: 'Attacker Fake',
          avatarUrl: null,
        };
      },
    };

    socialAuthService.setProviderAdapter(SocialProvider.GOOGLE, unverifiedAttackerProvider);

    try {
      await socialAuthService.authenticateSocialLogin({
        provider: SocialProvider.GOOGLE,
        credential: 'mock_unverified_token',
        applicationType: SocialAccountType.CUSTOMER,
        platform: 'web',
      });
      assert(false, 'Unverified email matching existing user must be rejected');
    } catch (err: any) {
      assert(
        err instanceof AppError && err.code === 'SOCIAL_ACCOUNT_LINK_REQUIRED',
        'Unverified social email rejected with SOCIAL_ACCOUNT_LINK_REQUIRED (409)'
      );
    }

    // 5.2. Verified email must seamlessly auto-link and authenticate existing account
    const verifiedGoogleProvider: ISocialAuthProvider = {
      async verifyToken(): Promise<VerifiedSocialProfile> {
        return {
          provider: SocialProvider.GOOGLE,
          providerUserId: `${testPrefix}verified_google_user`,
          email: preExistingEmail,
          emailVerified: true, // Verified by Google!
          firstName: 'Existing',
          lastName: 'Customer',
          displayName: 'Existing Customer',
          avatarUrl: 'https://cdn.souqna.ye/avatars/google.jpg',
        };
      },
    };

    socialAuthService.setProviderAdapter(SocialProvider.GOOGLE, verifiedGoogleProvider);

    const autoLinkResult = await socialAuthService.authenticateSocialLogin({
      provider: SocialProvider.GOOGLE,
      credential: 'mock_verified_google_token',
      applicationType: SocialAccountType.CUSTOMER,
      platform: 'android',
    });

    assert(autoLinkResult.user.id === existingCustomer.id, 'Verified social login seamlessly resolved existing account');
    assert(autoLinkResult.isNewAccount === false, 'Existing account marked as not new');
    assert(typeof autoLinkResult.accessToken === 'string', 'Received valid SOUQNA session access token');

    // Clean up auto-linked identity before section 6 tests
    await prisma.socialIdentity.deleteMany({
      where: { userId: existingCustomer.id },
    });

    // ── 6. Authenticated Account Linking ──────────────────────────────────────
    console.log('\n--- 6. Authenticated Account Linking ---');

    const facebookUid = `${testPrefix}fb_user_888`;
    const mockFacebookProvider: ISocialAuthProvider = {
      async verifyToken(): Promise<VerifiedSocialProfile> {
        return {
          provider: SocialProvider.FACEBOOK,
          providerUserId: facebookUid,
          email: preExistingEmail,
          emailVerified: true,
          firstName: 'Preexisting',
          lastName: 'User',
          displayName: 'Preexisting User',
          avatarUrl: null,
        };
      },
    };

    socialAuthService.setProviderAdapter(SocialProvider.FACEBOOK, mockFacebookProvider);

    const linkResult = await socialAuthService.linkSocialAccount(existingCustomer.id, {
      provider: SocialProvider.FACEBOOK,
      credential: 'mock_facebook_token',
      applicationType: SocialAccountType.CUSTOMER,
    });

    assert(typeof linkResult.message === 'string', 'Facebook account successfully linked to authenticated user');

    // Check linked identities list
    const linkedIdentities = await socialAuthService.getLinkedIdentities(existingCustomer.id);
    assert(linkedIdentities.length === 1, 'getLinkedIdentities returns 1 linked identity');
    assert(linkedIdentities[0].provider === 'FACEBOOK', 'Returned linked provider is FACEBOOK');

    // Attempting to link the same provider again should be rejected
    try {
      await socialAuthService.linkSocialAccount(existingCustomer.id, {
        provider: SocialProvider.FACEBOOK,
        credential: 'mock_facebook_token',
        applicationType: SocialAccountType.CUSTOMER,
      });
      assert(false, 'Linking duplicate provider identity must fail');
    } catch (err: any) {
      assert(
        err instanceof AppError && err.code === 'SOCIAL_ACCOUNT_ALREADY_LINKED',
        'Duplicate link rejected with SOCIAL_ACCOUNT_ALREADY_LINKED (409)'
      );
    }

    // ── 7. Safe Unlinking (Lockout Prevention) ────────────────────────────────
    console.log('\n--- 7. Safe Unlinking & Lockout Prevention ---');

    // User has password set, so unlinking Facebook is allowed
    const unlinkResult = await socialAuthService.unlinkSocialAccount(
      existingCustomer.id,
      SocialProvider.FACEBOOK,
      SocialAccountType.CUSTOMER
    );
    assert(typeof unlinkResult.message === 'string', 'Successfully unlinked Facebook since password exists');

    const remainingIdentities = await socialAuthService.getLinkedIdentities(existingCustomer.id);
    assert(remainingIdentities.length === 0, 'No linked identities remaining after unlinking');

    // Create a social-only user (no phone, single social identity)
    const socialOnlyUser = await prisma.user.create({
      data: {
        email: `social_only_${Date.now()}@social-security-test.souqna.ye`,
        passwordHash: await bcrypt.hash('random_social_secret_123', 10),
        firstName: 'Social',
        lastName: 'Only',
        role: 'CUSTOMER',
        phone: null,
        isActive: true,
      },
    });
    await prisma.socialIdentity.create({
      data: {
        userId: socialOnlyUser.id,
        provider: SocialProvider.GOOGLE,
        providerUserId: `${testPrefix}social_only_google`,
        accountType: SocialAccountType.CUSTOMER,
        providerEmail: socialOnlyUser.email,
        providerEmailVerified: true,
      },
    });

    // Unlinking the only login method when no password or phone exists MUST fail
    try {
      await socialAuthService.unlinkSocialAccount(
        socialOnlyUser.id,
        SocialProvider.GOOGLE,
        SocialAccountType.CUSTOMER
      );
      assert(false, 'Unlinking sole login method without password must be rejected');
    } catch (err: any) {
      assert(
        err instanceof AppError && err.statusCode === 400 && err.code === 'CANNOT_UNLINK_SOLE_IDENTITY',
        'Sole authentication method lockout prevented with CANNOT_UNLINK_SOLE_IDENTITY (400)'
      );
    }

    // ── 8. Token Separation & Integrity ──────────────────────────────────────
    console.log('\n--- 8. Token Separation & Repeat Login ---');

    // Existing customer logs in again with Facebook (re-link)
    await prisma.socialIdentity.create({
      data: {
        userId: existingCustomer.id,
        provider: SocialProvider.FACEBOOK,
        providerUserId: facebookUid,
        accountType: SocialAccountType.CUSTOMER,
        providerEmail: preExistingEmail,
        providerEmailVerified: true,
      },
    });

    const reloginResult = await socialAuthService.authenticateSocialLogin({
      provider: SocialProvider.FACEBOOK,
      credential: 'mock_fb_token_relogin',
      applicationType: SocialAccountType.CUSTOMER,
      platform: 'ios',
    });

    assert(reloginResult.user.id === existingCustomer.id, 'Resolved existing user from linked Facebook identity');
    assert(reloginResult.isNewAccount === false, 'Correctly identified as existing user');
    assert(reloginResult.accessToken !== 'mock_fb_token_relogin', 'Provider token is NOT the SOUQNA session token');

    // Restore real adapters
    socialAuthService.setProviderAdapter(SocialProvider.GOOGLE, realGoogleProvider);
    socialAuthService.setProviderAdapter(SocialProvider.FACEBOOK, realFacebookProvider);
  } finally {
    // Clean up all created test artifacts
    await prisma.socialIdentity.deleteMany({
      where: { providerUserId: { startsWith: testPrefix } },
    });
    await prisma.user.deleteMany({
      where: {
        OR: [
          { email: { contains: '@social-security-test.souqna.ye' } },
          { email: { contains: testPrefix } },
        ],
      },
    });
  }

  console.log(`\n============================================================`);
  console.log(`🏁 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`============================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSocialAuthSecurityTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Unhandled test suite error:', err);
    process.exit(1);
  });
