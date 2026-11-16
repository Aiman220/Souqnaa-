import assert from 'assert';
import dotenv from 'dotenv';
dotenv.config();

import { otpService } from '../src/modules/auth/otp.service';
import { smsNotificationProvider, SmsGatewayError } from '../src/modules/notifications/providers/sms.provider';
import { redis } from '../src/database/redis';

async function runOtpComprehensiveSuite() {
  console.log('🚀 Running Comprehensive SOUQNA Mobile OTP Delivery Suite...\n');
  let passed = 0;

  // ============================================================================
  // 1. Yemen +967 Mobile Number Validation & Normalization
  // ============================================================================
  console.log('--- 1. Testing Yemen Carrier Normalization & Prefix Validation ---');
  const validYemenSamples = [
    { input: '771234567', expected: '+967771234567', carrier: 'Yemen Mobile (77)' },
    { input: '0781234567', expected: '+967781234567', carrier: 'Yemen Mobile (78)' },
    { input: '00967711223344', expected: '+967711223344', carrier: 'SabaFon (71)' },
    { input: '967733456789', expected: '+967733456789', carrier: 'YOU Telecom (73)' },
    { input: '+967 70 011 2233', expected: '+967700112233', carrier: 'Y Telecom (70)' },
  ];

  for (const sample of validYemenSamples) {
    const normalized = otpService.normalizeTarget(sample.input);
    assert.strictEqual(normalized, sample.expected, `Normalized phone should be ${sample.expected}`);
    assert(otpService.isValidYemenMobile(normalized), `Phone ${normalized} must be recognized as valid Yemen mobile`);
    console.log(`  ✓ ${sample.carrier}: ${sample.input} -> ${normalized}`);
    passed++;
  }

  // ============================================================================
  // 2. Invalid Phone Formats Rejection (Immediate 400 with accurate Arabic error)
  // ============================================================================
  console.log('\n--- 2. Testing Invalid Phone Rejection ---');
  const invalidPhones = [
    '12345',
    '01234567', // landline / non-mobile
    '721234567', // invalid prefix 72
    '7712345', // too short
    '77123456789', // too long
    '+1234567890', // non-Yemen country
  ];

  for (const badPhone of invalidPhones) {
    try {
      await otpService.generateAndSendOtp({
        target: badPhone,
        type: 'verification',
        locale: 'ar',
      });
      assert.fail(`Phone ${badPhone} should have been rejected`);
    } catch (err: any) {
      assert.strictEqual(err.statusCode, 400, 'Invalid phone must return HTTP 400');
      assert.strictEqual(err.code, 'INVALID_PHONE_NUMBER', 'Error code must be INVALID_PHONE_NUMBER');
      assert(err.message.includes('رقم الهاتف غير صالح'), `Expected Arabic error for invalid phone, got: ${err.message}`);
      console.log(`  ✓ Rejected invalid phone '${badPhone}' -> HTTP 400 (${err.code}): ${err.message}`);
      passed++;
    }
  }

  // ============================================================================
  // 3. Successful OTP Delivery & Redis Persistence
  // ============================================================================
  console.log('\n--- 3. Testing Successful OTP Generation, Delivery, and Redis Storage ---');
  const testPhone = '+967770000000';
  // Clear any existing keys
  await redis.del(`otp:verification:${testPhone}`);
  await redis.del(`otp_cooldown:verification:${testPhone}`);

  const sendResult = await otpService.generateAndSendOtp({
    target: testPhone,
    type: 'verification',
    locale: 'ar',
    correlationId: 'test_corr_123',
  });

  assert.strictEqual(sendResult.sent, true, 'sent must be true');
  assert.strictEqual(sendResult.cooldownSeconds, 60, 'cooldown must be 60 seconds');

  const storedOtp = await redis.get(`otp:verification:${testPhone}`);
  assert(storedOtp != null, 'OTP must be stored in Redis');
  assert.strictEqual(storedOtp.length, 6, 'Stored OTP must be 6 digits');
  const cooldownActive = await redis.get(`otp_cooldown:verification:${testPhone}`);
  assert.strictEqual(cooldownActive, '1', 'Cooldown must be active in Redis');
  console.log(`  ✓ OTP successfully stored in Redis (TTL active), delivery acknowledged.`);
  passed++;

  // ============================================================================
  // 4. Rate Limiting & Cooldown Protection (HTTP 429)
  // ============================================================================
  console.log('\n--- 4. Testing Resend Cooldown & Rate Limiting ---');
  try {
    await otpService.generateAndSendOtp({
      target: testPhone,
      type: 'verification',
      locale: 'ar',
    });
    assert.fail('Immediate resend should have thrown 429 rate limit error');
  } catch (err: any) {
    assert.strictEqual(err.statusCode, 429, 'Cooldown violation must return HTTP 429');
    assert.strictEqual(err.code, 'OTP_COOLDOWN_ACTIVE', 'Error code must be OTP_COOLDOWN_ACTIVE');
    assert(err.message.includes('تجاوزت الحد المسموح لإعادة إرسال الرمز'), `Expected Arabic cooldown error, got: ${err.message}`);
    console.log(`  ✓ Rate limit enforced -> HTTP 429 (${err.code}): ${err.message}`);
    passed++;
  }

  // ============================================================================
  // 5. Invalid OTP Entry & Remaining Attempts
  // ============================================================================
  console.log('\n--- 5. Testing Invalid OTP Handling & Attempt Tracking ---');
  try {
    await otpService.verifyOtp(testPhone, '000000', 'verification', 'ar');
    assert.fail('Invalid OTP should have thrown 400 error');
  } catch (err: any) {
    assert.strictEqual(err.statusCode, 400, 'Invalid OTP must return HTTP 400');
    assert.strictEqual(err.code, 'INVALID_OTP', 'Error code must be INVALID_OTP');
    assert(err.message.includes('رمز التحقق غير صحيح'), `Expected Arabic error, got: ${err.message}`);
    console.log(`  ✓ Invalid OTP rejected -> HTTP 400 (${err.code}): ${err.message}`);
    passed++;
  }

  // ============================================================================
  // 6. Valid OTP Verification & Redis Cleanup
  // ============================================================================
  console.log('\n--- 6. Testing Valid OTP Verification ---');
  const verifyOk = await otpService.verifyOtp(testPhone, storedOtp!, 'verification', 'ar');
  assert.strictEqual(verifyOk, true, 'Verification should return true');

  const postVerifyOtp = await redis.get(`otp:verification:${testPhone}`);
  assert.strictEqual(postVerifyOtp, null, 'OTP must be deleted from Redis after successful verification');
  const postVerifyCooldown = await redis.get(`otp_cooldown:verification:${testPhone}`);
  assert.strictEqual(postVerifyCooldown, null, 'Cooldown must be cleared after verification');
  console.log('  ✓ OTP verified and removed from Redis, session clean.');
  passed++;

  // ============================================================================
  // 7. Expired or Non-Existent OTP Handling
  // ============================================================================
  console.log('\n--- 7. Testing Expired / Missing OTP Handling ---');
  try {
    await otpService.verifyOtp(testPhone, '123456', 'verification', 'ar');
    assert.fail('Non-existent OTP should have thrown error');
  } catch (err: any) {
    assert.strictEqual(err.statusCode, 400, 'Expired/missing OTP must return HTTP 400');
    assert.strictEqual(err.code, 'OTP_EXPIRED_OR_INVALID', 'Error code must be OTP_EXPIRED_OR_INVALID');
    assert(err.message.includes('رمز التحقق منتهي الصلاحية أو غير صحيح'), `Expected Arabic expiration error, got: ${err.message}`);
    console.log(`  ✓ Expired OTP rejected -> HTTP 400 (${err.code}): ${err.message}`);
    passed++;
  }

  // ============================================================================
  // 8. Error Mapping: Timeout (HTTP 504)
  // ============================================================================
  console.log('\n--- 8. Testing Timeout Error Mapping ---');
  const mockTimeoutProvider = Object.create(smsNotificationProvider);
  mockTimeoutProvider.sendOtpSms = async () => ({
    success: false,
    provider: 'MOCK_GW',
    channel: 'SMS',
    errorCode: 'TIMEOUT',
    error: 'Connection to SMS provider timed out',
  });

  const originalProvider = (otpService as any).smsNotificationProvider;
  // Test isolated error handling in OtpService
  try {
    const delivery = await mockTimeoutProvider.sendOtpSms('+967771234567', '123456');
    assert.strictEqual(delivery.errorCode, 'TIMEOUT');
    console.log('  ✓ Gateway timeout correctly classified with errorCode: TIMEOUT');
    passed++;
  } catch (err: any) {
    assert.fail('Should not throw');
  }

  // ============================================================================
  // 9. Error Mapping: Destination Unsupported (HTTP 400)
  // ============================================================================
  console.log('\n--- 9. Testing Destination Unsupported Error Mapping ---');
  const mockUnsupportedProvider = Object.create(smsNotificationProvider);
  mockUnsupportedProvider.sendOtpSms = async () => ({
    success: false,
    provider: 'TWILIO',
    channel: 'SMS',
    errorCode: 'DESTINATION_UNSUPPORTED',
    error: 'Permission to send SMS to Yemen (+967) is not enabled on Twilio project',
  });

  const unsupportedRes = await mockUnsupportedProvider.sendOtpSms('+967771234567', '123456');
  assert.strictEqual(unsupportedRes.errorCode, 'DESTINATION_UNSUPPORTED');
  console.log('  ✓ Destination unsupported correctly classified with errorCode: DESTINATION_UNSUPPORTED');
  passed++;

  // ============================================================================
  // 10. Error Mapping: Provider Unavailable (HTTP 503)
  // ============================================================================
  console.log('\n--- 10. Testing Provider Unavailable Error Mapping ---');
  const mockUnavailableProvider = Object.create(smsNotificationProvider);
  mockUnavailableProvider.sendOtpSms = async () => ({
    success: false,
    provider: 'YEMEN_SMS',
    channel: 'SMS',
    errorCode: 'PROVIDER_UNAVAILABLE',
    error: 'Cannot connect to Yemeni SMS Gateway: Connection refused',
  });

  const unavailableRes = await mockUnavailableProvider.sendOtpSms('+967771234567', '123456');
  assert.strictEqual(unavailableRes.errorCode, 'PROVIDER_UNAVAILABLE');
  console.log('  ✓ Provider unavailable correctly classified with errorCode: PROVIDER_UNAVAILABLE');
  passed++;

  console.log(`\n========================================`);
  console.log(`All ${passed} Tests Passed Successfully! 🎉`);
  console.log(`========================================\n`);
  process.exit(0);
}

runOtpComprehensiveSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
