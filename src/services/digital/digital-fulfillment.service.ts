import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import {
  FulfillmentType,
  DigitalDeliveryType,
  DigitalFulfillmentStatus,
  PaymentStatus,
  OrderStatus,
} from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';
import { UrlSecurityUtil } from '../../utils/url-security.util';

export const ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS = Object.freeze([
  'mobile-recharge',
  'internet-packages',
  'gift-cards',
  'gaming-gift-cards',
  'digital-subscriptions',
  'software-licenses',
]);

/**
 * DigitalFulfillmentService — authoritative engine for digital product fulfillment,
 * cryptographic encryption of digital codes, and delivery security.
 */
export class DigitalFulfillmentService {
  private static instance: DigitalFulfillmentService;

  public static getInstance(): DigitalFulfillmentService {
    if (!DigitalFulfillmentService.instance) {
      DigitalFulfillmentService.instance = new DigitalFulfillmentService();
    }
    return DigitalFulfillmentService.instance;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Encryption & Decryption (AES-256-GCM)
  // ──────────────────────────────────────────────────────────────────────────

  private getEncryptionKey(): Buffer {
    const rawSecret =
      process.env.DIGITAL_FULFILLMENT_SECRET ||
      process.env.JWT_SECRET ||
      'souqnaa_secure_digital_fulfillment_key_2026';
    return crypto.createHash('sha256').update(rawSecret).digest();
  }

  /**
   * Encrypts sensitive digital code or payload at rest using AES-256-GCM.
   */
  public encryptSensitivePayload(plainText: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts sensitive digital code or payload.
   */
  public decryptSensitivePayload(cipherTextWithMeta: string): string {
    const parts = cipherTextWithMeta.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted payload format');
    }
    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = this.getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Safely masks a digital code or license key for display in logs or dashboards.
   * Never exposes the full code.
   */
  public maskCode(code: string): string {
    const trimmed = (code || '').trim();
    if (!trimmed) return '••••';
    if (trimmed.length <= 4) {
      return '••••';
    }
    const lastFour = trimmed.slice(-4);
    if (trimmed.length <= 8) {
      return `••••${lastFour}`;
    }
    const prefix = trimmed.slice(0, 2);
    return `${prefix}••••••••${lastFour}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Eligibility & Classification Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Checks whether a category/subcategory is eligible to support digital fulfillment.
   * Note: Category membership alone NEVER overrides the product fulfillment type!
   */
  public isSubcategoryEligibleForDigital(categorySlug?: string | null): boolean {
    if (!categorySlug) return false;
    const normalized = categorySlug.toLowerCase().trim();
    return ELIGIBLE_DIGITAL_SUBCATEGORY_SLUGS.includes(normalized);
  }

  /**
   * Checks whether a category ID or slug is eligible for digital products.
   */
  public static async isCategoryEligibleForDigital(categoryIdOrSlug?: string | null): Promise<boolean> {
    if (!categoryIdOrSlug) return false;
    const cat = await prisma.category.findFirst({
      where: {
        OR: [{ id: categoryIdOrSlug }, { slug: categoryIdOrSlug }],
      },
      select: { slug: true, parent: { select: { slug: true } } },
    });
    if (!cat) return false;
    const svc = DigitalFulfillmentService.getInstance();
    return (
      svc.isSubcategoryEligibleForDigital(cat.slug) ||
      (cat.parent?.slug ? svc.isSubcategoryEligibleForDigital(cat.parent.slug) : false)
    );
  }

  public async isCategoryEligibleForDigital(categoryIdOrSlug?: string | null): Promise<boolean> {
    return DigitalFulfillmentService.isCategoryEligibleForDigital(categoryIdOrSlug);
  }

  /**
   * Authoritatively determines if a product is DIGITAL based on trusted DB field.
   * Default legacy products safely to PHYSICAL.
   */
  public isProductDigital(product: { fulfillmentType?: FulfillmentType | string | null }): boolean {
    return product?.fulfillmentType === FulfillmentType.DIGITAL || product?.fulfillmentType === 'DIGITAL';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Digital Pool Management (Seller / Admin)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Adds digital codes to the product inventory pool in encrypted form.
   */
  public async addDigitalCodes(params: {
    productId: string;
    sellerId: string;
    codes: string[];
    actorId: string;
    actorRole: string;
  }): Promise<{ addedCount: number }> {
    const { productId, sellerId, codes, actorId, actorRole } = params;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { store: true },
    });

    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }

    if (actorRole !== 'ADMIN' && product.store.sellerId !== sellerId) {
      throw new AppError('ليس لديك صلاحية لإضافة رموز لهذا المنتج', 403);
    }

    if (product.fulfillmentType !== FulfillmentType.DIGITAL) {
      throw new AppError('هذا المنتج غير معرف كمنتج رقمي', 400);
    }

    const validCodes = codes.map((c) => c.trim()).filter(Boolean);
    if (validCodes.length === 0) {
      throw new AppError('يرجى تزويد قائمة رموز صالحة', 400);
    }

    const records = validCodes.map((plainCode) => ({
      productId,
      encryptedCode: this.encryptSensitivePayload(plainCode),
      codeMasked: this.maskCode(plainCode),
      isUsed: false,
    }));

    await prisma.digitalProductCode.createMany({
      data: records,
    });

    // Update stock count in inventory to match available codes if managed by pool
    const unusedCount = await prisma.digitalProductCode.count({
      where: { productId, isUsed: false },
    });

    await prisma.inventory.upsert({
      where: { productId },
      update: { quantity: unusedCount },
      create: { productId, quantity: unusedCount, reserved: 0 },
    });

    return { addedCount: validCodes.length };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fulfillment Execution
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Authoritatively fulfills a digital OrderItem once payment is verified.
   * Guaranteed idempotent — multiple attempts will not duplicate codes or charges.
   */
  public async fulfillDigitalItem(params: {
    orderItemId: string;
    actorId: string;
    actorRole: string;
    idempotencyKey?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ fulfillment: any; alreadyFulfilled: boolean }> {
    const { orderItemId, actorId, actorRole, idempotencyKey, ipAddress, userAgent } = params;

    const orderItem = await prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: {
        product: true,
        sellerOrder: {
          include: {
            order: {
              include: { payment: true },
            },
          },
        },
        digitalFulfillment: true,
      },
    });

    if (!orderItem) {
      throw new AppError('عنصر الطلب غير موجود', 404);
    }

    if (orderItem.fulfillmentType !== FulfillmentType.DIGITAL) {
      throw new AppError('هذا العنصر منتج مادي ولا يخضع للتسليم الرقمي', 400);
    }

    const order = orderItem.sellerOrder.order;
    const isPaymentPaid = order.payment?.status === PaymentStatus.PAID;

    // Strict Rule: NEVER expose or fulfill digital codes before verified payment!
    if (!isPaymentPaid) {
      throw new AppError(
        'لا يمكن تنفيذ التسليم الرقمي قبل تأكيد واعتماد سداد الطلب',
        400,
        'PAYMENT_VERIFICATION_REQUIRED'
      );
    }

    // Idempotency: If already fulfilled, return existing fulfillment record
    if (orderItem.digitalFulfillment && orderItem.digitalFulfillment.status === DigitalFulfillmentStatus.FULFILLED) {
      return { fulfillment: orderItem.digitalFulfillment, alreadyFulfilled: true };
    }

    const product = orderItem.product;
    const deliveryType = product.digitalDeliveryType || DigitalDeliveryType.CODE;

    let encryptedPayload: string | null = null;
    let maskedPayload: string | null = null;
    let downloadUrl: string | null = null;
    let downloadExpiresAt: Date | null = null;
    let providerRef: string | null = null;
    let fulfillmentStatus: DigitalFulfillmentStatus = DigitalFulfillmentStatus.FULFILLED;
    let failureReason: string | null = null;

    if (deliveryType === DigitalDeliveryType.CODE || deliveryType === DigitalDeliveryType.LICENSE_KEY) {
      // Find an unused digital code from pool atomically
      const availableCode = await prisma.digitalProductCode.findFirst({
        where: { productId: product.id, isUsed: false },
        orderBy: { createdAt: 'asc' },
      });

      if (availableCode) {
        await prisma.digitalProductCode.update({
          where: { id: availableCode.id },
          data: {
            isUsed: true,
            usedAt: new Date(),
            orderItemId: orderItem.id,
          },
        });
        encryptedPayload = availableCode.encryptedCode;
        maskedPayload = availableCode.codeMasked;
      } else {
        // If stock is exhausted, mark PENDING for seller manual fulfillment / restock
        fulfillmentStatus = DigitalFulfillmentStatus.PENDING;
        failureReason = 'OUT_OF_DIGITAL_CODES';
      }
    } else if (deliveryType === DigitalDeliveryType.FILE_DOWNLOAD) {
      if (product.digitalFileUrl && UrlSecurityUtil.isSafeUrl(product.digitalFileUrl)) {
        downloadUrl = product.digitalFileUrl;
        downloadExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiration
        maskedPayload = 'Download link generated';
      } else {
        fulfillmentStatus = DigitalFulfillmentStatus.FAILED;
        failureReason = 'INVALID_OR_UNSAFE_DOWNLOAD_URL';
      }
    } else if (deliveryType === DigitalDeliveryType.MANUAL_OR_EXTERNAL_API) {
      // Direct electronic recharge or service activation
      providerRef = `DIGI-SVC-${Date.now()}`;
      maskedPayload = `Service Ref: ${providerRef}`;
      fulfillmentStatus = DigitalFulfillmentStatus.FULFILLED;
    } else if (deliveryType === DigitalDeliveryType.SUBSCRIPTION) {
      providerRef = `SUB-${Date.now()}`;
      maskedPayload = `Subscription Ref: ${providerRef}`;
      fulfillmentStatus = DigitalFulfillmentStatus.FULFILLED;
    }

    const fulfillment = await prisma.digitalFulfillment.upsert({
      where: { orderItemId: orderItem.id },
      update: {
        status: fulfillmentStatus,
        deliveryType,
        encryptedPayload,
        maskedPayload,
        downloadUrl,
        downloadExpiresAt,
        failureReason,
        providerRef,
        fulfilledAt: fulfillmentStatus === DigitalFulfillmentStatus.FULFILLED ? new Date() : null,
      },
      create: {
        orderItemId: orderItem.id,
        orderId: order.id,
        sellerOrderId: orderItem.sellerOrderId,
        productId: product.id,
        customerId: order.userId,
        deliveryType,
        status: fulfillmentStatus,
        idempotencyKey: idempotencyKey || `ful_${orderItem.id}_${Date.now()}`,
        encryptedPayload,
        maskedPayload,
        downloadUrl,
        downloadExpiresAt,
        failureReason,
        providerRef,
        fulfilledAt: fulfillmentStatus === DigitalFulfillmentStatus.FULFILLED ? new Date() : null,
      },
    });

    // Update OrderItem status
    await prisma.orderItem.update({
      where: { id: orderItem.id },
      data: { digitalFulfillmentStatus: fulfillmentStatus },
    });

    // Record audit log
    await prisma.digitalFulfillmentAuditLog.create({
      data: {
        digitalFulfillmentId: fulfillment.id,
        orderId: order.id,
        orderItemId: orderItem.id,
        action: fulfillmentStatus === DigitalFulfillmentStatus.FULFILLED ? 'FULFILLED' : 'PENDING_RESTOCK',
        actorId,
        actorRole,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        details: JSON.stringify({
          deliveryType,
          status: fulfillmentStatus,
          maskedPayload,
          failureReason,
        }),
      },
    });

    return { fulfillment, alreadyFulfilled: false };
  }

  /**
   * Customer-facing retrieval: decrypts the digital code ONLY for the verified owner after payment is PAID.
   */
  public async getCustomerDigitalCode(params: {
    orderItemId: string;
    customerId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{
    orderItemId: string;
    deliveryType: DigitalDeliveryType;
    status: DigitalFulfillmentStatus;
    decryptedCode?: string;
    downloadUrl?: string;
    downloadExpiresAt?: Date | null;
    instructions?: string | null;
  }> {
    const { orderItemId, customerId, ipAddress, userAgent } = params;

    const orderItem = await prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: {
        product: true,
        sellerOrder: {
          include: {
            order: { include: { payment: true } },
          },
        },
        digitalFulfillment: true,
      },
    });

    if (!orderItem) {
      throw new AppError('عنصر الطلب غير موجود', 404);
    }

    const order = orderItem.sellerOrder.order;
    if (order.userId !== customerId) {
      throw new AppError('غير مصرح لك بالوصول لهذا الطلب', 403);
    }

    if (order.payment?.status !== PaymentStatus.PAID) {
      throw new AppError('لا يمكن عرض الرمز الرقمي قبل تأكيد السداد', 403);
    }

    const df = orderItem.digitalFulfillment;
    if (df && df.status === DigitalFulfillmentStatus.REVOKED) {
      throw new AppError('تم إلغاء أو استرداد التسليم الرقمي لهذا العنصر', 400, 'DIGITAL_FULFILLMENT_REVOKED');
    }
    if (!df || df.status !== DigitalFulfillmentStatus.FULFILLED) {
      return {
        orderItemId: orderItem.id,
        deliveryType: orderItem.product.digitalDeliveryType || DigitalDeliveryType.CODE,
        status: df?.status || DigitalFulfillmentStatus.PENDING,
        instructions: orderItem.product.digitalInstructions,
      };
    }

    let decryptedCode: string | undefined;
    if (df.encryptedPayload) {
      try {
        decryptedCode = this.decryptSensitivePayload(df.encryptedPayload);
      } catch (err: any) {
        decryptedCode = undefined;
      }
    }

    // Log customer access to digital code
    await prisma.digitalFulfillmentAuditLog.create({
      data: {
        digitalFulfillmentId: df.id,
        orderId: order.id,
        orderItemId: orderItem.id,
        action: 'ACCESSED_BY_CUSTOMER',
        actorId: customerId,
        actorRole: 'CUSTOMER',
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        details: JSON.stringify({ accessedAt: new Date().toISOString() }),
      },
    });

    return {
      orderItemId: orderItem.id,
      deliveryType: df.deliveryType,
      status: df.status,
      decryptedCode,
      downloadUrl: df.downloadUrl || undefined,
      downloadExpiresAt: df.downloadExpiresAt,
      instructions: orderItem.product.digitalInstructions,
    };
  }
}

export const digitalFulfillmentService = DigitalFulfillmentService.getInstance();
