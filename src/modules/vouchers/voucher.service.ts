import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { VoucherValidationService, VoucherValidationError } from './services/voucher-validation.service';
import { VoucherClaimService } from './services/voucher-claim.service';
import { VoucherCalculationService } from './services/voucher-calculation.service';
import { VoucherRecommendationService } from './services/voucher-recommendation.service';
import { VoucherRedemptionService } from './services/voucher-redemption.service';
import { VoucherFundingService } from './services/voucher-funding.service';
import { VoucherAnalyticsService } from './services/voucher-analytics.service';
import { CartEvaluationItem, VoucherErrorCode } from './voucher.types';

export class VoucherService {
  /**
   * Create a new Voucher (Admin or Seller)
   */
  public static async createVoucher(data: {
    code: string;
    name: string;
    description?: string;
    ownerType: 'PLATFORM' | 'SELLER';
    ownerId?: string;
    voucherType: 'DISCOUNT' | 'FREE_SHIPPING' | 'DISCOUNT_AND_FREE_SHIPPING' | 'CASHBACK';
    discountType: 'PERCENTAGE' | 'FIXED';
    discountValue: number;
    maximumDiscount?: number;
    minimumOrderAmount?: number;
    minimumEligibleAmount?: number;
    currency?: string;
    scopeType: 'PLATFORM' | 'SELLER' | 'STORE' | 'PRODUCT' | 'CATEGORY' | 'PRODUCT_SET' | 'CART';
    isClaimable?: boolean;
    isAutoApply?: boolean;
    isStackable?: boolean;
    priority?: number;
    usageLimit?: number;
    claimLimit?: number;
    perCustomerClaimLimit?: number;
    perCustomerUsageLimit?: number;
    startAt: Date;
    endAt: Date;
    status?: 'DRAFT' | 'ACTIVE';
    firstOrderOnly?: boolean;
    newCustomerOnly?: boolean;
    sellerId?: string;
    fundingType?: 'PLATFORM' | 'SELLER';
    freeShipping?: boolean;
    maximumShippingDiscount?: number;
    productIds?: string[];
    categoryIds?: string[];
    createdBy?: string;
  }) {
    VoucherValidationService.validateCodeFormat(data.code);
    const normalizedCode = VoucherValidationService.normalizeCode(data.code);

    // Normalize discountType if FIXED_AMOUNT was passed
    const discountType: 'PERCENTAGE' | 'FIXED' =
      (data.discountType as any) === 'FIXED_AMOUNT' ? 'FIXED' : (data.discountType || 'PERCENTAGE');

    // Normalize voucherType and scopeType in case caller passed scope as voucherType (e.g. 'STORE', 'SELLER')
    let voucherType: 'DISCOUNT' | 'FREE_SHIPPING' | 'DISCOUNT_AND_FREE_SHIPPING' | 'CASHBACK' = 'DISCOUNT';
    let scopeType = data.scopeType || 'SELLER';

    const rawType = String(data.voucherType || '').toUpperCase();
    if (['STORE', 'SELLER', 'PRODUCT', 'CATEGORY', 'PRODUCT_SET', 'CART', 'PLATFORM'].includes(rawType)) {
      scopeType = rawType as any;
      voucherType = 'DISCOUNT';
    } else if (['DISCOUNT', 'FREE_SHIPPING', 'DISCOUNT_AND_FREE_SHIPPING', 'CASHBACK'].includes(rawType)) {
      voucherType = rawType as any;
    }

    // Verify unique code
    const existing = await prisma.voucher.findUnique({
      where: { normalizedCode },
    });
    if (existing) {
      throw new AppError(`رمز القسيمة (${data.code}) موجود مسبقاً، يرجى اختيار رمز آخر`, 400, 'VOUCHER_CODE_EXISTS');
    }

    // Ensure startAt < endAt
    if (new Date(data.startAt) >= new Date(data.endAt)) {
      throw new AppError('تاريخ انتهاء القسيمة يجب أن يكون بعد تاريخ البدء', 400);
    }

    // Create voucher with relation records
    return await prisma.voucher.create({
      data: {
        code: data.code.trim(),
        normalizedCode,
        name: data.name,
        description: data.description,
        ownerType: data.ownerType,
        ownerId: data.ownerId,
        voucherType,
        discountType,
        discountValue: data.discountValue,
        maximumDiscount: data.maximumDiscount,
        minimumOrderAmount: data.minimumOrderAmount ?? 0,
        minimumEligibleAmount: data.minimumEligibleAmount ?? 0,
        currency: data.currency ?? 'SAR',
        scopeType,
        isClaimable: data.isClaimable ?? true,
        isAutoApply: data.isAutoApply ?? false,
        isStackable: data.isStackable ?? false,
        priority: data.priority ?? 0,
        usageLimit: data.usageLimit,
        claimLimit: data.claimLimit,
        perCustomerClaimLimit: data.perCustomerClaimLimit ?? 1,
        perCustomerUsageLimit: data.perCustomerUsageLimit ?? 1,
        startAt: new Date(data.startAt),
        endAt: new Date(data.endAt),
        status: data.status ?? 'ACTIVE',
        firstOrderOnly: data.firstOrderOnly ?? false,
        newCustomerOnly: data.newCustomerOnly ?? false,
        sellerId: data.sellerId,
        fundingType: data.fundingType ?? (data.ownerType === 'SELLER' ? 'SELLER' : 'PLATFORM'),
        freeShipping: data.freeShipping ?? (data.voucherType === 'FREE_SHIPPING'),
        maximumShippingDiscount: data.maximumShippingDiscount,
        createdBy: data.createdBy,
        products:
          data.productIds && data.productIds.length > 0
            ? {
                create: data.productIds.map((pId) => ({
                  productId: pId,
                })),
              }
            : undefined,
        categories:
          data.categoryIds && data.categoryIds.length > 0
            ? {
                create: data.categoryIds.map((cId) => ({
                  categoryId: cId,
                })),
              }
            : undefined,
      },
      include: {
        products: { include: { product: true } },
        categories: { include: { category: true } },
      },
    });
  }

