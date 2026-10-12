/**
 * SOUQNAA Notification Platform — Centralized Email Template Engine
 * 
 * Strict architectural rule: "Do not put HTML directly into business services."
 * All HTML, CSS, branding, and localizations reside exclusively here.
 */

export type EmailTemplateKey =
  | 'WELCOME'
  | 'EMAIL_VERIFICATION'
  | 'PASSWORD_RESET'
  | 'ORDER_CONFIRMATION'
  | 'PAYMENT_RECEIPT'
  | 'INVOICE'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERED'
  | 'REFUND_COMPLETED'
  | 'VOUCHER'
  | 'PROMOTION'
  | 'CAMPAIGN'
  | 'SELLER_NOTIFICATION'
  | 'SECURITY_ALERT';

export type LocaleCode = 'ar' | 'en';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplateData {
  name?: string;
  email?: string;
  otpCode?: string;
  verificationUrl?: string;
  resetUrl?: string;
  orderId?: string;
  orderNumber?: string;
  items?: Array<{ name: string; quantity: number; price: number; total: number }>;
  currency?: string;
  subtotal?: number;
  deliveryFee?: number;
  discount?: number;
  totalAmount?: number;
  paymentMethod?: string;
  transactionId?: string;
  paidAt?: string;
  invoiceNumber?: string;
  storeName?: string;
  trackingNumber?: string;
  carrierName?: string;
  trackingUrl?: string;
  shippingAddress?: string;
  refundAmount?: number;
  refundReason?: string;
  refundId?: string;
  voucherCode?: string;
  discountValue?: string;
  minSpend?: string;
  expiresAt?: string;
  promotionTitle?: string;
  promotionDescription?: string;
  campaignName?: string;
  campaignDiscount?: string;
  sellerTitle?: string;
  sellerMessage?: string;
  alertType?: string;
  ipAddress?: string;
  deviceInfo?: string;
  timestamp?: string;
  actionUrl?: string;
  actionText?: string;
  [key: string]: any;
}

/**
 * Base email layout wrapper with Souqnaa branding, responsive container, and RTL/LTR support.
 */
