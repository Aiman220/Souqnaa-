import crypto from 'crypto';
import { redis } from '../../database/redis';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { smtpEmailProvider } from '../notifications/providers/email.provider';
import { smsNotificationProvider } from '../notifications/providers/sms.provider';
import { LocaleCode } from '../notifications/templates/email-templates';

export interface SendOtpOptions {
  target: string; // Email or Phone number
  type: string;
  locale?: LocaleCode;
  correlationId?: string;
}

export class OtpService {
  private static instance: OtpService;

  public static get(): OtpService {
    if (!OtpService.instance) {
      OtpService.instance = new OtpService();
    }
    return OtpService.instance;
  }

  /**
   * Normalizes targets: emails to lowercase, Yemen phone numbers to +967XXXXXXXXX format.
   */
  public normalizeTarget(target: string): string {
    const trimmed = (target || '').trim();
    if (trimmed.includes('@')) {
      return trimmed.toLowerCase();
    }
    let digits = trimmed.replace(/[^\d+]/g, '');
    if (digits.startsWith('+967')) {
      return digits;
    }
    if (digits.startsWith('00967')) {
      return `+967${digits.slice(5)}`;
    }
    if (digits.startsWith('967') && digits.length > 9) {
      return `+${digits}`;
    }
    if (digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    if (digits.startsWith('+')) {
      digits = digits.slice(1);
    }
    return `+967${digits}`;
  }

  /**
   * Validates Yemen mobile phone structure (+967 70/71/73/77/78 XXXXXXX)
   */
  public isValidYemenMobile(phone: string): boolean {
    const clean = this.normalizeTarget(phone);
    return /^\+967(70|71|73|77|78)\d{7}$/.test(clean);
  }

  /**
   * Generates, stores, and dispatches an OTP code via the Notification Provider abstraction (SMS or Email).
   */
  async generateAndSendOtp(options: SendOtpOptions): Promise<{ sent: boolean; cooldownSeconds?: number }> {
    const { target, type, locale = 'ar', correlationId } = options;
    const cleanTarget = this.normalizeTarget(target);
    const isEmail = cleanTarget.includes('@');

    // 1. Validate Target Phone or Email Format
    if (!isEmail) {
      if (!this.isValidYemenMobile(cleanTarget)) {
        throw new AppError(
          locale === 'ar'
            ? 'رقم الهاتف غير صالح. يرجى إدخال رقم يمني صحيح (9 أرقام يبدأ بـ 70, 71, 73, 77 أو 78).'
            : 'Invalid phone number. Please enter a valid Yemen mobile number (9 digits starting with 70, 71, 73, 77, or 78).',
          400,
          'INVALID_PHONE_NUMBER'
        );
      }
    }

    // 2. Enforce resend cooldown (e.g. 60 seconds)
    const cooldownKey = `otp_cooldown:${type}:${cleanTarget}`;
    const inCooldown = await redis.get(cooldownKey);
    if (inCooldown) {
      const ttl = await redis.ttl(cooldownKey);
      throw new AppError(
        locale === 'ar'
          ? `تجاوزت الحد المسموح لإعادة إرسال الرمز. يرجى الانتظار ${ttl > 0 ? ttl : 60} ثانية.`
          : `Rate limit exceeded. Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new code.`,
        429,
        'OTP_COOLDOWN_ACTIVE'
      );
    }

    // 3. Generate 6-digit OTP code (cryptographically secure)
    const code = this.generateCode();
    const expirySeconds = parseInt(process.env.OTP_EXPIRY_SECONDS || '600', 10); // 10 minutes default
    const cooldownSeconds = parseInt(process.env.OTP_COOLDOWN_SECONDS || '60', 10);

    // 4. Store in Redis using the existing repository convention `otp:${type}:${target}`
    await redis.set(`otp:${type}:${cleanTarget}`, code, expirySeconds);
    await redis.set(cooldownKey, '1', cooldownSeconds);

    // Redact OTP code in server logs for security compliance
    const safeTarget = cleanTarget.includes('@')
      ? cleanTarget.replace(/(?<=.{3}).(?=.*@)/g, '*')
      : cleanTarget.replace(/\d(?=\d{3})/g, '*');
    console.log(`[OTP Service] Stored OTP for ${safeTarget} (${type}): [REDACTED] (TTL: ${expirySeconds}s) | Corr: ${correlationId || 'none'}`);

    // 5. Dispatch via Notification Provider Abstraction
    if (isEmail) {
      const templateKey = type === 'reset_password' ? 'PASSWORD_RESET' : 'EMAIL_VERIFICATION';
      await smtpEmailProvider.sendTemplate(cleanTarget, templateKey, locale, {
        email: cleanTarget,
        otpCode: code,
      });
    } else {
      const delivery = await smsNotificationProvider.sendOtpSms(cleanTarget, code, locale, correlationId);
      if (!delivery.success) {
        // Rollback stored OTP and cooldown on dispatch failure
        await Promise.all([
          redis.del(`otp:${type}:${cleanTarget}`),
          redis.del(cooldownKey),
        ]);

        // Map provider error code to specific localized Arabic error message
        const errCode = delivery.errorCode || 'PROVIDER_UNAVAILABLE';
        if (errCode === 'TIMEOUT') {
          throw new AppError(
            locale === 'ar'
              ? 'انتهت مهلة الاتصال، يرجى المحاولة مجدداً.'
              : 'Connection timed out. Please try again.',
            504,
            'SMS_GATEWAY_TIMEOUT'
          );
        }
        if (errCode === 'INVALID_PHONE') {
          throw new AppError(
            locale === 'ar'
              ? 'رقم الهاتف غير صالح.'
              : 'Invalid phone number.',
            400,
            'INVALID_PHONE_NUMBER'
          );
        }
        if (errCode === 'DESTINATION_UNSUPPORTED') {
          throw new AppError(
            locale === 'ar'
              ? 'تعذر إرسال الرمز إلى هذا الرقم.'
              : 'Unable to deliver verification code to this phone number.',
            400,
            'DESTINATION_UNSUPPORTED'
          );
        }
        if (errCode === 'RATE_LIMITED') {
          throw new AppError(
            locale === 'ar'
              ? 'تجاوزت الحد المسموح لإعادة إرسال الرمز.'
              : 'Rate limit exceeded for SMS sending.',
            429,
            'OTP_RATE_LIMITED'
          );
        }

        // Generic gateway or service connection failure
        throw new AppError(
          locale === 'ar'
            ? 'تعذر الاتصال بخدمة إرسال الرسائل.'
            : 'Unable to connect to SMS delivery service.',
          503,
          'SMS_SERVICE_UNAVAILABLE'
        );
      }
    }

    return { sent: true, cooldownSeconds };
  }

  /**
   * Verifies the submitted OTP against Redis.
   */
  async verifyOtp(target: string, code: string, type: string, locale: LocaleCode = 'ar'): Promise<boolean> {
    const cleanTarget = this.normalizeTarget(target);
    const key = `otp:${type}:${cleanTarget}`;
    const stored = await redis.get(key);

    const attemptsKey = `otp_attempts:${type}:${cleanTarget}`;
    const attempts = parseInt((await redis.get(attemptsKey)) || '0', 10);
    const MAX_OTP_ATTEMPTS = 5;

    if (attempts >= MAX_OTP_ATTEMPTS) {
      await redis.del(key);
      throw new AppError(
        locale === 'ar'
          ? 'تجاوزت الحد المسموح لإعادة إرسال الرمز. يرجى طلب رمز جديد.'
          : 'Maximum OTP verification attempts exceeded. Please request a new code.',
        429,
        'OTP_MAX_ATTEMPTS_EXCEEDED'
      );
    }

    // Check dev bypass code ONLY in local development when explicitly permitted
    const isLocalDev = process.env.NODE_ENV === 'development';
    const allowDevBypass = process.env.ALLOW_OTP_DEV_BYPASS === 'true';
    const devCode = (isLocalDev && allowDevBypass) ? (process.env.OTP_DEV_BYPASS_CODE || '123456') : null;
    const isDevMatch = Boolean(devCode && code === devCode);

    if (!stored && !isDevMatch) {
      throw new AppError(
        locale === 'ar'
          ? 'رمز التحقق منتهي الصلاحية أو غير صحيح. يرجى طلب رمز جديد.'
          : 'Invalid or expired OTP code. Please request a new code.',
        400,
        'OTP_EXPIRED_OR_INVALID'
      );
    }

    if (stored && stored !== code && !isDevMatch) {
      const currentAttempts = await redis.incr(attemptsKey);
      if (currentAttempts === 1) {
        await redis.expire(attemptsKey, 600);
      }
      const remainingAttempts = Math.max(0, MAX_OTP_ATTEMPTS - currentAttempts);
      if (remainingAttempts === 0) {
        await redis.del(key);
        throw new AppError(
          locale === 'ar'
            ? 'تجاوزت الحد المسموح لإعادة إرسال الرمز وتم إبطال الرمز. يرجى طلب رمز جديد.'
            : 'Maximum verification attempts exceeded. Code invalidated.',
          429,
          'OTP_ATTEMPTS_EXCEEDED'
        );
      }
      throw new AppError(
        locale === 'ar'
          ? `رمز التحقق غير صحيح. المحاولات المتبقية: ${remainingAttempts}`
          : `Invalid verification code. Remaining attempts: ${remainingAttempts}`,
        400,
        'INVALID_OTP'
      );
    }

    // Clear OTP and attempt counter after successful verification to prevent replay attacks
    await redis.del(key);
    await redis.del(attemptsKey);
    await redis.del(`otp_cooldown:${type}:${cleanTarget}`);

    // Automatically mark user verified if this was a verification OTP
    if (type === 'verification' || type === 'phone' || type === 'email') {
      await prisma.user.updateMany({
        where: { OR: [{ email: cleanTarget.toLowerCase() }, { phone: cleanTarget }] },
        data: { isVerified: true },
      });
      // Store verified OTP token in Redis for 15 minutes to authorize email/phone profile updates
      await redis.set(`otp_verified:${cleanTarget.toLowerCase()}`, '1', 900);
      await redis.set(`otp_verified:${cleanTarget}`, '1', 900);

      // If verifying phone, record permanent verification flag in Redis (1 year TTL)
      if (type === 'phone' || !cleanTarget.includes('@')) {
        await redis.set(`phone_verified:${cleanTarget}`, '1', 31536000);
      }
    }

    return true;
  }

  /**
   * Password reset OTP dispatch
   */
  async sendPasswordResetOtp(email: string, locale: LocaleCode = 'ar'): Promise<void> {
    const cleanEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });

    if (user) {
      const code = this.generateCode();
      const expiry = parseInt(process.env.PASSWORD_RESET_EXPIRY_SECONDS || '900', 10); // 15 mins
      await redis.set(`pwd_reset:${cleanEmail}`, code, expiry);

      console.log(`[Password Reset] Dispatched reset code for ${cleanEmail.replace(/(?<=.{2}).(?=.*@)/g, '*')}: [REDACTED]`);

      await smtpEmailProvider.sendTemplate(cleanEmail, 'PASSWORD_RESET', locale, {
        email: cleanEmail,
        name: `${user.firstName} ${user.lastName}`.trim(),
        otpCode: code,
      });
    }
  }

  /**
   * Generates secure 6-digit numeric code
   */
  private generateCode(): string {
    if (process.env.NODE_ENV === 'test' && process.env.OTP_TEST_STATIC_CODE) {
      return process.env.OTP_TEST_STATIC_CODE;
    }
    const num = crypto.randomInt(100000, 999999);
    return num.toString();
  }
}

export const otpService = OtpService.get();