  /**
   * Update voucher (Admin or Seller)
   */
  public static async updateVoucher(id: string, data: any, callerSellerId?: string) {
    const voucher = await prisma.voucher.findUnique({ where: { id } });
    if (!voucher) throw new AppError('القسيمة غير موجودة', 404);

    if (callerSellerId && voucher.sellerId !== callerSellerId && voucher.ownerId !== callerSellerId) {
      throw new AppError('غير مصرح لك بتعديل هذه القسيمة', 403);
    }

    const updatePayload: any = { ...data };
    if (data.code) {
      VoucherValidationService.validateCodeFormat(data.code);
      updatePayload.normalizedCode = VoucherValidationService.normalizeCode(data.code);
      updatePayload.code = data.code.trim();
    }
    if (data.startAt) updatePayload.startAt = new Date(data.startAt);
    if (data.endAt) updatePayload.endAt = new Date(data.endAt);

    delete updatePayload.productIds;
    delete updatePayload.categoryIds;

    return await prisma.voucher.update({
      where: { id },
      data: updatePayload,
      include: {
        products: true,
        categories: true,
      },
    });
  }

  /**
   * Status updates
   */
  public static async setVoucherStatus(
    id: string,
    status: 'ACTIVE' | 'PAUSED' | 'DISABLED',
    callerSellerId?: string
  ) {
    const voucher = await prisma.voucher.findUnique({ where: { id } });
    if (!voucher) throw new AppError('القسيمة غير موجودة', 404);

    if (callerSellerId && voucher.sellerId !== callerSellerId && voucher.ownerId !== callerSellerId) {
      throw new AppError('غير مصرح لك بتعديل هذه القسيمة', 403);
    }

    return await prisma.voucher.update({
      where: { id },
      data: { status },
    });
  }

  /**
   * Discover vouchers for Voucher Center
   */
  public static async getVoucherCenterVouchers(params: {
    customerId?: string;
    category?: string; // ALL, FREE_SHIPPING, PLATFORM, SELLER
  }) {
    const now = new Date();
    const where: any = {
      status: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gt: now },
      isClaimable: true,
    };

    if (params.category === 'FREE_SHIPPING') {
      where.voucherType = 'FREE_SHIPPING';
    } else if (params.category === 'PLATFORM') {
      where.ownerType = 'PLATFORM';
    } else if (params.category === 'SELLER') {
      where.ownerType = 'SELLER';
    }

