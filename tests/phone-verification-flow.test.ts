import { otpService } from '../src/modules/auth/otp.service';

async function runTests() {
  console.log('🚀 Running Phone Verification Flow & Normalization Tests...');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // 1. Phone Normalization Tests
  const cases: [string, string][] = [
    ['771234567', '+967771234567'],
    ['0771234567', '+967771234567'],
    ['00967771234567', '+967771234567'],
    ['967771234567', '+967771234567'],
    ['+967771234567', '+967771234567'],
    ['+967 77 123 4567', '+967771234567'],
    ['733456789', '+967733456789'],
    ['711223344', '+967711223344'],
    ['700112233', '+967700112233'],
    ['788990011', '+967788990011'],
  ];

  for (const [input, expected] of cases) {
    const result = otpService.normalizeTarget(input);
    assert(result === expected, `Normalize Yemen phone '${input}' to '${expected}'`, `got '${result}'`);
  }

  // 2. Email Preservation Test
  const emailInput = 'Customer.Test@Example.COM ';
  const expectedEmail = 'customer.test@example.com';
  const emailResult = otpService.normalizeTarget(emailInput);
  assert(emailResult === expectedEmail, `Normalize email preserves lowercased address`, `got '${emailResult}'`);

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
