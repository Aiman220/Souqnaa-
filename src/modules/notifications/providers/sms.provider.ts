import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { NotificationChannel } from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from './notification-provider.interface';

export type SmsUseCase = 'OTP' | 'ACCOUNT_VERIFICATION' | 'ORDER_UPDATE' | 'MARKETING';

export interface SmsSendOptions {
  useCase?: SmsUseCase;
  bypassQuietHours?: boolean;
}

export class SmsGatewayError extends Error {
  constructor(
    message: string,
    public readonly errorCode: 'TIMEOUT' | 'INVALID_PHONE' | 'DESTINATION_UNSUPPORTED' | 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED',
    public readonly statusCode: number = 503,
    public readonly providerRawCode?: string | number
  ) {
    super(message);
    this.name = 'SmsGatewayError';
  }
}

export class SmsNotificationProvider implements NotificationProvider {
  channel = NotificationChannel.SMS;
  providerName = 'SMS_GATEWAY';

  private providerType: string;
  private senderId: string;

  constructor() {
    this.providerType = (process.env.SMS_PROVIDER || 'LOG').toUpperCase();
    this.senderId = process.env.SMS_SENDER_ID || 'Souqnaa';
  }

  /**
   * Checks if an environment variable holds an unconfigured dummy placeholder
   */
  private isPlaceholder(val?: string): boolean {
    if (!val) return true;
    const v = val.toLowerCase().trim();
    return (
      v === '' ||
      v.includes('your_') ||
      v.includes('placeholder') ||
      v.includes('xxxx') ||
      v.includes('test_token')
    );
  }

  /**
   * Recognizes designated test/sandbox numbers for end-to-end testing without incurring carrier costs
   */
  public isControlledTestNumber(phone: string): boolean {
    const clean = phone.replace(/[^\d+]/g, '');
    const testNumbers = [
      '+967770000000',
      '+967771234567',
      '+967711234567',
      '+967733456789',
      '+967700112233',
      '+967788990011',
    ];
    return testNumbers.includes(clean);
  }

  /**
   * Formats a phone number for Yemeni carriers and aggregators
   */
  public formatPhoneForGateway(phone: string): { e164: string; internationalNoPlus: string; national: string } {
    let clean = phone.trim().replace(/[^\d+]/g, '');
    if (clean.startsWith('00967')) {
      clean = `+967${clean.slice(5)}`;
    } else if (clean.startsWith('967') && clean.length > 9) {
      clean = `+${clean}`;
    } else if (clean.startsWith('0')) {
      clean = `+967${clean.slice(1)}`;
    } else if (!clean.startsWith('+')) {
      clean = `+967${clean}`;
    }

    const national = clean.replace('+967', '');
    const internationalNoPlus = clean.replace('+', '');
    return {
      e164: clean,
      internationalNoPlus,
      national,
    };
  }

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
    const correlationId = (params.metadata?.correlationId as string) || undefined;

