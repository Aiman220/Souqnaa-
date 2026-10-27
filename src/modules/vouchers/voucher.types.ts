export enum VoucherErrorCode {
  VOUCHER_NOT_FOUND = 'VOUCHER_NOT_FOUND',
  VOUCHER_INVALID = 'VOUCHER_INVALID',
  VOUCHER_EXPIRED = 'VOUCHER_EXPIRED',
  VOUCHER_NOT_ACTIVE = 'VOUCHER_NOT_ACTIVE',
  VOUCHER_NOT_STARTED = 'VOUCHER_NOT_STARTED',
  VOUCHER_USAGE_LIMIT_REACHED = 'VOUCHER_USAGE_LIMIT_REACHED',
  VOUCHER_CLAIM_LIMIT_REACHED = 'VOUCHER_CLAIM_LIMIT_REACHED',
  VOUCHER_CUSTOMER_LIMIT_REACHED = 'VOUCHER_CUSTOMER_LIMIT_REACHED',
  VOUCHER_MINIMUM_ORDER_NOT_MET = 'VOUCHER_MINIMUM_ORDER_NOT_MET',
  VOUCHER_MINIMUM_ELIGIBLE_AMOUNT_NOT_MET = 'VOUCHER_MINIMUM_ELIGIBLE_AMOUNT_NOT_MET',
  VOUCHER_PRODUCT_NOT_ELIGIBLE = 'VOUCHER_PRODUCT_NOT_ELIGIBLE',
  VOUCHER_CATEGORY_NOT_ELIGIBLE = 'VOUCHER_CATEGORY_NOT_ELIGIBLE',
  VOUCHER_SELLER_NOT_ELIGIBLE = 'VOUCHER_SELLER_NOT_ELIGIBLE',
  VOUCHER_CUSTOMER_NOT_ELIGIBLE = 'VOUCHER_CUSTOMER_NOT_ELIGIBLE',
  VOUCHER_FIRST_ORDER_ONLY = 'VOUCHER_FIRST_ORDER_ONLY',
  VOUCHER_NEW_CUSTOMER_ONLY = 'VOUCHER_NEW_CUSTOMER_ONLY',
  VOUCHER_STACKING_NOT_ALLOWED = 'VOUCHER_STACKING_NOT_ALLOWED',
  VOUCHER_CURRENCY_MISMATCH = 'VOUCHER_CURRENCY_MISMATCH',
  VOUCHER_DEPLETED = 'VOUCHER_DEPLETED',
  VOUCHER_ALREADY_CLAIMED = 'VOUCHER_ALREADY_CLAIMED',
  VOUCHER_ALREADY_USED = 'VOUCHER_ALREADY_USED',
  VOUCHER_RESERVATION_FAILED = 'VOUCHER_RESERVATION_FAILED',
  VOUCHER_NOT_COMPATIBLE_WITH_FLASH_SALE = 'VOUCHER_NOT_COMPATIBLE_WITH_FLASH_SALE',
  VOUCHER_FREE_SHIPPING_NOT_ELIGIBLE = 'VOUCHER_FREE_SHIPPING_NOT_ELIGIBLE',
  VOUCHER_RATE_LIMITED = 'VOUCHER_RATE_LIMITED',
}

export const VOUCHER_ERROR_MESSAGES: Record<
  VoucherErrorCode,
  { en: string; ar: string; statusCode: number }
