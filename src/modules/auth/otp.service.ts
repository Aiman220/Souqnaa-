import crypto from 'crypto';
import { redis } from '../../database/redis';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { smtpEmailProvider } from '../notifications/providers/email.provider';
import { smsNotificationProvider } from '../notifications/providers/sms.provider';
import { LocaleCode } from '../notifications/templates/email-templates';

export interface SendOtpOptions {
  target: string; // Email or Phone number
  type: 'verification' | 'login' | 'reset_password' | 'transaction';
  locale?: LocaleCode;
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
   * Generates, stores, and dispatches an OTP code via the Notification Provider abstraction (SMS or Email).
   */
  async generateAndSendOtp(options: SendOtpOptions): Promise<{ sent: boolean; cooldownSeconds?: number }> {
    const { target, type, locale = 'ar' } = options;
    const cleanTarget = target.trim();
    const isEmail = cleanTarget.includes('@');

    // 1. Enforce resend cooldown (e.g. 60 seconds)
    const cooldownKey = `otp_cooldown:${type}:${cleanTarget}`;
    const inCooldown = await redis.get(cooldownKey);
    if (inCooldown) {
      const ttl = await redis.ttl(cooldownKey);
      throw new AppError(
        locale === 'ar'
          ? `يرجى الانتظار ${ttl > 0 ? ttl : 60} ثانية قبل إعادة إرسال رمز جديد.`
          : `Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new code.`,
        429
      );
    }

    // 2. Generate 6-digit OTP code (cryptographically secure, with optional dev bypass)
    const code = this.generateCode();
    const expirySeconds = parseInt(process.env.OTP_EXPIRY_SECONDS || '600', 10); // 10 minutes default
    const cooldownSeconds = parseInt(process.env.OTP_COOLDOWN_SECONDS || '60', 10);

    // 3. Store in Redis using the existing repository convention `otp:${type}:${target}`
    await redis.set(`otp:${type}:${cleanTarget}`, code, expirySeconds);
    await redis.set(cooldownKey, '1', cooldownSeconds);

    // Redact OTP code in server logs for security compliance (§4, §25)
    console.log(`[OTP Service] Stored OTP for ${cleanTarget.replace(/(?<=.{3}).(?=.*@)/g, '*')} (${type}): [REDACTED] (TTL: ${expirySeconds}s)`);

    // 4. Dispatch via Notification Provider Abstraction
    if (isEmail) {
      // Send localized email via Email Provider
      const templateKey = type === 'reset_password' ? 'PASSWORD_RESET' : 'EMAIL_VERIFICATION';
      await smtpEmailProvider.sendTemplate(cleanTarget, templateKey, locale, {
        email: cleanTarget,
        otpCode: code,
      });
    } else {
      // Send localized SMS via SMS Provider Gateway
      await smsNotificationProvider.sendOtpSms(cleanTarget, code, locale);
    }

    return { sent: true, cooldownSeconds };
  }

  /**
   * Verifies the submitted OTP against Redis.
   */
  async verifyOtp(target: string, code: string, type: string): Promise<boolean> {
    const cleanTarget = target.trim();
    const key = `otp:${type}:${cleanTarget}`;
    const stored = await redis.get(key);

    const attemptsKey = `otp_attempts:${type}:${cleanTarget}`;
    const attempts = parseInt((await redis.get(attemptsKey)) || '0', 10);
    const MAX_OTP_ATTEMPTS = 5;

    if (attempts >= MAX_OTP_ATTEMPTS) {
      await redis.del(key);
      throw new AppError('لقد تم تجاوز الحد الأقصى لمحاولات التحقق. يرجى طلب رمز جديد.', 429, 'OTP_MAX_ATTEMPTS_EXCEEDED');
    }

    // Check dev bypass code ONLY in non-production environments
    const isProd = process.env.NODE_ENV === 'production';
    const devCode = !isProd ? (process.env.OTP_DEV_BYPASS_CODE || '123456') : null;
    const isDevMatch = Boolean(devCode && code === devCode);

    if (!stored && !isDevMatch) {
      throw new AppError('Invalid or expired OTP code.', 400);
    }

    if (stored && stored !== code && !isDevMatch) {
      const currentAttempts = await redis.incr(attemptsKey);
      if (currentAttempts === 1) {
        await redis.expire(attemptsKey, 600);
      }
      const remainingAttempts = Math.max(0, MAX_OTP_ATTEMPTS - currentAttempts);
      if (remainingAttempts === 0) {
        await redis.del(key);
        throw new AppError('تم تجاوز عدد المحاولات المسموح بها وتم إبطال الرمز. يرجى طلب رمز جديد.', 429, 'OTP_ATTEMPTS_EXCEEDED');
      }
      throw new AppError(`رمز التحقق غير صحيح. المحاولات المتبقية: ${remainingAttempts}`, 400, 'INVALID_OTP');
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

      // Dispatch via centralized localized email template
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
    // Cryptographically secure 6-digit code
    const num = crypto.randomInt(100000, 999999);
    return num.toString();
  }
}

export const otpService = OtpService.get();