    const vouchers = await prisma.voucher.findMany({
      where,
      include: {
        seller: {
          include: {
            stores: {
              select: { id: true, name: true, logo: true, slug: true },
            },
          },
        },
        products: {
          take: 3,
          include: { product: { select: { id: true, nameAr: true, nameEn: true, slug: true } } },
        },
        categories: {
          include: { category: { select: { id: true, nameAr: true, nameEn: true, slug: true } } },
        },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });

    // Check claim status for this customer
    let claimedSet = new Set<string>();
    if (params.customerId) {
      const userClaims = await prisma.customerVoucher.findMany({
        where: { customerId: params.customerId, status: 'CLAIMED' },
        select: { voucherId: true },
      });
      claimedSet = new Set(userClaims.map((c) => c.voucherId));
    }

    return vouchers.map((v) => ({
      ...v,
      isClaimed: claimedSet.has(v.id),
      isDepleted: v.usageLimit ? v.usageCount >= v.usageLimit : false,
    }));
  }

  /**
   * Find vouchers applicable to a specific product
   */
  public static async getProductVouchers(productId: string, sellerId?: string, customerId?: string) {
    const now = new Date();
    const vouchers = await prisma.voucher.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gt: now },
        OR: [
          { scopeType: 'PLATFORM' },
          { scopeType: 'CART' },
          { products: { some: { productId } } },
          ...(sellerId ? [{ scopeType: 'SELLER' as const, sellerId }] : []),
        ],
      },
      include: {
        seller: { include: { stores: true } },
      },
      orderBy: [{ priority: 'desc' }, { discountValue: 'desc' }],
    });

    let claimedSet = new Set<string>();
    if (customerId) {
      const userClaims = await prisma.customerVoucher.findMany({
        where: { customerId, status: 'CLAIMED' },
        select: { voucherId: true },
      });
      claimedSet = new Set(userClaims.map((c) => c.voucherId));
    }

    return vouchers.map((v) => ({
      ...v,
      isClaimed: claimedSet.has(v.id),
    }));
  }

  /**
   * Find store/seller vouchers
   */
  public static async getStoreVouchers(sellerId: string, customerId?: string) {
    const now = new Date();
    // Allow either sellerId or storeId to be passed
    const store = await prisma.store.findFirst({
      where: { OR: [{ id: sellerId }, { sellerId }] },
      select: { id: true, sellerId: true },
    });
    const effectiveSellerId = store?.sellerId || sellerId;
    const effectiveStoreId = store?.id;

    const vouchers = await prisma.voucher.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { sellerId: effectiveSellerId },
          { ownerId: effectiveSellerId },
          ...(effectiveStoreId ? [{ ownerId: effectiveStoreId }, { sellerId: effectiveStoreId }] : []),
        ],
        startAt: { lte: now },
        endAt: { gt: now },
      },
      include: {
        seller: { include: { stores: true } },
      },
      orderBy: [{ priority: 'desc' }, { discountValue: 'desc' }],
    });

    let claimedSet = new Set<string>();
    if (customerId && vouchers.length > 0) {
      const userClaims = await prisma.customerVoucher.findMany({
        where: {
          customerId,
          voucherId: { in: vouchers.map((v) => v.id) },
          status: 'CLAIMED',
        },
        select: { voucherId: true },
      });
      claimedSet = new Set(userClaims.map((c) => c.voucherId));
    }

    return vouchers.map((v) => ({
      ...v,
      isClaimed: claimedSet.has(v.id),
    }));
  }

  /**
   * Validate a single voucher code entered by customer
   */
  public static async validateCode(code: string, customerId?: string, items?: CartEvaluationItem[]) {
    const normalizedCode = VoucherValidationService.normalizeCode(code);
    const voucher = await prisma.voucher.findUnique({
      where: { normalizedCode },
      include: { products: true, categories: true, seller: true },
    });

    if (!voucher) {
      throw new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_FOUND);
    }

    if (items && items.length > 0) {
      const subtotal = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
      const val = await VoucherValidationService.validateVoucherForCart({
        voucher,
        customerId,
        items,
        subtotal,
      });
      if (!val.isValid && val.error) {
        throw val.error;
      }
    }

    return voucher;
  }
}
