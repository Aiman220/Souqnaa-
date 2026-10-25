/**
 * SOUQNA — Seller Profile Contact Details & Editing Backend Test Suite
 * 
 * Verifies:
 * 1. The authenticated seller sees their own real profile details (GET /api/v1/sellers/me).
 * 2. Valid first-name and last-name changes save successfully (PATCH /api/v1/sellers/me).
 * 3. Valid email and phone changes follow the required verification workflow.
 * 4. Invalid email, phone, or required names are rejected (400 validation error).
 * 5. Duplicate email/phone conflicts are handled correctly (409 conflict).
 * 6. Unauthorized users cannot update another seller's profile (ownership enforcement).
 * 7. Server-side validation cannot be bypassed (e.g., client isVerified injection ignored).
 * 8. Successful updates refresh profile and return canonical data.
 * 9. Updated values persist in authoritative database across re-fetches.
 */

import http from 'http';
import { prisma } from '../src/database/prisma';
import { redis } from '../src/database/redis';
import { createApp } from '../src/app';
import { JwtUtil } from '../src/utils/jwt.util';

async function runSellerProfileTests() {
  console.log('===============================================================');
  console.log('👤 SOUQNA Seller Profile Contact Details & Security Tests');
  console.log('===============================================================\n');

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

  // Create Express application and start listening on an ephemeral port
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function requestApi(
    method: string,
    path: string,
    token?: string,
    body?: any
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      const postData = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        baseUrl + path,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed = {};
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = { raw: data };
            }
            resolve({ status: res.statusCode || 500, body: parsed });
          });
        }
      );

      req.on('error', (err) => {
        resolve({ status: 500, body: { error: err.message } });
      });

      if (postData) req.write(postData);
      req.end();
    });
  }

  const timestamp = Date.now();
  const testSellerUserId1 = `test-seller-u1-${timestamp}`;
  const testSellerUserId2 = `test-seller-u2-${timestamp}`;
  const testCustomerId = `test-customer-u-${timestamp}`;

  const emailSeller1 = `seller1_${timestamp}@souqnaa.test`;
  const emailSeller2 = `seller2_${timestamp}@souqnaa.test`;
  const phoneSeller1 = `+967771${timestamp.toString().slice(-6)}`;
  const phoneSeller2 = `+967772${timestamp.toString().slice(-6)}`;

  let tokenSeller1 = '';
  let tokenSeller2 = '';
  let tokenCustomer = '';

  try {
    console.log('--- [1/5] Setting Up Test Accounts in Database ---');

    const user1 = await prisma.user.create({
      data: {
        id: testSellerUserId1,
        email: emailSeller1,
        phone: phoneSeller1,
        firstName: 'أحمد',
        lastName: 'التاجر',
        passwordHash: 'dummyhash',
        role: 'SELLER',
        isVerified: true,
        isActive: true,
      },
    });

    const seller1 = await prisma.seller.create({
      data: {
        userId: user1.id,
        businessType: 'INDIVIDUAL',
        crNumber: 'CR-123456',
        status: 'ACTIVE',
      },
    });

    await prisma.store.create({
      data: {
        sellerId: seller1.id,
        name: 'متجر أحمد للملابس',
        slug: `store-ahmed-${timestamp}`,
        isActive: true,
        isVerified: true,
      },
    });

    const user2 = await prisma.user.create({
      data: {
        id: testSellerUserId2,
        email: emailSeller2,
        phone: phoneSeller2,
        firstName: 'سالم',
        lastName: 'العالمي',
        passwordHash: 'dummyhash',
        role: 'SELLER',
        isVerified: true,
        isActive: true,
      },
    });

    await prisma.seller.create({
      data: {
        userId: user2.id,
        businessType: 'COMPANY',
        crNumber: 'CR-654321',
        status: 'ACTIVE',
      },
    });

    const customerUser = await prisma.user.create({
      data: {
        id: testCustomerId,
        email: `customer_${timestamp}@souqnaa.test`,
        phone: `+967773${timestamp.toString().slice(-6)}`,
        firstName: 'عميل',
        lastName: 'تجريبي',
        passwordHash: 'dummyhash',
        role: 'CUSTOMER',
        isVerified: true,
        isActive: true,
      },
    });

    tokenSeller1 = JwtUtil.generateTokens({
      userId: user1.id,
      email: user1.email,
      role: user1.role,
    }).accessToken;

    tokenSeller2 = JwtUtil.generateTokens({
      userId: user2.id,
      email: user2.email,
      role: user2.role,
    }).accessToken;

    tokenCustomer = JwtUtil.generateTokens({
      userId: customerUser.id,
      email: customerUser.email,
      role: customerUser.role,
    }).accessToken;

    console.log('  ✓ Test accounts prepared.\n');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: Retrieve profile details
    // ──────────────────────────────────────────────────────────────────────────
    console.log('--- [2/5] Testing Authenticated Seller Profile Retrieval ---');
    const getRes = await requestApi('GET', '/api/v1/sellers/me', tokenSeller1);
    assert(getRes.status === 200, 'GET /api/v1/sellers/me returns 200 OK');
    assert(getRes.body.data?.user?.firstName === 'أحمد', 'Returns authentic first name', getRes.body.data?.user?.firstName);
    assert(getRes.body.data?.user?.lastName === 'التاجر', 'Returns authentic last name', getRes.body.data?.user?.lastName);
    assert(getRes.body.data?.user?.email === emailSeller1, 'Returns authentic seller email', getRes.body.data?.user?.email);
    assert(getRes.body.data?.user?.phone === phoneSeller1, 'Returns authentic seller phone', getRes.body.data?.user?.phone);
    assert(getRes.body.data?.user?.isVerified === true, 'Returns correct verification status');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: Valid Names Update
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- [3/5] Testing First Name & Last Name Updates ---');
    const namesRes = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, {
      firstName: '  محمد  ',
      lastName: '  اليماني  ',
    });

    assert(namesRes.status === 200, 'PATCH /api/v1/sellers/me names returns 200');
    assert(namesRes.body.data?.user?.firstName === 'محمد', 'First name trimmed and updated');
    assert(namesRes.body.data?.user?.lastName === 'اليماني', 'Last name trimmed and updated');

    const dbUserAfter = await prisma.user.findUnique({ where: { id: testSellerUserId1 } });
    assert(dbUserAfter?.firstName === 'محمد', 'First name persisted to database');
    assert(dbUserAfter?.lastName === 'اليماني', 'Last name persisted to database');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: Validation & Conflict Rejections
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- [4/5] Testing Input Validation & Conflict Handling ---');
    const emptyFirst = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { firstName: '   ' });
    assert(emptyFirst.status === 400, 'Empty first name rejected with 400');

    const shortFirst = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { firstName: 'A' });
    assert(shortFirst.status === 400, 'Single-character first name rejected with 400');

    const emptyLast = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { lastName: '   ' });
    assert(emptyLast.status === 400, 'Empty last name rejected with 400');

    const invalidEmail = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { email: 'bad-email' });
    assert(invalidEmail.status === 400, 'Invalid email format rejected with 400');

    const invalidPhone = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { phone: '123' });
    assert(invalidPhone.status === 400, 'Short phone number rejected with 400');

    const dupEmail = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { email: emailSeller2 });
    assert(dupEmail.status === 409, 'Duplicate email conflict rejected with 409 Conflict');

    const dupPhone = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, { phone: phoneSeller2 });
    assert(dupPhone.status === 409, 'Duplicate phone conflict rejected with 409 Conflict');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: Email & Phone Changes with Verification Workflow
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- [5/5] Testing Verification Workflow for Contact Changes ---');
    const newUnverifiedEmail = `unverified_${timestamp}@souqnaa.test`;
    const unverifiedRes = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, {
      email: newUnverifiedEmail,
      isVerified: true, // Malicious client attempt to bypass verification
    });

    assert(unverifiedRes.status === 200, 'Unverified email update accepted');
    assert(unverifiedRes.body.data?.user?.email === newUnverifiedEmail, 'Email value changed');
    assert(unverifiedRes.body.data?.user?.isVerified === false, 'Cannot bypass verification; isVerified is false');

    const dbUnverified = await prisma.user.findUnique({ where: { id: testSellerUserId1 } });
    assert(dbUnverified?.isVerified === false, 'Database confirms isVerified = false for unverified change');

    // OTP Token Verified Email
    const newVerifiedEmail = `verified_${timestamp}@souqnaa.test`;
    await redis.set(`otp_verified:${newVerifiedEmail}`, '1', 300);

    const verifiedRes = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, {
      email: newVerifiedEmail,
    });

    assert(verifiedRes.status === 200, 'Verified email update accepted');
    assert(verifiedRes.body.data?.user?.email === newVerifiedEmail, 'Verified email matches');
    assert(verifiedRes.body.data?.user?.isVerified === true, 'isVerified = true granted from authoritative OTP token in Redis');

    // Valid Phone Update
    const newPhone = `+967775${timestamp.toString().slice(-6)}`;
    const phoneRes = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, {
      phone: newPhone,
    });
    assert(phoneRes.status === 200, 'Valid phone update accepted');
    assert(phoneRes.body.data?.user?.phone === newPhone, 'Phone number updated');

    // Cross-user IDOR prevention (Client-supplied sellerId is ignored)
    const idorRes = await requestApi('PATCH', '/api/v1/sellers/me', tokenSeller1, {
      sellerId: testSellerUserId2,
      userId: testSellerUserId2,
      firstName: 'تحديث_آمن',
    });
    assert(idorRes.status === 200, 'Request processed');
    const s2After = await prisma.user.findUnique({ where: { id: testSellerUserId2 } });
    assert(s2After?.firstName === 'سالم', 'Other seller was NOT updated by client-supplied ID');
    const s1After = await prisma.user.findUnique({ where: { id: testSellerUserId1 } });
    assert(s1After?.firstName === 'تحديث_آمن', 'Authenticated seller self-updated safely');

    // Customer forbidden
    const custRes = await requestApi('GET', '/api/v1/sellers/me', tokenCustomer);
    assert(custRes.status === 403, 'Customer role forbidden from seller endpoint with 403 Forbidden');

  } catch (error) {
    console.error('Fatal test error:', error);
    failed++;
  } finally {
    server.close();
    console.log('\n--- Cleaning up test records ---');
    await prisma.store.deleteMany({ where: { slug: { contains: timestamp.toString() } } }).catch(() => {});
    await prisma.sellerBalance.deleteMany({ where: { seller: { userId: { in: [testSellerUserId1, testSellerUserId2] } } } }).catch(() => {});
    await prisma.seller.deleteMany({ where: { userId: { in: [testSellerUserId1, testSellerUserId2] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [testSellerUserId1, testSellerUserId2, testCustomerId] } } }).catch(() => {});
  }

  console.log('\n===============================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSellerProfileTests();
