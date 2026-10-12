import nodemailer, { Transporter } from 'nodemailer';
import { prisma } from '../../../database/prisma';
import { NotificationChannel } from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from './notification-provider.interface';
import {
  renderEmailTemplate,
  EmailTemplateKey,
  LocaleCode,
  EmailTemplateData,
} from '../templates/email-templates';

export class SmtpEmailProvider implements NotificationProvider {
  channel = NotificationChannel.EMAIL;
  providerName = 'EMAIL_SMTP';

  private transporter: Transporter | null = null;
  private isConfigured = false;

  constructor() {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    if (host && user && pass) {
      try {
        this.transporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass },
          tls: {
            rejectUnauthorized: process.env.NODE_ENV === 'production',
          },
        });
        this.isConfigured = true;
      } catch (e) {
        console.warn('[Email Provider] Failed to initialize nodemailer transporter:', e);
      }
    }
  }

  private resolveTemplateFromEvent(params: ProviderSendParams): EmailTemplateKey | undefined {
    const rawTemplate = (params.metadata?.emailTemplate || params.data?.emailTemplate) as EmailTemplateKey | undefined;
    if (rawTemplate) return rawTemplate;

    const eventType = String(params.metadata?.eventType || params.data?.eventType || '');
    const category = String(params.category || params.metadata?.category || params.data?.category || '');

    // 1. Order Lifecycle
    if (eventType === 'ORDER_CREATED' || eventType === 'ORDER_CONFIRMED' || eventType === 'ORDER_ACCEPTED') {
      return 'ORDER_CONFIRMATION';
    }
    if (eventType === 'ORDER_SHIPPED' || eventType === 'ORDER_READY_TO_SHIP' || eventType === 'ORDER_OUT_FOR_DELIVERY') {
      return 'ORDER_SHIPPED';
    }
    if (eventType === 'ORDER_DELIVERED') {
      return 'ORDER_DELIVERED';
    }

    // 2. Payments & Invoices
    if (eventType === 'PAYMENT_SUCCESS' || eventType === 'PAYMENT_RECEIVED') {
      return 'PAYMENT_RECEIPT';
    }
    if (eventType === 'INVOICE_GENERATED' || eventType === 'ORDER_INVOICE') {
      return 'INVOICE';
    }

    // 3. Refunds
    if (eventType === 'REFUND_COMPLETED' || eventType === 'REFUND_ACCEPTED') {
      return 'REFUND_COMPLETED';
    }

    // 4. Coupons & Vouchers
    if (eventType === 'COUPON_AVAILABLE' || eventType === 'VOUCHER_ISSUED' || category === 'COUPON') {
      return 'VOUCHER';
    }

    // 5. Promotions & Flash Sales
    if (eventType.startsWith('FLASH_SALE_') || eventType === 'PRICE_DROPPED' || eventType === 'BACK_IN_STOCK') {
      return 'PROMOTION';
    }

    // 6. Broadcast Campaigns & Mega Campaigns
    if (eventType === 'BROADCAST_CAMPAIGN' || eventType === 'MEGA_CAMPAIGN_STARTED' || eventType === 'CAMPAIGN_STARTED') {
      return 'CAMPAIGN';
    }

    // 7. Seller Notifications
    if (eventType.startsWith('SELLER_') || params.data?.recipientType === 'SELLER') {
      return 'SELLER_NOTIFICATION';
    }

    // 8. Security Alerts
    if (category === 'SECURITY' || eventType.startsWith('NEW_LOGIN') || eventType.startsWith('PASSWORD_') || eventType === 'ADMIN_ALERT') {
      return 'SECURITY_ALERT';
    }

    return undefined;
  }

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
    // 1. Resolve recipient email and full name
    let email = params.recipientEmail || params.data?.recipientEmail || params.metadata?.recipientEmail;
    let recipientName = params.data?.name || params.metadata?.name;

    if (!email || !recipientName) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: params.recipientId },
          select: { email: true, firstName: true, lastName: true },
        });
        if (!email && user?.email) email = user.email;
        if (!recipientName && user) {
          recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        }
      } catch (_) {}
    }

    if (!email) {
      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: 'no_email_noop',
      };
    }

    // 2. Merge event payload data and resolve template
    const mergedData = { ...(params.data || {}), ...(params.metadata || {}) };
    const templateKey = this.resolveTemplateFromEvent(params);
    const locale: LocaleCode = (mergedData.locale as LocaleCode) || 'ar';

    const templateData: EmailTemplateData = {
      ...mergedData,
      name: recipientName || mergedData.customerName || mergedData.userName || 'عميلنا العزيز',
      email,
      orderId: mergedData.orderId || params.content.deepLink?.split('/').pop(),
      orderNumber: mergedData.orderNumber || (mergedData.orderId ? String(mergedData.orderId).slice(0, 8).toUpperCase() : undefined),
      totalAmount: mergedData.totalAmount !== undefined ? Number(mergedData.totalAmount) : undefined,
      currency: mergedData.currency || 'YER',
      subtotal: mergedData.subtotal !== undefined ? Number(mergedData.subtotal) : undefined,
      deliveryFee: mergedData.deliveryFee !== undefined ? Number(mergedData.deliveryFee) : undefined,
      discount: mergedData.discount !== undefined ? Number(mergedData.discount) : undefined,
      paymentMethod: mergedData.paymentMethod || 'الدفع عند الاستلام',
      transactionId: mergedData.transactionId,
      paidAt: mergedData.paidAt || (mergedData.createdAt ? new Date(mergedData.createdAt).toLocaleDateString(locale === 'ar' ? 'ar-YE' : 'en-US') : undefined),
      invoiceNumber: mergedData.invoiceNumber || (mergedData.orderNumber ? `INV-${mergedData.orderNumber}` : undefined),
      storeName: mergedData.storeName || mergedData.sellerName,
      trackingNumber: mergedData.trackingNumber,
      carrierName: mergedData.carrierName || 'مندوب سوقناا',
      shippingAddress: mergedData.shippingAddress || mergedData.deliveryAddress,
      refundAmount: mergedData.refundAmount !== undefined ? Number(mergedData.refundAmount) : (mergedData.amount !== undefined ? Number(mergedData.amount) : undefined),
      refundReason: mergedData.refundReason || mergedData.reason,
      refundId: mergedData.refundId || mergedData.refundNumber,
      voucherCode: mergedData.voucherCode || mergedData.couponCode,
      discountValue: mergedData.discountValue,
      minSpend: mergedData.minSpend,
      expiresAt: mergedData.expiresAt || mergedData.expiryDate,
      promotionTitle: mergedData.promotionTitle || params.content.titleAr,
      promotionDescription: mergedData.promotionDescription || params.content.bodyAr,
      campaignName: mergedData.campaignName || mergedData.campaignTitleAr || params.content.titleAr,
      campaignDiscount: mergedData.campaignDiscount || (mergedData.discountPercentage ? `${mergedData.discountPercentage}%` : undefined),
      sellerTitle: mergedData.sellerTitle || params.content.titleAr,
      sellerMessage: mergedData.sellerMessage || params.content.bodyAr,
      alertType: mergedData.alertType || mergedData.eventType,
      ipAddress: mergedData.ipAddress,
      deviceInfo: mergedData.deviceInfo,
      actionUrl: mergedData.actionUrl || params.content.deepLink,
      title: params.content.titleAr,
      body: params.content.bodyAr,
    };

    let subject = params.content.titleAr;
    let htmlBody: string;
    let textBody: string = params.content.bodyAr;

    if (templateKey) {
      const rendered = renderEmailTemplate(templateKey, locale, templateData);
      subject = rendered.subject;
      htmlBody = rendered.html;
      textBody = rendered.text;
    } else {
      // Default branded Souqnaa wrapper
      const rendered = renderEmailTemplate('WELCOME', locale, {
        name: recipientName,
        promotionTitle: params.content.titleAr,
        promotionDescription: params.content.bodyAr,
        actionUrl: params.content.deepLink,
      });
      subject = params.content.titleAr || rendered.subject;
      htmlBody = rendered.html;
    }

    const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@souqnaa.com';
    const fromName = process.env.EMAIL_FROM_NAME || 'سوقناا';

    // 3. Send via Nodemailer SMTP if configured, else log in development
    if (this.isConfigured && this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: `"${fromName}" <${fromAddress}>`,
          to: email,
          subject,
          text: textBody,
          html: htmlBody,
        });

        console.log(`[Email Provider] Sent email to ${email} via SMTP | Template: ${templateKey || 'DEFAULT'} | MessageID: ${info.messageId}`);
        return {
          success: true,
          provider: this.providerName,
          channel: this.channel,
          messageId: info.messageId,
        };
      } catch (err: any) {
        console.error(`[Email Provider] SMTP delivery error to ${email}:`, err.message);
        if (process.env.NODE_ENV !== 'production' || process.env.SMTP_SANDBOX === 'true') {
          console.warn(`[Email Provider] Development mode: Gracefully falling back to sandbox delivery.`);
          const simulatedId = `email_dev_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          return {
            success: true,
            provider: `${this.providerName}_SANDBOX`,
            channel: this.channel,
            messageId: simulatedId,
          };
        }
        return {
          success: false,
          provider: this.providerName,
          channel: this.channel,
          error: err.message,
        };
      }
    }

    // Dev/Sandbox fallback mode: Log formatted output without throwing
    const simulatedId = `email_sim_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    console.log(`[Email Provider (Sandbox)] To: ${email} | Subject: "${subject}" | Template: ${templateKey || 'DEFAULT'}`);

    return {
      success: true,
      provider: this.providerName,
      channel: this.channel,
      messageId: simulatedId,
    };
  }

  /**
   * Helper to send a predefined template directly without constructing manual payloads
   */
  async sendTemplate(
    to: string,
    templateKey: EmailTemplateKey,
    locale: LocaleCode = 'ar',
    data: EmailTemplateData = {}
  ): Promise<ProviderSendResult> {
    const rendered = renderEmailTemplate(templateKey, locale, data);
    return this.send({
      recipientEmail: to,
      recipientId: data.userId || 'direct',
      content: {
        titleAr: rendered.subject,
        titleEn: rendered.subject,
        bodyAr: rendered.text,
        bodyEn: rendered.text,
        deepLink: data.actionUrl,
      },
      metadata: {
        emailTemplate: templateKey,
        locale,
        ...data,
      },
    });
  }
}

export const smtpEmailProvider = new SmtpEmailProvider();
