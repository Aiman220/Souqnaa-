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

export class SmsNotificationProvider implements NotificationProvider {
  channel = NotificationChannel.SMS;
  providerName = 'SMS_GATEWAY';

  private providerType: string;
  private senderId: string;

  constructor() {
    this.providerType = (process.env.SMS_PROVIDER || 'LOG').toUpperCase();
    this.senderId = process.env.SMS_SENDER_ID || 'Souqnaa';
  }

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
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
      const messageId = await this.dispatchSmsGateway(phone, smsText, useCase);
      return {
        success: true,
        provider: `${this.providerName}_${this.providerType}`,
        channel: this.channel,
        messageId,
      };
    } catch (error: any) {
      console.error(`[SMS Provider] Delivery error to ${phone}:`, error.message);
      return {
        success: false,
        provider: this.providerName,
        channel: this.channel,
        error: error.message,
      };
    }
  }

  /**
   * Validates local regulations and frequency limits for marketing SMS:
   * - Quiet Hours (no promotional SMS between 21:00 and 09:00 local time)
   * - Frequency Cap (e.g., max 1 marketing SMS every 48 hours)
   * - User Preference / Opt-in check
   */
  private async validateMarketingSmsCompliance(
    userId: string,
    phone: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    // A. Check user opt-in / preference
    try {
      const pref = await prisma.notificationPreference.findFirst({
        where: { userId, category: 'PROMOTION' },
      });
      if (pref && pref.smsEnabled === false) {
        return { allowed: false, reason: 'User opted out of promotional SMS' };
      }
    } catch (_) {}

    // B. Check local quiet hours regulation (Default 21:00 - 09:00)
    const quietStart = parseInt(process.env.MARKETING_SMS_QUIET_START || '21', 10);
    const quietEnd = parseInt(process.env.MARKETING_SMS_QUIET_END || '9', 10);
    const now = new Date();
    const currentHour = now.getHours(); // Local server hour

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

    // C. Check frequency limits via Redis cooldown
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
   * Gateway dispatcher: Twilio, Unifonic, Yemeni SMS HTTP Gateway, or Local Log
   */
  private async dispatchSmsGateway(phone: string, text: string, useCase: SmsUseCase): Promise<string> {
    const timestamp = Date.now();

    switch (this.providerType) {
      case 'TWILIO': {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_FROM_NUMBER || this.senderId;

        if (!accountSid || !authToken) {
          throw new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing');
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const body = new URLSearchParams({
          To: phone,
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
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Twilio error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        console.log(`[Twilio SMS] Delivered to ${phone} (SID: ${data.sid})`);
        return data.sid || `twilio_${timestamp}`;
      }

      case 'UNIFONIC': {
        const appSid = process.env.UNIFONIC_APP_SID;
        if (!appSid) throw new Error('UNIFONIC_APP_SID is missing');

        const url = 'https://api.unifonic.com/rest/SMS/messages';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            AppSid: appSid,
            Recipient: phone,
            Body: text,
            SenderID: this.senderId,
          }),
        });

        const data: any = await res.json();
        console.log(`[Unifonic SMS] Delivered to ${phone} (MessageID: ${data.data?.MessageID})`);
        return data.data?.MessageID || `unifonic_${timestamp}`;
      }

      case 'YEMEN_SMS': {
        const apiKey = process.env.YEMEN_SMS_API_KEY;
        const apiUrl = process.env.YEMEN_SMS_API_URL || 'https://sms.yemen-gateway.com/api/send';
        if (apiKey) {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              sender: this.senderId,
              recipient: phone,
              message: text,
              priority: useCase === 'OTP' ? 'high' : 'normal',
            }),
          });
          const data: any = await res.json().catch(() => ({ id: `yemensms_${timestamp}` }));
          console.log(`[Yemen SMS Gateway] Delivered to ${phone} | Priority: ${useCase}`);
          return data.id || `yemensms_${timestamp}`;
        }
        // Fallback to simulated log
        console.log(`[Yemen SMS Gateway (Simulated)] To: ${phone} | Content: "${text}"`);
        return `yemensms_sim_${timestamp}`;
      }

      case 'LOG':
      default: {
        console.log(`[SMS Gateway (${this.providerType})] To: ${phone} | UseCase: ${useCase} | Text: "${text}"`);
        return `sms_sim_${timestamp}_${Math.random().toString(36).substring(7)}`;
      }
    }
  }

  /**
   * Helper to send an OTP SMS with high priority and formatting
   */
  async sendOtpSms(phone: string, otpCode: string, locale: 'ar' | 'en' = 'ar'): Promise<ProviderSendResult> {
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
      },
    });
  }
}

export const smsNotificationProvider = new SmsNotificationProvider();
export const yemeniSmsProvider = smsNotificationProvider;
