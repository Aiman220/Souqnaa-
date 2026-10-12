import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import {
  VoucherErrorCode,
  VOUCHER_ERROR_MESSAGES,
  CartEvaluationItem,
} from '../voucher.types';

export class VoucherValidationError extends AppError {
  public code: VoucherErrorCode;
  public messageAr: string;
  public messageEn: string;

  constructor(code: VoucherErrorCode, details?: string) {
    const meta = VOUCHER_ERROR_MESSAGES[code] || {
      en: 'Voucher error',
      ar: 'خطأ في القسيمة',
      statusCode: 400,
    };
    const msg = details ? `${meta.ar}: ${details}` : meta.ar;
    super(msg, meta.statusCode, code);
    this.code = code;
    this.messageEn = details ? `${meta.en} (${details})` : meta.en;
    this.messageAr = msg;
  }
}

export class VoucherValidationService {
  /**
   * Normalize voucher code (trim, uppercase, remove spaces)
   */
  public static normalizeCode(code: string): string {
    if (!code) return '';
    return code.trim().toUpperCase().replace(/[\s\-_]+/g, '');
  }

  /**
   * Validate code format
   */
  public static validateCodeFormat(code: string): void {
    const normalized = this.normalizeCode(code);
    if (!normalized || normalized.length < 3 || normalized.length > 32) {
      throw new VoucherValidationError(
        VoucherErrorCode.VOUCHER_INVALID,
        'يجب أن يتراوح طول الرمز بين 3 و 32 حرفاً'
      );
    }
    const validPattern = /^[A-Z0-9\u0600-\u06FF]+$/;
    if (!validPattern.test(normalized)) {
      throw new VoucherValidationError(
        VoucherErrorCode.VOUCHER_INVALID,
        'رمز القسيمة يجب أن يحتوي على أحرف وأرقام فقط'
      );
    }
    const reservedWords = ['ADMIN', 'NULL', 'UNDEFINED', 'TEST', 'ROOT'];
    if (reservedWords.includes(normalized)) {
      throw new VoucherValidationError(
        VoucherErrorCode.VOUCHER_INVALID,
        'Code uses a reserved word'
      );
    }
  }

