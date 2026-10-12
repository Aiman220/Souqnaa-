import { AppError } from '../../../middleware/error.middleware';

/**
 * Provider Capability & Contract Definition
 * Central Bank of Yemen electronic money regulatory compliance:
 * Operations requiring automated debit/payout are disabled unless official
 * verified merchant API documentation, certificates, and credentials are supplied.
 */
export interface ProviderCapabilities {
  supportsPayment: boolean;
  supportsVerification: boolean;
  supportsRefund: boolean;
  supportsWebhook: boolean;
  supportsPayout: boolean;
  supportsWalletTransfer: boolean;
  supportsManualDeposit: boolean;
}

export interface PaymentProviderAdapter {
  code: string;
  nameAr: string;
  nameEn: string;
  capabilities: ProviderCapabilities;
  merchantWalletNumber: string;
  merchantAccountName: string;

  validateWalletNumber(walletNumber: string): { isValid: boolean; normalized?: string; error?: string };
  maskWalletNumber(walletNumber: string): string;
  initiatePayment(params: { orderId: string; amount: number; currency: string; customerPhone?: string }): Promise<{
    success: boolean;
    requiresManualTransfer: boolean;
    paymentInstructionsAr: string;
    paymentInstructionsEn: string;
    merchantWalletNumber: string;
    merchantAccountName: string;
  }>;
  executeRefund(params: {
    refundId: string;
    amount: number;
    currency: string;
    destinationWalletNumber: string;
  }): Promise<{
    success: boolean;
    requiresManualTransfer: boolean;
    reason?: string;
  }>;
}

abstract class BaseYemeniWalletAdapter implements PaymentProviderAdapter {
  abstract code: string;
  abstract nameAr: string;
  abstract nameEn: string;
  abstract merchantWalletNumber: string;
  abstract merchantAccountName: string;

  // By default, providers without official verified direct API integrations have automated APIs disabled.
  get capabilities(): ProviderCapabilities {
    return {
      supportsPayment: false,
      supportsVerification: false,
      supportsRefund: false,
      supportsWebhook: false,
      supportsPayout: false,
      supportsWalletTransfer: true,
      supportsManualDeposit: true,
    };
  }

  /**
   * Validates Yemeni phone/wallet number format:
   * 9 digits starting with 77, 78, 73, 71, 70, or account number up to 12 digits.
   */
  validateWalletNumber(walletNumber: string): { isValid: boolean; normalized?: string; error?: string } {
    if (!walletNumber || typeof walletNumber !== 'string') {
      return { isValid: false, error: 'رقم المحفظة مطلوب' };
    }
    const clean = walletNumber.trim().replace(/[\s\-]/g, '');

    // Standard Yemeni mobile numbers: 70, 71, 73, 77, 78 + 7 digits = 9 digits total
    const yemeniMobileRegex = /^(?:(?:\+|00)?967)?(7[01378]\d{7})$/;
    const mobileMatch = clean.match(yemeniMobileRegex);
    if (mobileMatch) {
      return { isValid: true, normalized: mobileMatch[1] };
    }

    // Bank/Microfinance account number format (7 to 12 digits)
    const accountRegex = /^\d{7,12}$/;
    if (accountRegex.test(clean)) {
      return { isValid: true, normalized: clean };
    }

    return {
      isValid: false,
      error: 'رقم المحفظة/الحساب غير صحيح. يرجى إدخال رقم هاتف يمني صحيح (9 أرقام يبدأ بـ 7) أو رقم حساب معتمد.',
    };
  }

  maskWalletNumber(walletNumber: string): string {
    if (!walletNumber) return '';
    const clean = walletNumber.trim();
    if (clean.length <= 4) return '****';
    const firstTwo = clean.slice(0, 2);
    const lastThree = clean.slice(-3);
    const maskedLength = Math.max(3, clean.length - 5);
    return `${firstTwo}${'*'.repeat(maskedLength)}${lastThree}`;
  }

  async initiatePayment(params: { orderId: string; amount: number; currency: string; customerPhone?: string }) {
    // Since official direct API keys are not supplied, return authoritative manual instructions
    return {
      success: true,
      requiresManualTransfer: true,
      paymentInstructionsAr: `يرجى التحويل من محفظة ${this.nameAr} إلى رقم حساب المنصة: ${this.merchantWalletNumber} باسم: (${this.merchantAccountName})، ثم إدخال رقم مرجع الحوالة وإرفاق إشعار التحويل لتأكيد طلبك.`,
      paymentInstructionsEn: `Please transfer the amount via ${this.nameEn} to merchant account: ${this.merchantWalletNumber} (${this.merchantAccountName}), then submit the transaction reference and receipt proof.`,
      merchantWalletNumber: this.merchantWalletNumber,
      merchantAccountName: this.merchantAccountName,
    };
  }