function wrapEmailLayout(options: {
  locale: LocaleCode;
  title: string;
  preheader?: string;
  badge?: string;
  badgeColor?: string;
  contentHtml: string;
  actionButton?: { text: string; url: string; color?: string };
  footerNote?: string;
}): string {
  const isAr = options.locale === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';
  const align = isAr ? 'right' : 'left';
  const font = isAr
    ? "'Tajawal', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Tahoma, Arial, sans-serif"
    : "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const btnColor = options.actionButton?.color || '#10B981';

  return `<!DOCTYPE html>
<html lang="${options.locale}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${options.title}</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #F8FAFC; font-family: ${font}; color: #1E293B; }
    .email-container { max-width: 600px; margin: 20px auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; border: 1px solid #E2E8F0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, #0F172A 0%, #1E293B 100%); padding: 32px 24px; text-align: center; }
    .brand-title { color: #FFFFFF; font-size: 26px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
    .brand-subtitle { color: #94A3B8; font-size: 13px; margin: 6px 0 0 0; }
    .content-body { padding: 36px 28px; text-align: ${align}; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; margin-bottom: 16px; background-color: ${options.badgeColor || '#ECFDF5'}; color: ${options.badgeColor ? '#FFFFFF' : '#059669'}; }
    .headline { font-size: 22px; font-weight: 800; color: #0F172A; margin: 0 0 14px 0; line-height: 1.3; }
    .lead-text { font-size: 15px; color: #475569; line-height: 1.6; margin: 0 0 20px 0; }
    .btn-cta { display: inline-block; background-color: ${btnColor}; color: #FFFFFF !important; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 10px; margin-top: 10px; margin-bottom: 10px; text-align: center; }
    .details-box { background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .item-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #E2E8F0; font-size: 14px; }
    .item-row:last-child { border-bottom: none; }
    .total-row { padding-top: 12px; margin-top: 8px; border-top: 2px solid #CBD5E1; font-weight: 800; font-size: 16px; color: #0F172A; }
    .code-box { background-color: #F1F5F9; border: 2px dashed #CBD5E1; border-radius: 12px; padding: 18px; text-align: center; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0F172A; margin: 24px 0; font-family: monospace; }
    .footer { background-color: #F1F5F9; padding: 24px; text-align: center; font-size: 12px; color: #64748B; line-height: 1.5; border-top: 1px solid #E2E8F0; }
    .footer a { color: #10B981; text-decoration: underline; }
    @media only screen and (max-width: 600px) {
      .email-container { margin: 0 !important; border-radius: 0 !important; border: none !important; width: 100% !important; }
      .content-body { padding: 24px 18px !important; }
    }
  </style>
</head>
<body>
  ${options.preheader ? `<div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${options.preheader}</div>` : ''}
  <div class="email-container">
    <div class="header">
      <h1 class="brand-title">سوقناا</h1>
      <p class="brand-subtitle">Souqnaa Multi-Vendor Marketplace</p>
    </div>
    <div class="content-body">
      ${options.badge ? `<div class="badge">${options.badge}</div>` : ''}
      <h2 class="headline">${options.title}</h2>
      ${options.contentHtml}
      ${options.actionButton ? `
        <div style="text-align: center; margin: 28px 0 16px 0;">
          <a href="${options.actionButton.url}" class="btn-cta">${options.actionButton.text}</a>
        </div>
      ` : ''}
    </div>
    <div class="footer">
      ${options.footerNote ? `<p style="margin-bottom: 10px;">${options.footerNote}</p>` : ''}
      <p style="margin: 0;">
        ${isAr ? 'منصة سوقناا للتجارة الإلكترونية المتعددة التجار. جميع الحقوق محفوظة © 2026' : 'Souqnaa Multi-Vendor Marketplace. All rights reserved © 2026'}
      </p>
      <p style="margin: 6px 0 0 0;">
        <a href="https://souqnaa.com/privacy">${isAr ? 'سياسة الخصوصية' : 'Privacy Policy'}</a> &bull; 
        <a href="https://souqnaa.com/support">${isAr ? 'الدعم الفني' : 'Customer Support'}</a> &bull; 
        <a href="https://souqnaa.com/terms">${isAr ? 'الشروط والأحكام' : 'Terms & Conditions'}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 14 Localized Email Templates
 */
export const EmailTemplates: Record<
  EmailTemplateKey,
  (locale: LocaleCode, data: EmailTemplateData) => RenderedEmail
> = {
  // 1. Welcome Template
  WELCOME: (locale, data) => {
    const isAr = locale === 'ar';
    const name = data.name || (isAr ? 'عميلنا العزيز' : 'Valued Customer');
    const subject = isAr ? 'أهلاً بك في منصة سوقناا! 🎉' : 'Welcome to Souqnaa! 🎉';
    const actionUrl = data.actionUrl || 'https://souqnaa.com/home';

    const contentHtml = `
      <p class="lead-text">
        ${isAr 
          ? `مرحباً <strong>${name}</strong>، سعداء بانضمامك إلى منصة سوقناا! اكتشف آلاف المنتجات المميزة، وتصفح أفضل المتاجر المحلية، واستمتع بتجربة تسوق سريعة وموثوقة مع خيارات دفع متعددة وتوصيل فوري.`
          : `Hello <strong>${name}</strong>, we are thrilled to welcome you to Souqnaa! Explore thousands of hand-picked products, browse top-rated local vendor storefronts, and enjoy fast, reliable delivery with secure payments.`}
      </p>
      <div class="details-box">
        <h4 style="margin: 0 0 10px 0; color: #0F172A; font-size: 15px;">
          ${isAr ? 'ما الذي يمكنك فعله الآن؟' : 'What can you do now?'}
        </h4>
        <ul style="margin: 0; padding-${isAr ? 'right' : 'left'}: 20px; color: #475569; font-size: 14px; line-height: 1.8;">
          <li>${isAr ? 'تصفح العروض اليومية وحملات الفلاش سيل' : 'Browse daily flash sales and mega campaigns'}</li>
          <li>${isAr ? 'متابعة متاجرك المفضلة والحصول على كوبونات حصرية' : 'Follow your favorite stores for exclusive vouchers'}</li>
          <li>${isAr ? 'كسب نقاط ومكافآت كوينز مع كل عملية شراء' : 'Earn Souqnaa Coins & rewards on every completed order'}</li>
        </ul>
      </div>
    `;

    const text = isAr
      ? `أهلاً بك في منصة سوقناا، ${name}!\nيسعدنا انضمامك. تصفح آلاف المنتجات المميزة واستمتع بتجربة تسوق لا تضاهى: ${actionUrl}`
      : `Welcome to Souqnaa, ${name}!\nWe are excited to have you onboard. Discover great products and shops: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'أهلاً بك في عائلة سوقناا 🎉' : 'Welcome to the Souqnaa Family 🎉',
        badge: isAr ? 'عضو جديد' : 'New Member',
        badgeColor: '#10B981',
        contentHtml,
        actionButton: {
          text: isAr ? 'ابدأ التسوق الآن 🛍️' : 'Start Shopping Now 🛍️',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 2. Email Verification Template
  EMAIL_VERIFICATION: (locale, data) => {
    const isAr = locale === 'ar';
    const subject = isAr ? 'رمز تأكيد بريدك الإلكتروني - سوقناا' : 'Verify Your Email Address - Souqnaa';
    const code = data.otpCode || '123456';
    const verifyUrl = data.verificationUrl || `https://souqnaa.com/verify-email?code=${code}&email=${encodeURIComponent(data.email || '')}`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? 'لتأكيد بريدك الإلكتروني وتفعيل حسابك بأمان في سوقناا، يرجى استخدام رمز التحقق أدناه. صلاحية الرمز 10 دقائق فقط.'
          : 'To securely verify your email address and activate your account on Souqnaa, please use the verification code below. This code expires in 10 minutes.'}
      </p>
      <div class="code-box">${code}</div>
      <p style="font-size: 13px; color: #64748B; text-align: center; margin: 0 0 16px 0;">
        ${isAr ? 'إذا لم تقم بإنشاء حساب في سوقناا، يرجى تجاهل هذه الرسالة.' : 'If you did not request this verification, please safely ignore this email.'}
      </p>
    `;

    const text = isAr
      ? `رمز تأكيد بريدك الإلكتروني في سوقناا هو: ${code}\nصلاحية الرمز 10 دقائق.\nأو اضغط على الرابط: ${verifyUrl}`
      : `Your Souqnaa email verification code is: ${code}\nExpires in 10 minutes.\nOr click: ${verifyUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'تأكيد البريد الإلكتروني 🔐' : 'Email Verification 🔐',
        badge: isAr ? 'رمز سري' : 'Security OTP',
        badgeColor: '#2563EB',
        contentHtml,
        actionButton: {
          text: isAr ? 'تأكيد الحساب مباشرة' : 'Verify Directly',
          url: verifyUrl,
          color: '#2563EB',
        },
      }),
      text,
    };
  },

  // 3. Password Reset Template
  PASSWORD_RESET: (locale, data) => {
    const isAr = locale === 'ar';
    const subject = isAr ? 'طلب إعادة تعيين كلمة المرور - سوقناا' : 'Reset Your Souqnaa Password';
    const code = data.otpCode || '123456';
    const resetUrl = data.resetUrl || `https://souqnaa.com/reset-password?code=${code}&email=${encodeURIComponent(data.email || '')}`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? 'تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك. استخدم الرمز السري أدناه أو اضغط على الزر لإتمام التعيين. صلاحية الرمز 15 دقيقة.'
          : 'We received a request to reset the password for your Souqnaa account. Use the security code below or click the button to set a new password. Code expires in 15 minutes.'}
      </p>
      <div class="code-box" style="border-color: #F59E0B; color: #D97706;">${code}</div>
      <div class="details-box">
        <p style="margin: 0; font-size: 13px; color: #64748B;">
          <strong>${isAr ? 'تنبيه أمان:' : 'Security Notice:'}</strong> 
          ${isAr 
            ? 'إذا لم تطلب إعادة تعيين كلمة المرور، يرجى تجاهل هذا البريد والتأكد من أمان حسابك.' 
            : 'If you did not request a password reset, please ignore this email. Your password will remain unchanged.'}
        </p>
      </div>
    `;

    const text = isAr
      ? `رمز إعادة تعيين كلمة المرور في سوقناا هو: ${code}\nصلاحية الرمز 15 دقيقة.\nلإعادة التعيين: ${resetUrl}`
      : `Your Souqnaa password reset code is: ${code}\nValid for 15 minutes.\nReset link: ${resetUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'إعادة تعيين كلمة المرور 🔑' : 'Reset Your Password 🔑',
        badge: isAr ? 'أمان الحساب' : 'Account Security',
        badgeColor: '#F59E0B',
        contentHtml,
        actionButton: {
          text: isAr ? 'إعادة تعيين كلمة المرور' : 'Set New Password',
          url: resetUrl,
          color: '#F59E0B',
        },
      }),
      text,
    };
  },

  // 4. Order Confirmation Template
  ORDER_CONFIRMATION: (locale, data) => {
    const isAr = locale === 'ar';
    const orderNum = data.orderNumber || data.orderId || 'SQ-1001';
    const currency = data.currency || (isAr ? 'ر.ي' : 'YER');
    const subject = isAr ? `تم تأكيد طلبك بنجاح #${orderNum} 📦` : `Order Confirmed #${orderNum} 📦`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/orders/${data.orderId || orderNum}`;

    const itemsHtml = (data.items || [
      { name: isAr ? 'منتج مميز' : 'Featured Product', quantity: 1, price: 5000, total: 5000 },
    ])
      .map(
        (item) => `
        <div class="item-row">
          <span>${item.name} &times; ${item.quantity}</span>
          <span>${item.total.toLocaleString()} ${currency}</span>
        </div>`
      )
      .join('');

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `شكراً لتسوقك من سوقناا! تم استلام وتأكيد طلبك رقم <strong>#${orderNum}</strong> بنجاح، وجاري إرساله للمتجر للبدء في التجهيز والتغليف فوراً.`
          : `Thank you for shopping at Souqnaa! Your order <strong>#${orderNum}</strong> has been received and confirmed. The store is now preparing your items.`}
      </p>
      <div class="details-box">
        <h4 style="margin: 0 0 12px 0; color: #0F172A; font-size: 15px;">
          ${isAr ? 'ملخص المنتجات والطلب' : 'Order Items Summary'}
        </h4>
        ${itemsHtml}
        <div class="item-row" style="margin-top: 10px; color: #64748B;">
          <span>${isAr ? 'المجموع الفرعي' : 'Subtotal'}</span>
          <span>${(data.subtotal || data.totalAmount || 5000).toLocaleString()} ${currency}</span>
        </div>
        <div class="item-row" style="color: #64748B;">
          <span>${isAr ? 'رسوم التوصيل' : 'Delivery Fee'}</span>
          <span>${(data.deliveryFee || 0).toLocaleString()} ${currency}</span>
        </div>
        ${data.discount ? `
        <div class="item-row" style="color: #10B981;">
          <span>${isAr ? 'خصم الكوبون' : 'Coupon Discount'}</span>
          <span>-${data.discount.toLocaleString()} ${currency}</span>
        </div>` : ''}
        <div class="item-row total-row">
          <span>${isAr ? 'المبلغ الإجمالي' : 'Total Amount'}</span>
          <span>${(data.totalAmount || 5000).toLocaleString()} ${currency}</span>
        </div>
      </div>
      ${data.shippingAddress ? `
        <p style="font-size: 13px; color: #64748B;">
          <strong>${isAr ? 'عنوان التوصيل:' : 'Delivery Address:'}</strong> ${data.shippingAddress}
        </p>
      ` : ''}
    `;

    const text = isAr
      ? `تم تأكيد طلبك رقم #${orderNum} بمبلغ إجمالي ${(data.totalAmount || 5000)} ${currency}.\nتابع حالة الطلب عبر: ${actionUrl}`
      : `Order #${orderNum} confirmed for total ${(data.totalAmount || 5000)} ${currency}.\nTrack order: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'طلبك مؤكد وبانتظار التجهيز 🛍️' : 'Order Confirmed & Preparing 🛍️',
        badge: isAr ? 'تم التأكيد' : 'Confirmed',
        badgeColor: '#10B981',
        contentHtml,
        actionButton: {
          text: isAr ? 'متابعة تفاصيل الطلب' : 'Track Order Status',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 5. Payment Receipt Template
  PAYMENT_RECEIPT: (locale, data) => {
    const isAr = locale === 'ar';
    const currency = data.currency || (isAr ? 'ر.ي' : 'YER');
    const txId = data.transactionId || `TX-${Date.now().toString().slice(-8)}`;
    const subject = isAr ? `إيصال استلام دفعة مالية #${txId} 💳` : `Payment Receipt #${txId} 💳`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/wallet`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `تم استلام دفعتك المالية بنجاح للطلب رقم <strong>#${data.orderNumber || 'SQ-1001'}</strong>.`
          : `We have successfully received your payment for order <strong>#${data.orderNumber || 'SQ-1001'}</strong>.`}
      </p>
      <div class="details-box">
        <div class="item-row">
          <span>${isAr ? 'رقم المعاملة' : 'Transaction ID'}</span>
          <span style="font-family: monospace;">${txId}</span>
        </div>
        <div class="item-row">
          <span>${isAr ? 'طريقة الدفع' : 'Payment Method'}</span>
          <span>${data.paymentMethod || (isAr ? 'المحفظة الرقمية / بطاقة' : 'Digital Wallet / Card')}</span>
        </div>
        <div class="item-row">
          <span>${isAr ? 'تاريخ الدفع' : 'Payment Date'}</span>
          <span>${data.paidAt || new Date().toLocaleDateString(locale)}</span>
        </div>
        <div class="item-row total-row">
          <span>${isAr ? 'المبلغ المدفوع' : 'Amount Paid'}</span>
          <span style="color: #10B981;">${(data.totalAmount || 0).toLocaleString()} ${currency}</span>
        </div>
      </div>
    `;

    const text = isAr
      ? `إيصال سداد: تم استلام ${(data.totalAmount || 0)} ${currency} بنجاح. رقم المعاملة: ${txId}.`
      : `Payment Receipt: ${(data.totalAmount || 0)} ${currency} received. Transaction ID: ${txId}.`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'إيصال دفع إلكتروني معتمد 💳' : 'Official Payment Receipt 💳',
        badge: isAr ? 'عملية دفع ناجحة' : 'Payment Paid',
        badgeColor: '#10B981',
        contentHtml,
        actionButton: {
          text: isAr ? 'عرض محفظتي ومعاملاتي' : 'View Wallet & Transactions',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 6. Commercial Invoice Template
  INVOICE: (locale, data) => {
    const isAr = locale === 'ar';
    const invNum = data.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;
    const currency = data.currency || (isAr ? 'ر.ي' : 'YER');
    const subject = isAr ? `فاتورة شراء رقم #${invNum} - سوقناا` : `Commercial Invoice #${invNum} - Souqnaa`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/orders/${data.orderId || ''}/invoice`;

    const itemsRows = (data.items || [
      { name: isAr ? 'منتج مشتريات' : 'Purchased Item', quantity: 1, price: 10000, total: 10000 },
    ])
      .map(
        (it) => `
        <tr style="border-bottom: 1px solid #E2E8F0; font-size: 13px;">
          <td style="padding: 10px 8px;">${it.name}</td>
          <td style="padding: 10px 8px; text-align: center;">${it.quantity}</td>
          <td style="padding: 10px 8px; text-align: center;">${it.price.toLocaleString()}</td>
          <td style="padding: 10px 8px; text-align: ${isAr ? 'left' : 'right'}; font-weight: bold;">${it.total.toLocaleString()} ${currency}</td>
        </tr>
      `
      )
      .join('');

    const contentHtml = `
      <div style="margin-bottom: 20px;">
        <table style="width: 100%; font-size: 13px; color: #64748B;">
          <tr>
            <td><strong>${isAr ? 'رقم الفاتورة:' : 'Invoice No:'}</strong> ${invNum}</td>
            <td style="text-align: ${isAr ? 'left' : 'right'};"><strong>${isAr ? 'التاريخ:' : 'Date:'}</strong> ${new Date().toLocaleDateString(locale)}</td>
          </tr>
          <tr>
            <td><strong>${isAr ? 'المتجر البائع:' : 'Vendor/Store:'}</strong> ${data.storeName || (isAr ? 'متجر سوقناا المعتمد' : 'Verified Vendor')}</td>
            <td style="text-align: ${isAr ? 'left' : 'right'};"><strong>${isAr ? 'الطلب المرتبط:' : 'Order Ref:'}</strong> #${data.orderNumber || 'SQ-1001'}</td>
          </tr>
        </table>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <thead>
          <tr style="background-color: #0F172A; color: #FFFFFF; font-size: 12px;">
            <th style="padding: 8px; text-align: ${isAr ? 'right' : 'left'};">${isAr ? 'البيان والمنتج' : 'Description'}</th>
            <th style="padding: 8px; text-align: center;">${isAr ? 'الكمية' : 'Qty'}</th>
            <th style="padding: 8px; text-align: center;">${isAr ? 'السعر' : 'Unit Price'}</th>
            <th style="padding: 8px; text-align: ${isAr ? 'left' : 'right'};">${isAr ? 'الإجمالي' : 'Total'}</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>

      <div class="details-box" style="margin-top: 10px;">
        <div class="item-row">
          <span>${isAr ? 'المجموع' : 'Subtotal'}</span>
          <span>${(data.subtotal || data.totalAmount || 10000).toLocaleString()} ${currency}</span>
        </div>
        <div class="item-row">
          <span>${isAr ? 'الشحن والتوصيل' : 'Delivery & Logistics'}</span>
          <span>${(data.deliveryFee || 0).toLocaleString()} ${currency}</span>
        </div>
        <div class="item-row total-row">
          <span>${isAr ? 'الصافي النهائي للمطالبة' : 'Final Grand Total'}</span>
          <span style="color: #0F172A;">${(data.totalAmount || 10000).toLocaleString()} ${currency}</span>
        </div>
      </div>
    `;

    const text = isAr
      ? `فاتورة شراء رقم #${invNum} للطلب #${data.orderNumber || ''}. الإجمالي: ${(data.totalAmount || 10000)} ${currency}. التفاصيل: ${actionUrl}`
      : `Commercial Invoice #${invNum} for order #${data.orderNumber || ''}. Grand Total: ${(data.totalAmount || 10000)} ${currency}. Link: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'فاتورة ضريبية وتجارية رسمية 📄' : 'Commercial Purchase Invoice 📄',
        badge: isAr ? 'فاتورة معتمدة' : 'Official Invoice',
        badgeColor: '#0F172A',
        contentHtml,
        actionButton: {
          text: isAr ? 'تحميل الفاتورة PDF' : 'Download Invoice PDF',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 7. Order Shipped Template
  ORDER_SHIPPED: (locale, data) => {
    const isAr = locale === 'ar';
    const orderNum = data.orderNumber || 'SQ-1001';
    const subject = isAr ? `طلبك في الطريق إليك الآن #${orderNum} 🚚` : `Your Order is On the Way #${orderNum} 🚚`;
    const actionUrl = data.trackingUrl || `https://souqnaa.com/orders/${data.orderId || orderNum}`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `خبر رائع! تم شحن طلبك رقم <strong>#${orderNum}</strong> بنجاح وتسليمه إلى شركة الشحن / مندوب التوصيل وهو في طريقه إليك.`
          : `Great news! Your order <strong>#${orderNum}</strong> has been shipped and handed over to the courier. It is on its way to you.`}
      </p>
      <div class="details-box">
        <div class="item-row">
          <span>${isAr ? 'شركة الشحن / التوصيل' : 'Courier / Carrier'}</span>
          <span><strong>${data.carrierName || (isAr ? 'أسطول سوقناا إكسبريس' : 'Souqnaa Express Courier')}</strong></span>
        </div>
        ${data.trackingNumber ? `
        <div class="item-row">
          <span>${isAr ? 'رقم التتبع' : 'Tracking Number'}</span>
          <span style="font-family: monospace; font-weight: bold; color: #2563EB;">${data.trackingNumber}</span>
        </div>` : ''}
        ${data.shippingAddress ? `
        <div class="item-row">
          <span>${isAr ? 'عنوان التسليم' : 'Delivery Address'}</span>
          <span>${data.shippingAddress}</span>
        </div>` : ''}
      </div>
    `;

    const text = isAr
      ? `طلبك رقم #${orderNum} تم شحنه وهو في الطريق إليك مع ${data.carrierName || 'سوقناا إكسبريس'}.\nتتبع الشحنة: ${actionUrl}`
      : `Your order #${orderNum} has shipped with ${data.carrierName || 'Souqnaa Express'}.\nTrack delivery: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'شحنتك في الطريق 🚀' : 'Order Dispatched 🚀',
        badge: isAr ? 'تم الشحن' : 'Shipped',
        badgeColor: '#0284C7',
        contentHtml,
        actionButton: {
          text: isAr ? 'تتبع مسار الشحنة على الخريطة' : 'Track Shipment on Live Map',
          url: actionUrl,
          color: '#0284C7',
        },
      }),
      text,
    };
  },

  // 8. Order Delivered Template
  ORDER_DELIVERED: (locale, data) => {
    const isAr = locale === 'ar';
    const orderNum = data.orderNumber || 'SQ-1001';
    const subject = isAr ? `تم تسليم طلبك بنجاح #${orderNum} ✅` : `Order Delivered Successfully #${orderNum} ✅`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/orders/${data.orderId || orderNum}/review`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `يسعدنا إبلاغك بأنه تم تسليم طلبك رقم <strong>#${orderNum}</strong> بنجاح. نتمنى أن تنال المنتجات رضاك التام!`
          : `We are happy to confirm that your order <strong>#${orderNum}</strong> has been delivered. We hope you love your purchase!`}
      </p>
      <div class="details-box" style="text-align: center; padding: 24px;">
        <h4 style="margin: 0 0 8px 0; color: #0F172A; font-size: 16px;">
          ${isAr ? 'ما رأيك في تجربة التسوق؟' : 'How was your shopping experience?'}
        </h4>
        <p style="margin: 0 0 16px 0; font-size: 13px; color: #64748B;">
          ${isAr ? 'تقييمك يساعد المشترين الآخرين ويدعم التاجر المحلي' : 'Your feedback helps other shoppers and supports local vendors'}
        </p>
        <div style="font-size: 28px; color: #F59E0B; letter-spacing: 4px;">
          ⭐⭐⭐⭐⭐
        </div>
      </div>
    `;

    const text = isAr
      ? `تم تسليم طلبك رقم #${orderNum} بنجاح. شاركنا تقييمك للمنتجات والمتجر: ${actionUrl}`
      : `Order #${orderNum} has been delivered. Leave a review for your items: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'تم استلام الطلب ✅' : 'Order Delivered ✅',
        badge: isAr ? 'مكتمل' : 'Completed',
        badgeColor: '#10B981',
        contentHtml,
        actionButton: {
          text: isAr ? 'تقييم المنتجات والمتجر ⭐' : 'Rate & Review Order ⭐',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 9. Refund Completed Template
  REFUND_COMPLETED: (locale, data) => {
    const isAr = locale === 'ar';
    const currency = data.currency || (isAr ? 'ر.ي' : 'YER');
    const amount = (data.refundAmount || 0).toLocaleString();
    const subject = isAr ? `تمت معالجة استرجاع المبلغ بنجاح #${data.orderNumber || ''} 💰` : `Refund Processed Successfully #${data.orderNumber || ''} 💰`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/wallet`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `نود إعلامك بأنه تم قبول ومعالجة طلب الاسترجاع للطلب رقم <strong>#${data.orderNumber || ''}</strong> وإيداع المبلغ في رصيدك.`
          : `We would like to inform you that your refund request for order <strong>#${data.orderNumber || ''}</strong> has been processed successfully.`}
      </p>
      <div class="details-box">
        <div class="item-row">
          <span>${isAr ? 'المبلغ المسترجع' : 'Refunded Amount'}</span>
          <span style="color: #10B981; font-weight: bold; font-size: 16px;">${amount} ${currency}</span>
        </div>
        <div class="item-row">
          <span>${isAr ? 'وجهة الإيداع' : 'Refund Destination'}</span>
          <span>${data.paymentMethod || (isAr ? 'محفظة سوقناا الرقمية' : 'Souqnaa Customer Wallet')}</span>
        </div>
        ${data.refundReason ? `
        <div class="item-row">
          <span>${isAr ? 'سبب الاسترجاع' : 'Refund Reason'}</span>
          <span>${data.refundReason}</span>
        </div>` : ''}
      </div>
    `;

    const text = isAr
      ? `تمت معالجة استرجاع مبلغ ${amount} ${currency} للطلب #${data.orderNumber || ''}.\nتفاصيل المحفظة: ${actionUrl}`
      : `Refund of ${amount} ${currency} processed for order #${data.orderNumber || ''}.\nCheck wallet: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'تم استرجاع المبلغ لمحفظتك 💰' : 'Refund Processed 💰',
        badge: isAr ? 'استرجاع معتمد' : 'Refund Approved',
        badgeColor: '#10B981',
        contentHtml,
        actionButton: {
          text: isAr ? 'فحص رصيد المحفظة' : 'Check Wallet Balance',
          url: actionUrl,
        },
      }),
      text,
    };
  },

  // 10. Voucher Template
  VOUCHER: (locale, data) => {
    const isAr = locale === 'ar';
    const code = data.voucherCode || 'SOUQNAA2026';
    const discount = data.discountValue || '20%';
    const subject = isAr ? `هدية لك: كوبون خصم بقيمة ${discount} 🎁` : `Special Gift: ${discount} Discount Voucher 🎁`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/vouchers`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `تقديراً لتسوقك معنا، نقدم لك قسيمة خصم مميزة يمكنك استخدامها عند إتمام طلبك القادم في منصة سوقناا!`
          : `As a token of appreciation, here is an exclusive discount voucher to use on your next checkout at Souqnaa!`}
      </p>
      <div class="code-box" style="border-color: #9333EA; color: #7E22CE; background-color: #FAF5FF;">
        ${code}
      </div>
      <div class="details-box">
        <div class="item-row">
          <span>${isAr ? 'قيمة الخصم' : 'Discount'}</span>
          <span style="font-weight: bold; color: #7E22CE;">${discount}</span>
        </div>
        ${data.minSpend ? `
        <div class="item-row">
          <span>${isAr ? 'الحد الأدنى للشراء' : 'Minimum Spend'}</span>
          <span>${data.minSpend}</span>
        </div>` : ''}
        ${data.expiresAt ? `
        <div class="item-row">
          <span>${isAr ? 'تاريخ انتهاء الصلاحية' : 'Expires On'}</span>
          <span style="color: #DC2626;">${data.expiresAt}</span>
        </div>` : ''}
      </div>
    `;

    const text = isAr
      ? `كوبون خصم حصري لك: ${code} بقيمة ${discount}.\nاستخدمه عند الشراء من سوقناا: ${actionUrl}`
      : `Exclusive voucher: ${code} for ${discount} off.\nRedeem at Souqnaa: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'كوبون خصم حصري بانتظارك 🏷️' : 'Exclusive Voucher For You 🏷️',
        badge: isAr ? 'هدية حصرية' : 'Exclusive Offer',
        badgeColor: '#9333EA',
        contentHtml,
        actionButton: {
          text: isAr ? 'تطبيق الكوبون والتسوق الآن' : 'Apply Voucher & Shop',
          url: actionUrl,
          color: '#9333EA',
        },
      }),
      text,
    };
  },

  // 11. Promotion Template
  PROMOTION: (locale, data) => {
    const isAr = locale === 'ar';
    const title = data.promotionTitle || (isAr ? 'عروض نهاية الأسبوع المذهلة' : 'Weekend Mega Deals');
    const subject = isAr ? `عرض خاص: ${title} 🔥` : `Special Deal: ${title} 🔥`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/promotions`;

    const contentHtml = `
      <p class="lead-text">
        ${data.promotionDescription || (isAr
          ? 'اكتشف أقوى التخفيضات الحصرية على آلاف المنتجات الإلكترونية، الأزياء، ومستلزمات المنزل مع خصومات تصل حتى 50% لفترة محدودة.'
          : 'Discover massive savings on electronics, fashion, and home essentials with discounts up to 50% for a limited time.')}
      </p>
      <div class="details-box" style="text-align: center; background: linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 100%); border-color: #FDBA74;">
        <h3 style="margin: 0 0 6px 0; color: #EA580C; font-size: 20px;">
          ${title}
        </h3>
        <p style="margin: 0; color: #9A3412; font-size: 14px;">
          ${isAr ? 'عروض حصرية ولفترة محدودة حتى نفاذ الكمية' : 'Exclusive offers available while stocks last'}
        </p>
      </div>
    `;

    const text = isAr
      ? `عرض خاص من سوقناا: ${title}\nتصفح العروض الآن: ${actionUrl}`
      : `Special offer from Souqnaa: ${title}\nExplore deals now: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title,
        badge: isAr ? 'عروض حصرية' : 'Hot Deals',
        badgeColor: '#EA580C',
        contentHtml,
        actionButton: {
          text: isAr ? 'استعراض كل العروض الآن ⚡' : 'Shop Deals Now ⚡',
          url: actionUrl,
          color: '#EA580C',
        },
      }),
      text,
    };
  },

  // 12. Campaign Template
  CAMPAIGN: (locale, data) => {
    const isAr = locale === 'ar';
    const campaignName = data.campaignName || (isAr ? 'موسم التخفيضات الكبرى 🌟' : 'Mega Seasonal Sale 🌟');
    const discount = data.campaignDiscount || '70%';
    const subject = isAr ? `انطلاق ${campaignName} - خصومات تصل ${discount}! 🎊` : `${campaignName} is Live - Up to ${discount} Off! 🎊`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/campaigns`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? `بدأت الآن أضخم حملات التسوق في المنصة: <strong>${campaignName}</strong>! تمتع بخصومات غير مسبوقة وكوبونات إضافية وشحن مجاني للطلبات المؤهلة عبر مئات المتاجر المشاركة.`
          : `The biggest shopping festival is officially here: <strong>${campaignName}</strong>! Enjoy unmatched discounts, bonus vouchers, and free shipping on eligible orders across hundreds of participating stores.`}
      </p>
      <div class="details-box" style="text-align: center; background: #0F172A; color: #FFFFFF; border: none;">
        <h2 style="margin: 0 0 6px 0; font-size: 32px; color: #F59E0B; font-weight: 800;">
          ${isAr ? `خصومات حتى ${discount}` : `UP TO ${discount} OFF`}
        </h2>
        <p style="margin: 0; color: #94A3B8; font-size: 14px;">
          ${isAr ? 'عروض فلاش سيل كل 4 ساعات وكوبونات شحن مجاني' : 'Flash sales refreshed every 4 hours + free shipping vouchers'}
        </p>
      </div>
    `;

    const text = isAr
      ? `${campaignName}: خصومات تصل حتى ${discount} على منصة سوقناا!\nتصفح الحملة: ${actionUrl}`
      : `${campaignName}: Up to ${discount} off on Souqnaa!\nShop the campaign: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: campaignName,
        badge: isAr ? 'مهرجان التخفيضات' : 'Mega Festival',
        badgeColor: '#D97706',
        contentHtml,
        actionButton: {
          text: isAr ? 'دخول الحملة والتسوق 🛍️' : 'Enter Campaign & Shop 🛍️',
          url: actionUrl,
          color: '#D97706',
        },
      }),
      text,
    };
  },

  // 13. Seller Notification Template
  SELLER_NOTIFICATION: (locale, data) => {
    const isAr = locale === 'ar';
    const title = data.sellerTitle || (isAr ? 'إشعار جديد لمتجرك' : 'New Store Alert');
    const message = data.sellerMessage || (isAr ? 'لديك طلب جديد بحاجة للمراجعة والتجهيز.' : 'You have a new order waiting for fulfillment.');
    const subject = isAr ? `بوابة التاجر: ${title} 🏪` : `Seller Hub: ${title} 🏪`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/seller/dashboard`;

    const contentHtml = `
      <p class="lead-text">${message}</p>
      ${data.orderNumber ? `
      <div class="details-box">
        <div class="item-row">
          <span>${isAr ? 'رقم الطلب' : 'Order Number'}</span>
          <span><strong>#${data.orderNumber}</strong></span>
        </div>
        ${data.totalAmount ? `
        <div class="item-row">
          <span>${isAr ? 'عائد المتجر الصافي' : 'Seller Payout'}</span>
          <span style="color: #10B981; font-weight: bold;">${data.totalAmount.toLocaleString()} ${data.currency || (isAr ? 'ر.ي' : 'YER')}</span>
        </div>` : ''}
      </div>` : ''}
    `;

    const text = isAr
      ? `بوابة التاجر سوقناا - ${title}:\n${message}\nلوحة التحكم: ${actionUrl}`
      : `Souqnaa Seller Hub - ${title}:\n${message}\nDashboard: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title,
        badge: isAr ? 'بوابة البائع' : 'Seller Portal',
        badgeColor: '#4F46E5',
        contentHtml,
        actionButton: {
          text: isAr ? 'فتح لوحة تحكم التاجر' : 'Open Seller Dashboard',
          url: actionUrl,
          color: '#4F46E5',
        },
      }),
      text,
    };
  },

  // 14. Security Alert Template
  SECURITY_ALERT: (locale, data) => {
    const isAr = locale === 'ar';
    const alertType = data.alertType || (isAr ? 'تسجيل دخول جديد لحسابك' : 'New Login Detected');
    const subject = isAr ? `تنبيه أمان: ${alertType} ⚠️` : `Security Alert: ${alertType} ⚠️`;
    const actionUrl = data.actionUrl || `https://souqnaa.com/profile/security`;

    const contentHtml = `
      <p class="lead-text">
        ${isAr
          ? 'تم رصد نشاط أمني جديد على حسابك في منصة سوقناا. يرجى مراجعة التفاصيل أدناه للتأكد من أنك صاحب هذا النشاط.'
          : 'A new security event was detected on your Souqnaa account. Please review the details below to confirm it was you.'}
      </p>
      <div class="details-box" style="border-left: 4px solid #EF4444; border-right: ${isAr ? '4px solid #EF4444' : 'none'};">
        <div class="item-row">
          <span>${isAr ? 'نوع النشاط' : 'Event Type'}</span>
          <span><strong>${alertType}</strong></span>
        </div>
        ${data.timestamp ? `
        <div class="item-row">
          <span>${isAr ? 'الوقت والتاريخ' : 'Timestamp'}</span>
          <span>${data.timestamp}</span>
        </div>` : ''}
        ${data.ipAddress ? `
        <div class="item-row">
          <span>${isAr ? 'عنوان IP' : 'IP Address'}</span>
          <span style="font-family: monospace;">${data.ipAddress}</span>
        </div>` : ''}
        ${data.deviceInfo ? `
        <div class="item-row">
          <span>${isAr ? 'الجهاز / المتصفح' : 'Device / Browser'}</span>
          <span>${data.deviceInfo}</span>
        </div>` : ''}
      </div>
      <p style="font-size: 13px; color: #DC2626; margin-top: 12px;">
        ${isAr 
          ? 'إذا لم تكن أنت من قام بهذا الإجراء، يرجى تغيير كلمة المرور فوراً والتواصل مع فريق الأمان.' 
          : 'If you did not perform this action, please change your password immediately and contact support.'}
      </p>
    `;

    const text = isAr
      ? `تنبيه أمان في سوقناا: ${alertType}.\nالوقت: ${data.timestamp || ''} | IP: ${data.ipAddress || ''}\nإذا لم تكن أنت، قم بتأمين حسابك: ${actionUrl}`
      : `Souqnaa Security Alert: ${alertType}.\nTime: ${data.timestamp || ''} | IP: ${data.ipAddress || ''}\nSecure your account: ${actionUrl}`;

    return {
      subject,
      html: wrapEmailLayout({
        locale,
        title: isAr ? 'تنبيه أمان عاجل ⚠️' : 'Security Alert ⚠️',
        badge: isAr ? 'حماية الحساب' : 'Security Alert',
        badgeColor: '#EF4444',
        contentHtml,
        actionButton: {
          text: isAr ? 'تأمين الحساب ومراجعة الأجهزة' : 'Secure Account & Devices',
          url: actionUrl,
          color: '#EF4444',
        },
      }),
      text,
    };
  },
};

/**
 * Public renderer method for business services:
 * Zero HTML in business services — services only pass the template key, locale, and structured data.
 */
export function renderEmailTemplate(
  key: EmailTemplateKey,
  locale: LocaleCode = 'ar',
  data: EmailTemplateData = {}
): RenderedEmail {
  const templateFn = EmailTemplates[key] || EmailTemplates.WELCOME;
  return templateFn(locale, data);
}
