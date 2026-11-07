import { UrlSecurityUtil } from '../src/utils/url-security.util';

async function runUrlSecurityTests() {
  console.log('==================================================================');
  console.log('🧪 SOUQNA SSRF & URL SECURITY VALIDATION TEST SUITE');
  console.log('==================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. Cloud Metadata IP (AWS/GCP/OpenStack)
  assert(
    !UrlSecurityUtil.isSafeUrl('http://169.254.169.254/latest/meta-data/'),
    'Blocks AWS/cloud metadata IP (169.254.169.254)'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('http://169.254.1.1/secret'),
    'Blocks link-local IP range (169.254.x.x)'
  );

  // 2. Loopback & Localhost
  assert(
    !UrlSecurityUtil.isSafeUrl('http://localhost:3000/api/keys'),
    'Blocks localhost'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('http://127.0.0.1:5432/db'),
    'Blocks 127.0.0.1 loopback'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('http://0.0.0.0/internal'),
    'Blocks 0.0.0.0'
  );

  // 3. RFC 1918 Private Subnets
  assert(
    !UrlSecurityUtil.isSafeUrl('http://10.0.1.5/admin'),
    'Blocks 10.x.x.x private network'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('http://192.168.1.100/router'),
    'Blocks 192.168.x.x private network'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('http://172.20.0.5/docker'),
    'Blocks 172.16-31.x.x private network'
  );

  // 4. Non-HTTP Schemes
  assert(
    !UrlSecurityUtil.isSafeUrl('javascript:alert(1)'),
    'Blocks javascript: URI scheme'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('file:///etc/passwd'),
    'Blocks file: URI scheme'
  );
  assert(
    !UrlSecurityUtil.isSafeUrl('gopher://internal.lan/'),
    'Blocks gopher: URI scheme'
  );

  // 5. Valid Safe URLs
  assert(
    UrlSecurityUtil.isSafeUrl('https://storage.souqnaa.com/refunds/receipt.png'),
    'Allows legitimate HTTPS storage CDN URL'
  );
  assert(
    UrlSecurityUtil.isSafeUrl('http://pub-r2.souqnaa.com/evidence/doc.pdf'),
    'Allows legitimate HTTP public CDN URL'
  );
  assert(
    UrlSecurityUtil.isSafeUrl('/api/v1/storage/refunds/img_123.jpg'),
    'Allows internal relative storage path'
  );

  console.log('\n==================================================================');
  console.log(`TEST SUMMARY: Passed: ${passed} | Failed: ${failed}`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runUrlSecurityTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