  async executeRefund(params: {
    refundId: string;
    amount: number;
    currency: string;
    destinationWalletNumber: string;
  }) {
    // Official automated refund API is not connected -> must use MANUAL_WALLET_TRANSFER workflow
    return {
      success: false,
      requiresManualTransfer: true,
      reason: `المزود [${this.nameAr}] لا يدعم استرجاع آلي مباشر بدون توثيق بنكي رسمي. يجب تنفيذ التحويل عبر مسار التحويل الإداري اليدوي المعتمد.`,
    };
  }
}

/**
 * 1. خدمة حاسب من بنك الكريمي
 */
export class KuraimiAdapter extends BaseYemeniWalletAdapter {
  code = 'KURAIMI';
  nameAr = 'خدمة حاسب من بنك الكريمي';
  nameEn = 'Haseb (Kuraimi Bank)';
  merchantWalletNumber = '777000123';
  merchantAccountName = 'سوقناا للتجارة الإلكترونية - حاسب';
}

/**
 * 2. محفظة جوالي
 */
export class JawaliAdapter extends BaseYemeniWalletAdapter {
  code = 'JAWALI';
  nameAr = 'محفظة جوالي';
  nameEn = 'Jawali Wallet';
  merchantWalletNumber = '772333444';
  merchantAccountName = 'سوقناا - جوالي';
}

/**
 * 3. محفظة جيب
 */
export class JaibAdapter extends BaseYemeniWalletAdapter {
  code = 'JAIB';
  nameAr = 'محفظة جيب';
  nameEn = 'Jaib Wallet';
  merchantWalletNumber = '717444555';
  merchantAccountName = 'سوقناا - جيب';
}

/**
 * 4. محفظة ون كاش
 */
export class OneCashAdapter extends BaseYemeniWalletAdapter {
  code = 'ONECASH';
  nameAr = 'محفظة ون كاش';
  nameEn = 'OneCash Wallet';
  merchantWalletNumber = '771222333';
  merchantAccountName = 'سوقناا - ون كاش';
}

/**
 * 5. محفظة فلوسك
 */
export class FloosakAdapter extends BaseYemeniWalletAdapter {
  code = 'FLOOSAK';
  nameAr = 'محفظة فلوسك';
  nameEn = 'Floosak Wallet';
  merchantWalletNumber = '737888111';
  merchantAccountName = 'سوقناا - فلوسك';
}

/**
 * 6. محفظة كاش
 */
export class CashPayAdapter extends BaseYemeniWalletAdapter {
  code = 'CASHPAY';
  nameAr = 'محفظة كاش';
  nameEn = 'Cash Wallet';
  merchantWalletNumber = '770111222';
  merchantAccountName = 'سوقناا للتجارة الإلكترونية - كاش';
}

/**
 * 7. محفظة اليمن
 */
export class YemenWalletAdapter extends BaseYemeniWalletAdapter {
  code = 'YEMEN_WALLET';
  nameAr = 'محفظة اليمن';
  nameEn = 'Yemen Wallet';
  merchantWalletNumber = '737555666';
  merchantAccountName = 'سوقناا - محفظة اليمن';
}

/**
 * 8. محفظة سبأ كاش
 */
export class SabaCashAdapter extends BaseYemeniWalletAdapter {
  code = 'SABA_CASH';
  nameAr = 'محفظة سبأ كاش';
  nameEn = 'Saba Cash Wallet';
  merchantWalletNumber = '776555444';
  merchantAccountName = 'سوقناا - سبأ كاش';
}

/**
 * 9. محفظة بيس
 */
export class PaysAdapter extends BaseYemeniWalletAdapter {
  code = 'PAYS';
  nameAr = 'محفظة بيس';
  nameEn = 'Pays Wallet';
  merchantWalletNumber = '775444333';
  merchantAccountName = 'سوقناا - بيس';
}

/**
 * 10. محفظة إيزي
 */
export class EasyPayAdapter extends BaseYemeniWalletAdapter {
  code = 'EASY_PAY';
  nameAr = 'محفظة إيزي';
  nameEn = 'Easy Pay Wallet';
  merchantWalletNumber = '774333222';
  merchantAccountName = 'سوقناا - إيزي';
}