    // 1. Resolve phone number
    let phone = params.recipientPhone || params.data?.phone || params.metadata?.phone;
    if (!phone) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: params.recipientId },
          select: { phone: true },
        });
        phone = user?.phone || undefined;
      } catch (_) {}
    }

    if (!phone) {
      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: 'no_phone_noop',
        correlationId,
      };
    }

    // 2. Identify SMS use case
    const eventType = String(params.metadata?.eventType || params.data?.eventType || '');
    const category = String(params.category || params.metadata?.category || params.data?.category || '');

    let useCase: SmsUseCase =
      (params.metadata?.smsUseCase as SmsUseCase) ||
      (params.metadata?.useCase as SmsUseCase) ||
      (params.data?.smsUseCase as SmsUseCase) ||
      (params.data?.useCase as SmsUseCase) ||
      '';

    if (!useCase) {
      if (
        category === 'PROMOTION' ||
        category === 'FLASH_SALE' ||
        category === 'MEGA_CAMPAIGN' ||
        eventType === 'BROADCAST_CAMPAIGN'
      ) {
        useCase = 'MARKETING';
      } else if (eventType.startsWith('ORDER_') || eventType.startsWith('SELLER_')) {
        useCase = 'ORDER_UPDATE';
      } else if (
        eventType.includes('VERIF') ||
        eventType.includes('PASSWORD') ||
        eventType.includes('REGISTER')
      ) {
        useCase = 'ACCOUNT_VERIFICATION';
      } else {
        useCase = 'OTP';
      }
    }

    // 3. Marketing SMS Compliance & Frequency Rules
    if (useCase === 'MARKETING') {
      const complianceCheck = await this.validateMarketingSmsCompliance(params.recipientId, phone);
      if (!complianceCheck.allowed) {
        console.warn(`[SMS Provider] Marketing SMS blocked for ${phone}: ${complianceCheck.reason}`);
        return {
          success: false,
          provider: this.providerName,
          channel: this.channel,
          error: `Marketing SMS rejected: ${complianceCheck.reason}`,
          errorCode: 'MARKETING_BLOCKED',
          statusCode: 400,
          correlationId,
        };
      }

      // Record marketing delivery timestamp for frequency limiting (e.g. 48 hours cooldown)
      const cooldownHours = parseInt(process.env.MARKETING_SMS_COOLDOWN_HOURS || '48', 10);
      try {
        await redis.set(`sms:mkt:cooldown:${phone}`, Date.now().toString(), cooldownHours * 3600);
      } catch (_) {}
    }

    // 4. Format SMS content
    let smsText = params.content.bodyAr || params.content.bodyEn || '';
    if (params.content.titleAr && !smsText.includes(params.content.titleAr)) {
      smsText = `${params.content.titleAr}\n${smsText}`;
    }

    // Append regulatory opt-out instruction for marketing
    if (useCase === 'MARKETING') {
      const optOutText = process.env.SMS_OPTOUT_TEXT || '\nلإلغاء الاشتراك أرسل قف إلى 1234';
      smsText += optOutText;
    }

    // 5. Dispatch via configured provider gateway
    try {
      const messageId = await this.dispatchSmsGateway(phone, smsText, useCase, correlationId);
      return {
        success: true,
        provider: `${this.providerName}_${this.providerType}`,
        channel: this.channel,
        messageId,
        correlationId,
      };
    } catch (error: any) {
      const safePhone = String(phone).replace(/\d(?=\d{3})/g, '*');
      console.error(`[SMS Provider] Delivery error to ${safePhone}:`, error.message);

      let errorCode = 'PROVIDER_UNAVAILABLE';
      let statusCode = 503;

      if (error instanceof SmsGatewayError) {
        errorCode = error.errorCode;
        statusCode = error.statusCode;
      } else if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.message?.includes('timeout')) {
        errorCode = 'TIMEOUT';
        statusCode = 504;
      } else if (error.message?.includes('fetch failed') || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        errorCode = 'PROVIDER_UNAVAILABLE';
        statusCode = 503;
      }

      return {
        success: false,
        provider: this.providerName,
        channel: this.channel,
        error: error.message,
        errorCode,
        statusCode,
        correlationId,
      };
    }
  }

  /**
   * Validates local regulations and frequency limits for marketing SMS
   */
  private async validateMarketingSmsCompliance(
    userId: string,
    phone: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const pref = await prisma.notificationPreference.findFirst({
        where: { userId, category: 'PROMOTION' },
      });
      if (pref && pref.smsEnabled === false) {
        return { allowed: false, reason: 'User opted out of promotional SMS' };
      }
    } catch (_) {}

    const quietStart = parseInt(process.env.MARKETING_SMS_QUIET_START || '21', 10);
    const quietEnd = parseInt(process.env.MARKETING_SMS_QUIET_END || '9', 10);
    const now = new Date();
    const currentHour = now.getHours();

    const isQuietTime =
      quietStart > quietEnd
        ? currentHour >= quietStart || currentHour < quietEnd
        : currentHour >= quietStart && currentHour < quietEnd;

    if (isQuietTime) {
      return {
        allowed: false,
        reason: `Violates local quiet hours regulation (active between ${quietStart}:00 and ${quietEnd}:00)`,
      };
    }

    try {
      const lastSent = await redis.get(`sms:mkt:cooldown:${phone}`);
      if (lastSent) {
        return {
          allowed: false,
          reason: 'Frequency limit reached (marketing cooldown active)',
        };
      }
    } catch (_) {}

    return { allowed: true };
  }

  /**
   * Gateway dispatcher: Twilio, Unifonic, Yemeni SMS HTTP Gateway, or Local Log/Sandbox
   */
  private async dispatchSmsGateway(
    phone: string,
    text: string,
    useCase: SmsUseCase,
    correlationId?: string
  ): Promise<string> {
    const timestamp = Date.now();
    const formatted = this.formatPhoneForGateway(phone);
    const isTestNumber = this.isControlledTestNumber(formatted.e164);
    const isLocalDev = process.env.NODE_ENV !== 'production';

    // 1. Controlled test numbers and SANDBOX mode are handled without consuming production carrier balance
    if (isTestNumber || this.providerType === 'SANDBOX') {
      const masked = formatted.e164.replace(/\d(?=\d{3})/g, '*');
      console.log(`[SMS Gateway (Sandbox)] Delivery to ${masked} | Priority: ${useCase} | Correlation: ${correlationId || 'none'}`);
      return `sandbox_sms_${timestamp}_${Math.random().toString(36).substring(7)}`;
    }

    switch (this.providerType) {
      case 'TWILIO': {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_FROM_NUMBER || this.senderId;

        if (this.isPlaceholder(accountSid) || this.isPlaceholder(authToken)) {
          if (isLocalDev) {
            console.log(`[Twilio SMS (Dev Fallback)] To: ${formatted.e164.replace(/\d(?=\d{3})/g, '*')} | UseCase: ${useCase}`);
            return `twilio_dev_${timestamp}`;
          }
          throw new SmsGatewayError(
            'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing or unconfigured',
            'PROVIDER_UNAVAILABLE',
            503
          );
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const body = new URLSearchParams({
          To: formatted.e164,
          From: fromNumber,
          Body: text,
        });

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          const errJson: any = await res.json().catch(() => ({}));
          const twilioCode = errJson.code || res.status;
          const errMessage = errJson.message || `Twilio HTTP ${res.status}`;

          // Map Twilio-specific error codes
          if (twilioCode === 21211) {
            throw new SmsGatewayError(errMessage, 'INVALID_PHONE', 400, twilioCode);
          }
          if (twilioCode === 21408 || twilioCode === 21614 || twilioCode === 21608) {
            // Permission to send SMS to region (Yemen) not enabled or destination unreachable
            throw new SmsGatewayError(errMessage, 'DESTINATION_UNSUPPORTED', 400, twilioCode);
          }
          if (twilioCode === 20429) {
            throw new SmsGatewayError(errMessage, 'RATE_LIMITED', 429, twilioCode);
          }
          throw new SmsGatewayError(`Twilio delivery failure: ${errMessage}`, 'PROVIDER_UNAVAILABLE', 503, twilioCode);
        }

        const data: any = await res.json();
        console.log(`[Twilio SMS] Delivered to ${formatted.e164.replace(/\d(?=\d{3})/g, '*')} (SID: ${data.sid})`);
        return data.sid || `twilio_${timestamp}`;
      }

      case 'UNIFONIC': {
        const appSid = process.env.UNIFONIC_APP_SID;
        if (this.isPlaceholder(appSid)) {
          if (isLocalDev) {
            console.log(`[Unifonic SMS (Dev Fallback)] To: ${formatted.internationalNoPlus.replace(/\d(?=\d{3})/g, '*')} | UseCase: ${useCase}`);
            return `unifonic_dev_${timestamp}`;
          }
          throw new SmsGatewayError('UNIFONIC_APP_SID is missing or unconfigured', 'PROVIDER_UNAVAILABLE', 503);
        }

        const url = 'https://api.unifonic.com/rest/SMS/messages';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            AppSid: appSid,
            Recipient: formatted.internationalNoPlus,
            Body: text,
            SenderID: this.senderId,
          }),
          signal: AbortSignal.timeout(10000),
        });

        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || data.success === 'false' || data.success === false || data.errorCode) {
          const errCode = data.errorCode || `HTTP_${res.status}`;
          const errMsg = data.message || `Unifonic error (${errCode})`;

          if (['ER-09', 'ER-10', 'ER-82', 'ER-83'].includes(errCode)) {
            throw new SmsGatewayError(errMsg, 'INVALID_PHONE', 400, errCode);
          }
          if (['ER-11', 'ER-12', 'ER-13'].includes(errCode)) {
            throw new SmsGatewayError(errMsg, 'DESTINATION_UNSUPPORTED', 400, errCode);
          }
          throw new SmsGatewayError(`Unifonic delivery failure: ${errMsg}`, 'PROVIDER_UNAVAILABLE', 503, errCode);
        }

        console.log(`[Unifonic SMS] Delivered to ${formatted.internationalNoPlus.replace(/\d(?=\d{3})/g, '*')} (MessageID: ${data.data?.MessageID})`);
        return data.data?.MessageID || `unifonic_${timestamp}`;
      }

      case 'YEMEN_SMS': {
        const apiKey = process.env.YEMEN_SMS_API_KEY;
        const apiUrl = process.env.YEMEN_SMS_API_URL || 'https://sms.yemen-gateway.com/api/send';

        if (this.isPlaceholder(apiKey)) {
          if (isLocalDev) {
            console.log(`[Yemen SMS Gateway (Dev Fallback)] To: ${formatted.e164.replace(/\d(?=\d{3})/g, '*')} | UseCase: ${useCase}`);
            return `yemensms_dev_${timestamp}`;
          }
          throw new SmsGatewayError(
            'YEMEN_SMS_API_KEY is required and unconfigured in production',
            'PROVIDER_UNAVAILABLE',
            503
          );
        }

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            sender: this.senderId,
            recipient: formatted.e164,
            message: text,
            priority: useCase === 'OTP' ? 'high' : 'normal',
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          if (res.status === 400) {
            throw new SmsGatewayError(`Yemen Gateway invalid request: ${errText}`, 'INVALID_PHONE', 400);
          }
          if (res.status === 429) {
            throw new SmsGatewayError('Yemen Gateway rate limit exceeded', 'RATE_LIMITED', 429);
          }
          throw new SmsGatewayError(`Yemen Gateway error (${res.status}): ${errText}`, 'PROVIDER_UNAVAILABLE', 503);
        }

        const data: any = await res.json().catch(() => ({ id: `yemensms_${timestamp}` }));
        console.log(`[Yemen SMS Gateway] Delivered to ${formatted.e164.replace(/\d(?=\d{3})/g, '*')} | Priority: ${useCase}`);
        return data.id || `yemensms_${timestamp}`;
      }

      case 'LOG':
      default: {
        if (!isLocalDev && !isTestNumber) {
          throw new SmsGatewayError(
            'The LOG SMS provider cannot be used for production numbers. Configure YEMEN_SMS, UNIFONIC, or TWILIO credentials.',
            'PROVIDER_UNAVAILABLE',
            503
          );
        }
        console.log(`[SMS Gateway (${this.providerType})] Simulated delivery to ${formatted.e164.replace(/\d(?=\d{3})/g, '*')} | UseCase: ${useCase} | Content: [REDACTED]`);
        return `sms_sim_${timestamp}_${Math.random().toString(36).substring(7)}`;
      }
    }
  }

  /**
   * Helper to send an OTP SMS with high priority and formatting
   */
  async sendOtpSms(
    phone: string,
    otpCode: string,
    locale: 'ar' | 'en' = 'ar',
    correlationId?: string
  ): Promise<ProviderSendResult> {
    const isAr = locale === 'ar';
    const title = isAr ? 'رمز التحقق - سوقناا' : 'Verification Code - Souqnaa';
    const body = isAr
      ? `رمز التحقق الخاص بك في سوقناا هو: ${otpCode}. لا تشارك هذا الرمز مع أي شخص. صالح لمدة 10 دقائق.`
      : `Your Souqnaa verification code is: ${otpCode}. Never share this code. Valid for 10 minutes.`;

    return this.send({
      recipientPhone: phone,
      recipientId: phone,
      content: {
        titleAr: title,
        titleEn: title,
        bodyAr: body,
        bodyEn: body,
      },
      metadata: {
        smsUseCase: 'OTP',
        useCase: 'OTP',
        otpCode,
        bypassQuietHours: true,
        correlationId,
      },
    });
  }
}

export const smsNotificationProvider = new SmsNotificationProvider();
export const yemeniSmsProvider = smsNotificationProvider;
