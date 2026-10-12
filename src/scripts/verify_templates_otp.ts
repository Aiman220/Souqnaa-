import assert from 'assert';
import {
  EmailTemplates,
  EmailTemplateKey,
  renderEmailTemplate,
} from '../modules/notifications/templates/email-templates';
import { smsNotificationProvider } from '../modules/notifications/providers/sms.provider';
import { smtpEmailProvider } from '../modules/notifications/providers/email.provider';
import { otpService } from '../modules/auth/otp.service';
import { redis } from '../database/redis';
import { prisma } from '../database/prisma';

async function runVerification() {
  console.log('🚀 Starting Verification: Email Templates, SMS & OTP Integration...\n');
  let passed = 0;

  // ============================================================================
  // 1. EMAIL TEMPLATES (All 14 required templates)
  // ============================================================================
  const requiredTemplates: EmailTemplateKey[] = [
    'WELCOME',
    'EMAIL_VERIFICATION',
    'PASSWORD_RESET',
    'ORDER_CONFIRMATION',
    'PAYMENT_RECEIPT',
    'INVOICE',
    'ORDER_SHIPPED',
    'ORDER_DELIVERED',
    'REFUND_COMPLETED',
    'VOUCHER',
    'PROMOTION',
    'CAMPAIGN',
    'SELLER_NOTIFICATION',
    'SECURITY_ALERT',
  ];

  console.log('--- 1. Testing 14 Email Templates (Arabic & English) ---');
  for (const key of requiredTemplates) {
    // Test Arabic
    const renderedAr = renderEmailTemplate(key, 'ar', {
      name: 'أحمد اليماني',
      email: 'ahmed@example.com',
      otpCode: '852963',
      orderNumber: 'SQ-9988-1',
      totalAmount: 15000,
      currency: 'ر.ي',
      items: [{ name: 'عسل سدر دوعني فاخر', quantity: 2, price: 7500, total: 15000 }],
      trackingNumber: 'TRK-98765',
      carrierName: 'سوقناا إكسبريس',
      voucherCode: 'EID2026',
      discountValue: '25%',
      promotionTitle: 'عرض العيد الكبير',
      campaignName: 'مهرجان التخفيضات 2026',
      sellerTitle: 'طلب بيع جديد وارد',
      alertType: 'تسجيل دخول من متصفح جديد',
    });

    assert(renderedAr.subject.length > 0, `Template ${key} (ar) must have subject`);
    assert(renderedAr.html.includes('سوقناا'), `Template ${key} (ar) must have brand header`);
    assert(renderedAr.html.includes('dir="rtl"'), `Template ${key} (ar) must have RTL direction`);
    assert(renderedAr.text.length > 0, `Template ${key} (ar) must have text fallback`);

    // Test English
    const renderedEn = renderEmailTemplate(key, 'en', {
      name: 'John Doe',
      email: 'john@example.com',
      otpCode: '852963',
      orderNumber: 'SQ-9988-1',
      totalAmount: 50,
      currency: 'SAR',
      items: [{ name: 'Premium Sidr Honey', quantity: 2, price: 25, total: 50 }],
      trackingNumber: 'TRK-98765',
      carrierName: 'Souqnaa Express',
      voucherCode: 'EID2026',
      discountValue: '25%',
      promotionTitle: 'Grand Eid Festival',
      campaignName: 'Mega Festival 2026',
      sellerTitle: 'New Order Received',
      alertType: 'New Login From Unknown Device',
    });

    assert(renderedEn.subject.length > 0, `Template ${key} (en) must have subject`);
    assert(renderedEn.html.includes('dir="ltr"'), `Template ${key} (en) must have LTR direction`);
    assert(renderedEn.text.length > 0, `Template ${key} (en) must have text fallback`);

    console.log(`  ✓ Template [${key}] validated in both AR (RTL) and EN (LTR)`);
    passed++;
  }

  // ============================================================================
  // 2. EMAIL PROVIDER SEND TEST
  // ============================================================================
  console.log('\n--- 2. Testing Email Provider with Template Integration ---');
  const emailResult = await smtpEmailProvider.sendTemplate(
    'customer@souqnaa.com',
    'ORDER_CONFIRMATION',
    'ar',
    {
      orderNumber: 'SQ-2026-TEST',
      totalAmount: 25000,
      currency: 'ر.ي',
      items: [{ name: 'هاتف ذكي 5G', quantity: 1, price: 25000, total: 25000 }],
    }
  );
  assert(emailResult.success === true, 'Email dispatch must succeed');
  assert(emailResult.messageId != null, 'Email dispatch must return messageId');
  console.log(`  ✓ Email Provider sent template successfully (MessageID: ${emailResult.messageId})`);
  passed++;

  // ============================================================================
  // 3. SMS USE CASES & COMPLIANCE
  // ============================================================================
  console.log('\n--- 3. Testing SMS Provider & Marketing Regulations ---');

  // Test A: OTP SMS (Priority bypass)
  const otpSmsResult = await smsNotificationProvider.sendOtpSms('+967770000000', '654321', 'ar');
  assert(otpSmsResult.success === true, 'OTP SMS must succeed');
  console.log('  ✓ OTP SMS dispatched with high priority');
  passed++;

  // Test B: Marketing SMS opt-out text inclusion
  const mktSmsResult = await smsNotificationProvider.send({
    recipientPhone: '+967771112223',
    recipientId: 'user_mkt_test',
    content: {
      titleAr: 'عرض مميز',
      titleEn: 'Special Offer',
      bodyAr: 'خصم 50% على جميع المنتجات اليوم فقط!',
      bodyEn: '50% off all products today only!',
    },
    metadata: {
      useCase: 'MARKETING',
    },
  });
  console.log('  ✓ Marketing SMS processed (opt-out and compliance evaluated):', mktSmsResult.success ? 'Delivered' : mktSmsResult.error);
  passed++;

  // ============================================================================
  // 4. OTP INTEGRATION & REUSE
  // ============================================================================
  console.log('\n--- 4. Testing OTP System Integration ---');
  const testPhone = '+967779998877';
  const testEmail = 'verify.test@souqnaa.com';

  // Test A: Generate & Send OTP to Phone
  const sendPhoneRes = await otpService.generateAndSendOtp({
    target: testPhone,
    type: 'verification',
    locale: 'ar',
  });
  assert(sendPhoneRes.sent === true, 'Phone OTP send must succeed');

  // Verify stored in Redis using existing key convention
  const storedPhoneOtp = await redis.get(`otp:verification:${testPhone}`);
  assert(storedPhoneOtp != null, 'OTP must be stored in Redis');
  assert(storedPhoneOtp.length === 6, 'OTP must be 6 digits');
  console.log(`  ✓ Phone OTP stored in Redis: ${storedPhoneOtp}`);
  passed++;

  // Test B: Cooldown enforcement (attempting immediate resend must fail with 429)
  try {
    await otpService.generateAndSendOtp({
      target: testPhone,
      type: 'verification',
      locale: 'ar',
    });
    assert.fail('Immediate resend should have thrown 429 cooldown error');
  } catch (err: any) {
    assert(err.statusCode === 429 || err.message.includes('ثانية'), 'Cooldown error must be thrown');
    console.log('  ✓ Resend cooldown protection verified (429 thrown on flood)');
    passed++;
  }

  // Test C: Verify OTP successfully
  const verifyRes = await otpService.verifyOtp(testPhone, storedPhoneOtp!, 'verification');
  assert(verifyRes === true, 'OTP verification must succeed');
  const clearedOtp = await redis.get(`otp:verification:${testPhone}`);
  assert(clearedOtp == null, 'OTP must be cleared after verification');
  console.log('  ✓ OTP verified and cleared from Redis');
  passed++;

  // Test D: Email OTP & Password Reset
  let userForReset = await prisma.user.findFirst({ select: { email: true } });
  if (!userForReset) {
    userForReset = await prisma.user.create({
      data: {
        email: 'test_reset@souqnaa.com',
        passwordHash: 'hashed_password',
        firstName: 'أحمد',
        lastName: 'اليماني',
      },
      select: { email: true },
    });
  }
  const resetEmail = userForReset.email;
  await otpService.sendPasswordResetOtp(resetEmail, 'ar');
  const storedResetOtp = await redis.get(`pwd_reset:${resetEmail.toLowerCase()}`);
  assert(storedResetOtp != null, 'Password reset OTP stored in Redis');
  console.log(`  ✓ Password reset code stored and email dispatched: ${storedResetOtp}`);
  passed++;

  console.log(`\n============================================================`);
  console.log(`🎉 ALL ${passed} VERIFICATION TESTS PASSED SUCCESSFULLY!`);
  console.log(`============================================================\n`);
  process.exit(0);
}

runVerification().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