  /**
   * Comprehensive validation of a voucher against a customer and cart items
   */
  public static async validateVoucherForCart(params: {
    voucher: any;
    customerId?: string;
    items: CartEvaluationItem[];
    subtotal: number;
    shippingFee?: number;
  }): Promise<{
    isValid: boolean;
    eligibleItems: CartEvaluationItem[];
    eligibleAmount: number;
    error?: VoucherValidationError;
  }> {
    const { voucher, customerId, items, subtotal, shippingFee = 0 } = params;
    const now = new Date();

    // 1. Status check
    if (voucher.status === 'DRAFT' || voucher.status === 'PAUSED' || voucher.status === 'DISABLED') {
      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_ACTIVE),
      };
    }
    if (voucher.status === 'DEPLETED') {
      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(VoucherErrorCode.VOUCHER_DEPLETED),
      };
    }

    // 2. Date checks
    if (new Date(voucher.startAt) > now) {
      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_STARTED),
      };
    }
    if (new Date(voucher.endAt) < now) {
      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(VoucherErrorCode.VOUCHER_EXPIRED),
      };
    }

    // 3. Global usage limit
    if (voucher.usageLimit !== null && voucher.usageLimit !== undefined) {
      if (voucher.usageCount >= voucher.usageLimit) {
        return {
          isValid: false,
          eligibleItems: [],
          eligibleAmount: 0,
          error: new VoucherValidationError(VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED),
        };
      }
    }

    // 4. Customer-specific validations (if user logged in)
    if (customerId) {
      // First order only check
      if (voucher.firstOrderOnly) {
        const orderCount = await prisma.order.count({
          where: {
            userId: customerId,
            status: { notIn: ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'CANCELLED_BY_ADMIN'] },
          },
        });
        if (orderCount > 0) {
          return {
            isValid: false,
            eligibleItems: [],
            eligibleAmount: 0,
            error: new VoucherValidationError(VoucherErrorCode.VOUCHER_FIRST_ORDER_ONLY),
          };
        }
      }

      // New customer only check (registered within last 30 days)
      if (voucher.newCustomerOnly) {
        const user = await prisma.user.findUnique({
          where: { id: customerId },
          select: { createdAt: true },
        });
        if (user) {
          const daysSinceRegistration = (now.getTime() - user.createdAt.getTime()) / (1000 * 3600 * 24);
          if (daysSinceRegistration > 30) {
            return {
              isValid: false,
              eligibleItems: [],
              eligibleAmount: 0,
              error: new VoucherValidationError(VoucherErrorCode.VOUCHER_NEW_CUSTOMER_ONLY),
            };
          }
        }
      }

      // Customer usage limit
      if (voucher.perCustomerUsageLimit) {
        const customerUsage = await prisma.voucherRedemption.count({
          where: {
            voucherId: voucher.id,
            customerId: customerId,
          },
        });
        if (customerUsage >= voucher.perCustomerUsageLimit) {
          return {
            isValid: false,
            eligibleItems: [],
            eligibleAmount: 0,
            error: new VoucherValidationError(VoucherErrorCode.VOUCHER_CUSTOMER_LIMIT_REACHED),
          };
        }
      }
    }

    // 5. Minimum Order Amount Check
    if (voucher.minimumOrderAmount && subtotal < voucher.minimumOrderAmount) {
      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(
          VoucherErrorCode.VOUCHER_MINIMUM_ORDER_NOT_MET,
          `Minimum order of ${voucher.minimumOrderAmount} ${voucher.currency} required`
        ),
      };
    }

    // 6. Free Shipping Eligibility Check
    if (voucher.voucherType === 'FREE_SHIPPING') {
      if (shippingFee <= 0) {
        return {
          isValid: false,
          eligibleItems: [],
          eligibleAmount: 0,
          error: new VoucherValidationError(VoucherErrorCode.VOUCHER_FREE_SHIPPING_NOT_ELIGIBLE),
        };
      }
    }

    // 7. Filter items by scope (Seller, Store, Product, Category)
    const eligibleItems = this.filterEligibleItems(voucher, items);

    if (eligibleItems.length === 0 && voucher.voucherType !== 'FREE_SHIPPING') {
      const scopeError =
        voucher.scopeType === 'SELLER' || voucher.scopeType === 'STORE'
          ? VoucherErrorCode.VOUCHER_SELLER_NOT_ELIGIBLE
          : voucher.scopeType === 'CATEGORY'
          ? VoucherErrorCode.VOUCHER_CATEGORY_NOT_ELIGIBLE
          : VoucherErrorCode.VOUCHER_PRODUCT_NOT_ELIGIBLE;

      return {
        isValid: false,
        eligibleItems: [],
        eligibleAmount: 0,
        error: new VoucherValidationError(scopeError),
      };
    }

    // 8. Calculate eligible subtotal
    const eligibleAmount = eligibleItems.reduce((sum, item) => {
      const price = item.unitPrice;
      return sum + price * item.quantity;
    }, 0);

    // 9. Minimum Eligible Amount Check
    if (voucher.minimumEligibleAmount && eligibleAmount < voucher.minimumEligibleAmount) {
      return {
        isValid: false,
        eligibleItems,
        eligibleAmount,
        error: new VoucherValidationError(
          VoucherErrorCode.VOUCHER_MINIMUM_ELIGIBLE_AMOUNT_NOT_MET,
          `Eligible items total ${eligibleAmount} is below required ${voucher.minimumEligibleAmount} ${voucher.currency}`
        ),
      };
    }

    return {
      isValid: true,
      eligibleItems,
      eligibleAmount,
    };
  }

  /**
   * Filter cart items matching voucher scope
   */
  public static filterEligibleItems(voucher: any, items: CartEvaluationItem[]): CartEvaluationItem[] {
    // Platform-wide voucher applies to all items unless Flash Sale or specific exclusions
    if (voucher.scopeType === 'PLATFORM' || voucher.scopeType === 'CART') {
      return items;
    }

    // Seller / Store Scope
    if (voucher.scopeType === 'SELLER' || voucher.scopeType === 'STORE') {
      const targetSellerId = voucher.sellerId || voucher.ownerId;
      return items.filter((item) => item.sellerId === targetSellerId);
    }

    // Product Scope
    if (voucher.scopeType === 'PRODUCT' || voucher.scopeType === 'PRODUCT_SET') {
      const allowedProductIds = new Set<string>(
        (voucher.products || []).map((p: any) => p.productId)
      );
      const allowedVariantIds = new Set<string>(
        (voucher.products || []).filter((p: any) => p.variantId).map((p: any) => p.variantId)
      );

      return items.filter((item) => {
        if (allowedProductIds.has(item.productId)) {
          if (allowedVariantIds.size > 0 && item.variantId) {
            return allowedVariantIds.has(item.variantId);
          }
          return true;
        }
        return false;
      });
    }

    // Category Scope
    if (voucher.scopeType === 'CATEGORY') {
      const allowedCategoryIds = new Set<string>(
        (voucher.categories || []).map((c: any) => c.categoryId)
      );
      return items.filter((item) => item.categoryId && allowedCategoryIds.has(item.categoryId));
    }

    return items;
  }
}