/**
 * 11. محفظة شامل موني
 */
export class ShamilMoneyAdapter extends BaseYemeniWalletAdapter {
  code = 'SHAMIL_MONEY';
  nameAr = 'محفظة شامل موني';
  nameEn = 'Shamil Money Wallet';
  merchantWalletNumber = '773222111';
  merchantAccountName = 'سوقناا - شامل موني';
}

/**
 * 12. محفظة موبيل موني
 */
export class MobileMoneyAdapter extends BaseYemeniWalletAdapter {
  code = 'MOBILE_MONEY';
  nameAr = 'محفظة موبيل موني';
  nameEn = 'Mobile Money Wallet';
  merchantWalletNumber = '772111000';
  merchantAccountName = 'سوقناا - موبيل موني';
}

/**
 * Central Registry of Yemeni Wallet Adapters
 */
export class WalletProviderRegistry {
  private static adapters: Map<string, PaymentProviderAdapter> = new Map();

  private static init() {
    if (this.adapters.size > 0) return;
    const kuraimi = new KuraimiAdapter();
    const jawali = new JawaliAdapter();
    const jaib = new JaibAdapter();
    const onecash = new OneCashAdapter();
    const floosak = new FloosakAdapter();
    const cashpay = new CashPayAdapter();
    const yemen = new YemenWalletAdapter();
    const saba = new SabaCashAdapter();
    const pays = new PaysAdapter();
    const easy = new EasyPayAdapter();
    const shamil = new ShamilMoneyAdapter();
    const mobile = new MobileMoneyAdapter();

    // Canonical registrations
    this.adapters.set('KURAIMI', kuraimi);
    this.adapters.set('JAWALI', jawali);
    this.adapters.set('JAIB', jaib);
    this.adapters.set('ONECASH', onecash);
    this.adapters.set('FLOOSAK', floosak);
    this.adapters.set('CASHPAY', cashpay);
    this.adapters.set('YEMEN_WALLET', yemen);
    this.adapters.set('SABA_CASH', saba);
    this.adapters.set('PAYS', pays);
    this.adapters.set('EASY_PAY', easy);
    this.adapters.set('SHAMIL_MONEY', shamil);
    this.adapters.set('MOBILE_MONEY', mobile);

    // Aliases & legacy codes
    this.adapters.set('HASEB', kuraimi);
    this.adapters.set('M_FLOOS', kuraimi);
    this.adapters.set('MFLOOS', kuraimi);
    this.adapters.set('CASH', cashpay);
    this.adapters.set('CASH_PAY', cashpay);
    this.adapters.set('WECASH', onecash);
    this.adapters.set('FLOSAK', floosak);
    this.adapters.set('SABACASH', saba);
    this.adapters.set('WEPAY', pays);
    this.adapters.set('EASYPAY', easy);
    this.adapters.set('EASY', easy);
    this.adapters.set('SHAMIL', shamil);
    this.adapters.set('MOBILE', mobile);
    this.adapters.set('MOBILEMONEY', mobile);
    this.adapters.set('YEMEN', yemen);
    this.adapters.set('QUTAIBI', yemen);
  }

  static getAdapter(code: string): PaymentProviderAdapter {
    this.init();
    const key = code.toUpperCase().replace(/\s+/g, '_');
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new AppError(
        `مزود الدفع بالمحفظة [${code}] غير مدعوم أو غير معتمد من البنك المركزي اليمني`,
        400
      );
    }
    return adapter;
  }

  static hasAdapter(code: string): boolean {
    this.init();
    return this.adapters.has(code.toUpperCase().replace(/\s+/g, '_'));
  }

  static listSupportedProviders() {
    this.init();
    // Return unique canonical adapters
    const canonicalCodes = [
      'KURAIMI',
      'JAWALI',
      'JAIB',
      'ONECASH',
      'FLOOSAK',
      'CASHPAY',
      'YEMEN_WALLET',
      'SABA_CASH',
      'PAYS',
      'EASY_PAY',
      'SHAMIL_MONEY',
      'MOBILE_MONEY',
    ];
    return canonicalCodes.map((code) => {
      const a = this.adapters.get(code)!;
      return {
        code: a.code,
        nameAr: a.nameAr,
        nameEn: a.nameEn,
        merchantWalletNumber: a.merchantWalletNumber,
        merchantAccountName: a.merchantAccountName,
        capabilities: a.capabilities,
      };
    });
  }
}