> = {
  [VoucherErrorCode.VOUCHER_NOT_FOUND]: {
    en: 'Voucher not found',
    ar: 'القسيمة غير موجودة',
    statusCode: 404,
  },
  [VoucherErrorCode.VOUCHER_INVALID]: {
    en: 'Voucher code is invalid',
    ar: 'رمز القسيمة غير صالح',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_EXPIRED]: {
    en: 'Voucher has expired',
    ar: 'انتهت صلاحية هذه القسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_NOT_ACTIVE]: {
    en: 'Voucher is currently inactive',
    ar: 'القسيمة غير نشطة حالياً',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_NOT_STARTED]: {
    en: 'Voucher promotion has not started yet',
    ar: 'لم تبدأ فترة استخدام القسيمة بعد',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED]: {
    en: 'Voucher usage limit has been reached',
    ar: 'تم الوصول إلى الحد الأقصى لاستخدام القسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_CLAIM_LIMIT_REACHED]: {
    en: 'Voucher collection limit has been reached',
    ar: 'تم جمع كافة القسائم المتاحة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_CUSTOMER_LIMIT_REACHED]: {
    en: 'You have reached your limit for this voucher',
    ar: 'لقد وصلت إلى الحد الأقصى المسموح به لاستخدام هذه القسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_MINIMUM_ORDER_NOT_MET]: {
    en: 'Minimum order amount for this voucher has not been met',
    ar: 'لم يتم استيفاء الحد الأدنى للطلب لتطبيق القسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_MINIMUM_ELIGIBLE_AMOUNT_NOT_MET]: {
    en: 'Minimum eligible items amount not met for this voucher',
    ar: 'مجموع المنتجات المؤهلة أقل من الحد الأدنى المطلوب للقسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_PRODUCT_NOT_ELIGIBLE]: {
    en: 'None of the items in your cart qualify for this voucher',
    ar: 'لا توجد منتجات في السلة مشمولة بهذا الخصم',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_CATEGORY_NOT_ELIGIBLE]: {
    en: 'Cart items do not belong to the eligible categories',
    ar: 'المنتجات في السلة لا تنتمي للأقسام المشمولة بالقسيمة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_SELLER_NOT_ELIGIBLE]: {
    en: 'This voucher is only valid for items from a specific seller',
    ar: 'هذه القسيمة صالحة فقط لمنتجات هذا المتجر المحدد',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_CUSTOMER_NOT_ELIGIBLE]: {
    en: 'You are not eligible to claim or use this voucher',
    ar: 'أنت غير مؤهل للحصول على هذه القسيمة أو استخدامها',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_FIRST_ORDER_ONLY]: {
    en: 'This voucher is valid for first-time orders only',
    ar: 'هذه القسيمة مخصصة للطلب الأول فقط',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_NEW_CUSTOMER_ONLY]: {
    en: 'This voucher is for new registered customers only',
    ar: 'هذه القسيمة متاحة للعملاء الجدد فقط',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_STACKING_NOT_ALLOWED]: {
    en: 'These vouchers cannot be combined together',
    ar: 'لا يمكن دمج هذه القسائم معاً',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_CURRENCY_MISMATCH]: {
    en: 'Voucher currency does not match cart currency',
    ar: 'عملة القسيمة لا تطابق عملة السلة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_DEPLETED]: {
    en: 'This voucher has been fully depleted',
    ar: 'نفدت هذه القسيمة بالكامل',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_ALREADY_CLAIMED]: {
    en: 'You have already collected this voucher',
    ar: 'لقد قمت بجمع هذه القسيمة مسبقاً',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_ALREADY_USED]: {
    en: 'You have already used this voucher',
    ar: 'لقد استخدمت هذه القسيمة بالفعل',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_RESERVATION_FAILED]: {
    en: 'Could not hold voucher reservation for checkout',
    ar: 'تعذر حجز القسيمة أثناء إتمام الطلب',
    statusCode: 409,
  },
  [VoucherErrorCode.VOUCHER_NOT_COMPATIBLE_WITH_FLASH_SALE]: {
    en: 'This voucher cannot be applied to Flash Sale items',
    ar: 'لا يمكن تطبيق هذه القسيمة على منتجات العروض السريعة',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_FREE_SHIPPING_NOT_ELIGIBLE]: {
    en: 'Cart does not qualify for free shipping discount',
    ar: 'الطلب غير مؤهل لخصم الشحن المجاني',
    statusCode: 400,
  },
  [VoucherErrorCode.VOUCHER_RATE_LIMITED]: {
    en: 'Too many voucher attempts. Please wait a moment.',
    ar: 'محاولات متكررة سريعة. يرجى الانتظار قليلاً.',
    statusCode: 429,
  },
};

export interface CartEvaluationItem {
  id: string;
  cartItemId?: string;
  productId: string;
  variantId?: string | null;
  storeId: string;
  sellerId: string;
  categoryId?: string | null;
  productNameAr: string;
  productNameEn: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number;
  isFlashSale: boolean;
  flashSaleUnitPrice?: number | null;
}

export interface SellerCartBreakdown {
  sellerId: string;
  storeId: string;
  items: CartEvaluationItem[];
  subtotal: number;
  sellerDiscount: number;
  platformDiscount: number;
  sellerVoucher?: any | null;
  netSubtotal: number;
  shippingDiscount?: number;
  shippingFundingType?: 'PLATFORM' | 'SELLER';
}

export interface ItemDiscountAllocation {
  cartItemId?: string;
  orderItemId?: string;
  productId: string;
  sellerId: string;
  voucherId: string;
  discountAmount: number;
  fundingType: 'PLATFORM' | 'SELLER';
}

export interface VoucherCalculationResult {
  currency: string;
  subtotal: number;
  rawShippingFee: number;
  shippingDiscount: number;
  finalShippingFee: number;

  platformDiscount: number;
  sellerDiscount: number;
  totalDiscount: number;

  platformFunding: number;
  sellerFunding: number;

  finalPayableTotal: number;

  appliedVouchers: any[];
  rejectedVouchers: Array<{
    code: string;
    voucherId?: string;
    codeName?: string;
    reasonCode: VoucherErrorCode;
    reasonAr: string;
    reasonEn: string;
  }>;

  allocations: ItemDiscountAllocation[];
  sellerBreakdowns: Record<string, SellerCartBreakdown>;
}
