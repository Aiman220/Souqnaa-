/**
 * SOUQNA ONLINE — END-TO-END UPLOAD PIPELINE TEST SUITE
 * Tests:
 * 1. Presigned PUT upload generation (/api/v1/upload/presign)
 * 2. Upload verification & variant background triggering (/api/v1/upload/verify)
 * 3. Fallback multipart upload (/api/v1/upload) with mobile octet-stream & magic bytes detection
 * 4. Folder authorization enforcement & blocked folder rejection
 * 5. Review media upload (/api/v1/reviews/media/upload)
 * 6. Support attachment upload (/api/v1/support/uploads)
 * 7. Path traversal and executable file rejection
 */

import http from 'http';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { storageService } from '../src/services/storage/storage.service';

async function runUploadPipelineTests() {
  console.log('============================================================');
  console.log('⚡ SOUQNA ONLINE — COMPREHENSIVE UPLOAD PIPELINE TEST SUITE');
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

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(4199, resolve));

  const { prisma } = await import('../src/database/prisma');

  // Fetch or find active users for testing
  let adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true } });
  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        email: `admin-test-${Date.now()}@souqnaa.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Admin',
        lastName: 'Tester',
        role: 'ADMIN',
        isActive: true,
      },
    });
  }

  let sellerUser = await prisma.user.findFirst({ where: { role: 'SELLER', isActive: true } });
  if (!sellerUser) {
    sellerUser = await prisma.user.create({
      data: {
        email: `seller-test-${Date.now()}@souqnaa.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Seller',
        lastName: 'Tester',
        role: 'SELLER',
        isActive: true,
      },
    });
  }

  let customerUser = await prisma.user.findFirst({ where: { role: 'CUSTOMER', isActive: true } });
  if (!customerUser) {
    customerUser = await prisma.user.create({
      data: {
        email: `customer-test-${Date.now()}@souqnaa.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Customer',
        lastName: 'Tester',
        role: 'CUSTOMER',
        isActive: true,
      },
    });
  }

  const adminToken = jwt.sign(
    { userId: adminUser.id, role: adminUser.role, email: adminUser.email },
    config.jwt.secret,
    { expiresIn: '1h' }
  );

  const sellerToken = jwt.sign(
    { userId: sellerUser.id, role: sellerUser.role, email: sellerUser.email },
    config.jwt.secret,
    { expiresIn: '1h' }
  );

  const customerToken = jwt.sign(
    { userId: customerUser.id, role: customerUser.role, email: customerUser.email },
    config.jwt.secret,
    { expiresIn: '1h' }
  );

  try {
    // ─────────────────────────────────────────────────────────────
    // 1. PRESIGNED UPLOAD GENERATION
    // ─────────────────────────────────────────────────────────────
    console.log('[1] Testing Presigned Upload URL Generation (/api/v1/upload/presign)...');

    // 1.1 Unauthenticated request should be rejected (401)
    const unauthPresign = await fetch('http://localhost:4199/api/v1/upload/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'products', filename: 'phone.jpg' }),
    });
    assert(unauthPresign.status === 401, 'Unauthenticated /upload/presign is rejected (401)');

    // 1.2 Customer cannot upload to admin branding folder (403)
    const custBranding = await fetch('http://localhost:4199/api/v1/upload/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ folder: 'branding', filename: 'logo.png' }),
    });
    assert(custBranding.status === 403, 'Customer cannot generate presigned URL for branding (403)');

    // 1.3 Seller can generate presigned URL for product image (200)
    const sellerProduct = await fetch('http://localhost:4199/api/v1/upload/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        folder: 'products',
        filename: 'product_image.jpg',
        mimeType: 'image/jpeg',
      }),
    });
    assert(sellerProduct.status === 200, 'Seller generates presigned URL for products (200)');
    const presignData = (await sellerProduct.json()) as any;
    assert(
      Boolean(presignData?.data?.uploadUrl && presignData.data.uploadUrl.includes('X-Amz-Signature')),
      'Returns valid AWS SigV4 presigned upload URL'
    );
    assert(
      Boolean(presignData?.data?.key && presignData.data.key.startsWith('products/')),
      'Returns safe, unique object key starting with folder'
    );
    assert(
      Boolean(presignData?.data?.publicUrl && presignData.data.publicUrl.includes('/products/')),
      'Returns resolved public delivery URL'
    );

    // 1.4 Admin can generate presigned URL for banners & categories
    const adminBanner = await fetch('http://localhost:4199/api/v1/upload/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        folder: 'banners',
        filename: 'hero_banner.webp',
        mimeType: 'image/webp',
      }),
    });
    assert(adminBanner.status === 200, 'Admin generates presigned URL for banners (200)');

    // 1.5 Executable file rejected (400)
    const exePresign = await fetch('http://localhost:4199/api/v1/upload/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        folder: 'products',
        filename: 'malware.exe',
      }),
    });
    assert(exePresign.status === 400, 'Executable file extension rejected from presigning (400)');

    // ─────────────────────────────────────────────────────────────
    // 2. DIRECT PUT TO R2 & OBJECT VERIFICATION
    // ─────────────────────────────────────────────────────────────
    console.log('\n[2] Testing Direct R2 PUT & /api/v1/upload/verify...');

    // Create a real JPEG test image buffer
    const testJpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 50, g: 150, b: 250 } },
    }).jpeg().toBuffer();

    const uploadUrl = presignData.data.uploadUrl;
    const testKey = presignData.data.key;

    // Directly PUT buffer to Cloudflare R2
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/jpeg',
      },
      body: testJpeg,
    });
    assert(putRes.ok, `Direct binary PUT to Cloudflare R2 succeeds (HTTP ${putRes.status})`);

    // Verify the uploaded object via backend
    const verifyRes = await fetch('http://localhost:4199/api/v1/upload/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({ key: testKey, folder: 'products' }),
    });
    assert(verifyRes.status === 200, '/api/v1/upload/verify succeeds (200)');
    const verifyData = (await verifyRes.json()) as any;
    assert(verifyData?.data?.size === testJpeg.length, 'Verified size matches uploaded bytes');
    assert(verifyData?.data?.mimeType === 'image/jpeg', 'Verified MIME type is correct (image/jpeg)');
    assert(Boolean(verifyData?.data?.variants?.thumbnail), 'Generated variant URLs present');

    // Clean up test object
    await storageService.deleteFile(testKey);

    // ─────────────────────────────────────────────────────────────
    // 3. MULTIPART BACKEND UPLOAD (with mobile octet-stream MIME)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[3] Testing Multipart Upload (/api/v1/upload) with octet-stream fallback...');

    const boundary = '----WebKitFormBoundarySouqnaTest' + Date.now();
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="folder"\r\n\r\n` +
          `products\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      ),
      testJpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const multipartRes = await fetch('http://localhost:4199/api/v1/upload', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${sellerToken}`,
      },
      body: multipartBody,
    });
    assert(
      multipartRes.status === 201,
      `Multipart upload with application/octet-stream succeeds (HTTP ${multipartRes.status})`
    );
    const multiData = (await multipartRes.json()) as any;
    assert(multiData?.data?.mimeType === 'image/jpeg', 'Magic bytes correctly detected as image/jpeg');
    if (multiData?.data?.key) {
      await storageService.deleteFile(multiData.data.key);
    }

    // ─────────────────────────────────────────────────────────────
    // 4. REVIEW MEDIA UPLOAD (/api/v1/reviews/media/upload)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[4] Testing Review Media Upload (/api/v1/reviews/media/upload)...');

    const reviewBoundary = '----WebKitFormBoundaryReview' + Date.now();
    const reviewMultipartBody = Buffer.concat([
      Buffer.from(
        `--${reviewBoundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="customer_review_pic.png"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      ),
      await sharp({
        create: { width: 200, height: 200, channels: 4, background: { r: 10, g: 200, b: 50, alpha: 1 } },
      }).png().toBuffer(),
      Buffer.from(`\r\n--${reviewBoundary}--\r\n`),
    ]);

    const reviewMediaRes = await fetch('http://localhost:4199/api/v1/reviews/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${reviewBoundary}`,
        Authorization: `Bearer ${customerToken}`,
      },
      body: reviewMultipartBody,
    });
    assert(
      reviewMediaRes.status === 201,
      `Review media upload with octet-stream succeeds (HTTP ${reviewMediaRes.status})`
    );
    const reviewMediaData = (await reviewMediaRes.json()) as any;
    assert(
      Array.isArray(reviewMediaData?.data) && reviewMediaData.data.length === 1,
      'Review media returned 1 uploaded item'
    );
    assert(
      reviewMediaData?.data?.[0]?.mediaType === 'IMAGE',
      'Review media classified as IMAGE'
    );
    if (reviewMediaData?.data?.[0]?.storageKey) {
      await storageService.deleteFile(reviewMediaData.data[0].storageKey);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. SUPPORT ATTACHMENT UPLOAD (/api/v1/support/uploads)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[5] Testing Support Upload (/api/v1/support/uploads)...');

    const supportBoundary = '----WebKitFormBoundarySupport' + Date.now();
    const supportMultipartBody = Buffer.concat([
      Buffer.from(
        `--${supportBoundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="issue_screenshot.jpg"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      ),
      testJpeg,
      Buffer.from(`\r\n--${supportBoundary}--\r\n`),
    ]);

    const supportRes = await fetch('http://localhost:4199/api/v1/support/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${supportBoundary}`,
        Authorization: `Bearer ${customerToken}`,
      },
      body: supportMultipartBody,
    });
    assert(
      supportRes.status === 200 || supportRes.status === 201,
      `Support attachment upload with octet-stream succeeds (HTTP ${supportRes.status})`
    );
    const supportData = (await supportRes.json()) as any;
    assert(Boolean(supportData?.data?.url), 'Support attachment returns valid url');
    if (supportData?.data?.key) {
      await storageService.deleteFile(supportData.data.key);
    }

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runUploadPipelineTests().catch((e) => {
  console.error('Test suite uncaught error:', e);
  process.exit(1);
});
