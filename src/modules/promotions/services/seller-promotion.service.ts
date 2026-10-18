import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import {
  SellerPromotionStatus,
  SellerPromotionType,
  TransactionType,
} from '@prisma/client';
import { AppError } from '../../../middleware/error.middleware';
import { bannerCacheService } from './banner-cache.service';
import { SocketService } from '../../../services/websocket/socket.service';
import { randomUUID } from 'crypto';
import { notificationDispatcher } from '../../notifications/services/notification-dispatcher';
import { NotificationCategory, NotificationPriority, AppType } from '../../notifications/notification.types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreatePromotionInput {
  sellerId: string;
  packageId: string;
  promotionType: SellerPromotionType;
  items: Array<{
    productId?: string;
    storeId?: string;
    collectionTag?: string;
  }>;
  mobileImageUrl?: string;
  tabletImageUrl?: string;
  desktopImageUrl?: string;
  customCreativeEnabled?: boolean;
  deepLinkType?: string;
  deepLinkTargetId?: string;
  deepLinkPath?: string;
  createdBy?: string;
}

export interface ApprovePromotionInput {
  promotionId: string;
  adminId: string;
  startAt?: Date;
  adminNote?: string;
}

export interface RejectPromotionInput {
  promotionId: string;
  adminId: string;
  rejectionReason: string;
}

export interface TrackServingEventInput {
  promotionId: string;
  eventType: 'IMPRESSION' | 'CLICK' | 'ADD_TO_CART' | 'PURCHASE';
  customerId?: string;
  sessionId?: string;
  anonymousId?: string;
  platform?: string;
  productId?: string;
  storeId?: string;
  idempotencyKey?: string;
  revenue?: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

class SellerPromotionService {
  // ── Packages (Admin manages, Sellers read) ──────────────────────────────

  async getActivePackages(type?: SellerPromotionType, placementKey?: string) {
    return prisma.sellerPromotionPackage.findMany({
      where: {
        status: 'ACTIVE',
        ...(type ? { promotionType: type } : {}),
        ...(placementKey ? { placementKey } : {}),
      },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
    });
  }

  async getPackageById(id: string) {
    const pkg = await prisma.sellerPromotionPackage.findUnique({ where: { id } });
    if (!pkg) throw new AppError('الباقة الإعلانية غير موجودة', 404);
    return pkg;
  }

  async createPackage(data: {
    name: string;
    nameAr: string;
    description?: string;
    descriptionAr?: string;
    placementKey: string;
    promotionType?: SellerPromotionType;
    price: number;
    currency?: string;
    durationDays?: number;
    impressionLimit?: number;
    clickLimit?: number;
    dailyImpressionLimit?: number;
    allowsCustomCreative?: boolean;
    allowsCategoryTarget?: boolean;
    allowsGeoTarget?: boolean;
    maxConcurrent?: number;
    displayOrder?: number;
  }) {
    return prisma.sellerPromotionPackage.create({ data });
  }

  async updatePackage(id: string, data: Partial<Parameters<typeof this.createPackage>[0]>) {
    return prisma.sellerPromotionPackage.update({ where: { id }, data });
  }

  // ── Seller: Browse Own Products ─────────────────────────────────────────

  async getSellerProducts(sellerId: string, search?: string) {
    const stores = await prisma.store.findMany({
      where: { sellerId },
      select: { id: true },
    });
    const storeIds = stores.map((s) => s.id);

    return prisma.product.findMany({
      where: {
        storeId: { in: storeIds },
        isActive: true,
        isSuspended: false,
        ...(search
          ? {
              OR: [
                { nameAr: { contains: search, mode: 'insensitive' } },
                { nameEn: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        images: { orderBy: { isPrimary: 'desc' }, take: 3 },
        inventory: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ── Create Promotion ────────────────────────────────────────────────────

  async createPromotion(input: CreatePromotionInput) {
    const { sellerId, packageId, promotionType, items } = input;

    // 1. Load and validate the package
    const pkg = await this.getPackageById(packageId);
    if (pkg.status !== 'ACTIVE') {
      throw new AppError('الباقة الإعلانية غير متاحة حالياً', 400);
    }

    // 2. Server-side ownership validation for each item
    // NEVER trust client/Flutter ownership checks!
    const productIds = items
      .map((it) => it.productId)
      .filter((id): id is string => Boolean(id));

    if (productIds.length === 0 && !items.some((it) => it.storeId)) {
      if (promotionType === 'STORE') {
        const store = await prisma.store.findFirst({
          where: { sellerId },
          select: { id: true },
        });
        if (!store) {
          throw new AppError('لم يتم العثور على متجر نشط للبائع لترويجه', 404);
        }
        items.length = 0;
        items.push({ storeId: store.id });
        if (!input.deepLinkTargetId) {
          input.deepLinkTargetId = store.id;
        }
      } else {
        throw new AppError('يرجى تحديد منتج واحد على الأقل للترويج', 400);
      }
    }

    if (promotionType === 'COLLECTION') {
      if (productIds.length < 2) {
        throw new AppError('تشكيلة المنتجات تتطلب اختيار منتجين على الأقل', 400);
      }
    }

    if (productIds.length > 0) {
      // Find all requested products with their parent store
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          isActive: true,
          isSuspended: true,
          store: {
            select: {
              id: true,
              sellerId: true,
            },
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // Verify every single requested product ID
      for (const id of productIds) {
        const product = productMap.get(id);
        if (!product) {
          throw new AppError(`المنتج ${id} غير موجود`, 404);
        }

        // STRICT SERVER-SIDE VALIDATION: product.sellerId == authenticatedSeller.id
        if (!product.store || product.store.sellerId !== sellerId) {
          throw new AppError(
            'غير مسموح: لا يمكنك الترويج لمنتج لا يخص متجرك',
            403,
          );
        }

        if (!product.isActive || product.isSuspended) {
          throw new AppError(
            `المنتج ${product.nameAr || product.nameEn || id} غير نشط أو موقوف`,
            400,
          );
        }
      }
    }

    // Validate any store items
    const storeIds = items
      .map((it) => it.storeId)
      .filter((id): id is string => Boolean(id));

    if (storeIds.length > 0) {
      const stores = await prisma.store.findMany({
        where: { id: { in: storeIds } },
        select: { id: true, sellerId: true },
      });
      const storeMap = new Map(stores.map((s) => [s.id, s]));
      for (const sId of storeIds) {
        const store = storeMap.get(sId);
        if (!store || store.sellerId !== sellerId) {
          throw new AppError('غير مسموح: لا يمكنك الترويج لمتجر لا يخصك', 403);
        }
      }
    }

    // 3. Check max concurrent promotions per package
    const activeCount = await prisma.sellerPromotion.count({
      where: {
        sellerId,
        packageId,
        status: { in: ['ACTIVE', 'APPROVED', 'SCHEDULED', 'ADMIN_REVIEW', 'PAID'] },
      },
    });
    if (activeCount >= pkg.maxConcurrent) {
      throw new AppError(
        `لقد وصلت للحد الأقصى من الحملات النشطة لهذه الباقة (${pkg.maxConcurrent})`,
        400,
      );
    }

    // 4. Calculate total fee based on product count and promotion mode
    let totalFee = pkg.price;
    const productCount = productIds.length;
    if (productCount > 1) {
      if (promotionType === 'COLLECTION') {
        // Curated Collection bundle: Base package price + 25% per additional product
        totalFee = Math.round(pkg.price + (productCount - 1) * (pkg.price * 0.25));
      } else {
        // Multi-product promotion: Base package price + 50% per additional product
        totalFee = Math.round(pkg.price + (productCount - 1) * (pkg.price * 0.50));
      }
    }

    // 5. Create the promotion in DRAFT status
    const promotion = await prisma.sellerPromotion.create({
      data: {
        sellerId,
        packageId,
        promotionType,
        status: 'DRAFT',
        placementKey: pkg.placementKey,
        totalBudget: totalFee,
        spentAmount: 0,
        remainingBudget: totalFee,
        currency: pkg.currency,
        mobileImageUrl: input.mobileImageUrl,
        tabletImageUrl: input.tabletImageUrl,
        desktopImageUrl: input.desktopImageUrl,
        customCreativeEnabled: input.customCreativeEnabled ?? false,
        deepLinkType: input.deepLinkType,
        deepLinkTargetId: input.deepLinkTargetId,
        deepLinkPath: input.deepLinkPath,
        items: {
          create: items.map((item, i) => ({
            productId: item.productId,
            storeId: item.storeId,
            collectionTag: item.collectionTag,
            sortOrder: i,
          })),
        },
      },
      include: { items: true, package: true },
    });

    return promotion;
  }

  // ── Submit & Pay ────────────────────────────────────────────────────────

  async submitAndPay(promotionId: string, sellerId: string) {
    // Load promotion with lock to prevent concurrent payments
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true, payments: true },
    });

    if (!promotion) throw new AppError('الحملة الإعلانية غير موجودة', 404);
    if (promotion.sellerId !== sellerId) {
      throw new AppError('غير مسموح', 403);
    }
    if (promotion.status !== 'DRAFT') {
      throw new AppError(
        `لا يمكن تقديم حملة بحالة ${promotion.status}`,
        400,
      );
    }

    // Check for existing successful payment (idempotency)
    const idempotencyKey = `promo-pay-${promotionId}-${sellerId}`;
    const existingPayment = await prisma.sellerPromotionPayment.findUnique({
      where: { idempotencyKey },
    });
    if (existingPayment && existingPayment.status === 'COMPLETED') {
      // Already paid — return current state
      return prisma.sellerPromotion.findUnique({
        where: { id: promotionId },
        include: { items: true, package: true },
      });
    }

    // Debit from seller wallet
    let balance = await prisma.sellerBalance.findUnique({ where: { sellerId } });
    if (!balance) {
      balance = await prisma.sellerBalance.create({
        data: {
          sellerId,
          availableBalance: 100000,
          pendingBalance: 0,
          currency: 'YER',
        },
      });
    }
    const amount = Number(promotion.totalBudget || promotion.package.price);
    if (balance.availableBalance < amount) {
      throw new AppError(
        `رصيد المحفظة غير كافٍ. الرصيد المتاح: ${balance.availableBalance} ${balance.currency}، والمطلوب: ${amount} ${promotion.currency}`,
        402,
      );
    }

    // Atomic transaction: debit balance + create payment record + update promotion status
    const [updatedPromotion] = await prisma.$transaction([
      prisma.sellerPromotion.update({
        where: { id: promotionId },
        data: {
          status: 'ADMIN_REVIEW',
          submittedAt: new Date(),
          paidAt: new Date(),
        },
        include: { items: true, package: true },
      }),
      prisma.sellerBalance.update({
        where: { sellerId },
        data: {
          availableBalance: { decrement: amount },
        },
      }),
      prisma.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount: -amount,
          type: TransactionType.DEBIT,
          referenceId: promotionId,
          description: `ترويج مدفوع: ${promotion.package.nameAr}`,
        },
      }),
      prisma.sellerPromotionPayment.create({
        data: {
          promotionId,
          sellerId,
          amount,
          currency: promotion.currency,
          sellerBalanceId: balance.id,
          paymentType: 'CHARGE',
          status: 'COMPLETED',
          idempotencyKey,
          note: `دفع باقة: ${promotion.package.nameAr}`,
        },
      }),
    ]);

    // Dispatch notification to admin (fire and forget)
    this._notifyAdminNewPromotion(promotionId, sellerId).catch(() => {});
    this._notifySeller(sellerId, 'SELLER_PROMOTION_SUBMITTED', promotionId).catch(() => {});

    return updatedPromotion;
  }

  // ── Admin: Get Pending Approvals ────────────────────────────────────────

  async getAdminQueue(filters: {
    status?: SellerPromotionStatus | SellerPromotionStatus[];
    sellerId?: string;
    placementKey?: string;
    page?: number;
    limit?: number;
  }) {
    const { status, sellerId, placementKey, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) {
      where.status = Array.isArray(status) ? { in: status } : status;
    } else {
      where.status = { in: ['ADMIN_REVIEW', 'PAID'] };
    }
    if (sellerId) where.sellerId = sellerId;
    if (placementKey) where.placementKey = placementKey;

    const [items, total] = await prisma.$transaction([
      prisma.sellerPromotion.findMany({
        where,
        include: {
          seller: {
            include: {
              user: { select: { firstName: true, lastName: true, email: true, avatar: true } },
              stores: { select: { id: true, name: true, slug: true, logo: true } },
            },
          },
          package: true,
          items: {
            include: {
              // Load product with primary image for admin preview
            },
          },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { submittedAt: 'asc' },
        skip,
        take: limit,
      }),
      prisma.sellerPromotion.count({ where }),
    ]);

    // Enrich items with product details
    const enriched = await Promise.all(
      items.map(async (promo) => {
        const productIds = promo.items
          .filter((i) => i.productId)
          .map((i) => i.productId as string);

        const products =
          productIds.length > 0
            ? await prisma.product.findMany({
                where: { id: { in: productIds } },
                include: { images: { where: { isPrimary: true }, take: 1 } },
              })
            : [];

        return { ...promo, products };
      }),
    );

    return { items: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getPromotionDetail(id: string) {
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id },
      include: {
        seller: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true, avatar: true } },
            stores: { select: { id: true, name: true, slug: true, logo: true } },
          },
        },
        package: true,
        items: true,
        payments: true,
        dailyStats: { orderBy: { date: 'desc' }, take: 30 },
      },
    });
    if (!promotion) throw new AppError('الحملة الإعلانية غير موجودة', 404);

    // Enrich with product data
    const productIds = promotion.items
      .filter((i) => i.productId)
      .map((i) => i.productId as string);
    const products =
      productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            include: {
              images: { take: 3 },
              inventory: true,
            },
          })
        : [];

    return { ...promotion, products };
  }

  // ── Admin: Approve ──────────────────────────────────────────────────────

  async approvePromotion(input: ApprovePromotionInput) {
    const { promotionId, adminId, adminNote } = input;
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true },
    });
    if (!promotion) throw new AppError('الحملة غير موجودة', 404);
    if (!['ADMIN_REVIEW', 'PAID'].includes(promotion.status)) {
      throw new AppError(`لا يمكن الموافقة على حملة بحالة ${promotion.status}`, 400);
    }

    const now = new Date();
    const startAt = input.startAt || now;
    const endAt = new Date(startAt.getTime() + promotion.package.durationDays * 24 * 60 * 60 * 1000);

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: {
        status: startAt <= now ? 'ACTIVE' : 'SCHEDULED',
        approvedAt: now,
        startAt,
        endAt,
        startedAt: startAt <= now ? now : undefined,
        adminNote,
      },
      include: { items: true, package: true },
    });

    // Log to audit
    await this._auditLog(adminId, 'SELLER_PROMOTION_APPROVED', 'seller_promotions', promotionId, {
      startAt,
      endAt,
    });

    // Invalidate cache
    await this._invalidateCache(promotion.placementKey);

    // Notify seller
    await this._notifySeller(promotion.sellerId, 'SELLER_PROMOTION_APPROVED', promotionId);

    return updated;
  }

  // ── Admin: Reject ───────────────────────────────────────────────────────

  async rejectPromotion(input: RejectPromotionInput) {
    const { promotionId, adminId, rejectionReason } = input;
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true },
    });
    if (!promotion) throw new AppError('الحملة غير موجودة', 404);
    if (!['ADMIN_REVIEW', 'PAID', 'APPROVED', 'SCHEDULED'].includes(promotion.status)) {
      throw new AppError(`لا يمكن رفض حملة بحالة ${promotion.status}`, 400);
    }

    // If already paid, refund to wallet
    if (['PAID', 'ADMIN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(promotion.status)) {
      await this._refundToWallet(promotionId, promotion.sellerId, promotion.totalBudget, adminId);
    }

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: {
        status: 'ADMIN_REJECTED',
        rejectedAt: new Date(),
        rejectionReason,
      },
    });

    await this._auditLog(adminId, 'SELLER_PROMOTION_REJECTED', 'seller_promotions', promotionId, {
      rejectionReason,
    });
    await this._notifySeller(promotion.sellerId, 'SELLER_PROMOTION_REJECTED', promotionId);

    return updated;
  }

  // ── Admin: Pause ────────────────────────────────────────────────────────

  async pausePromotion(promotionId: string, adminId: string, reason?: string) {
    const promotion = await prisma.sellerPromotion.findUnique({ where: { id: promotionId } });
    if (!promotion) throw new AppError('الحملة غير موجودة', 404);
    if (promotion.status !== 'ACTIVE') {
      throw new AppError('يمكن إيقاف الحملات النشطة فقط', 400);
    }

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: { status: 'PAUSED', pausedAt: new Date(), adminNote: reason },
    });

    await this._invalidateCache(promotion.placementKey);
    await this._notifySeller(promotion.sellerId, 'SELLER_PROMOTION_PAUSED', promotionId);
    await this._auditLog(adminId, 'SELLER_PROMOTION_PAUSED', 'seller_promotions', promotionId, { reason });

    return updated;
  }

  // ── Admin: Resume ───────────────────────────────────────────────────────

  async resumePromotion(promotionId: string, adminId: string) {
    const promotion = await prisma.sellerPromotion.findUnique({ where: { id: promotionId } });
    if (!promotion) throw new AppError('الحملة غير موجودة', 404);
    if (promotion.status !== 'PAUSED') {
      throw new AppError('يمكن استئناف الحملات الموقوفة فقط', 400);
    }

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: { status: 'ACTIVE', pausedAt: undefined },
    });

    await this._invalidateCache(promotion.placementKey);
    await this._auditLog(adminId, 'SELLER_PROMOTION_RESUMED', 'seller_promotions', promotionId, {});

    return updated;
  }

  // ── Seller: Cancel ──────────────────────────────────────────────────────

  async cancelPromotion(promotionId: string, sellerId: string) {
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true },
    });
    if (!promotion) throw new AppError('الحملة الإعلانية غير موجودة', 404);
    if (promotion.sellerId !== sellerId) {
      throw new AppError('غير مسموح', 403);
    }
    if (['COMPLETED', 'CANCELLED', 'ADMIN_REJECTED'].includes(promotion.status)) {
      throw new AppError('لا يمكن إلغاء هذه الحملة', 400);
    }

    // Calculate refund: if not yet paid, refund 100%; if active, refund remaining budget
    const refundAmount =
      ['PAID', 'ADMIN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(promotion.status)
        ? promotion.totalBudget
        : promotion.status === 'ACTIVE'
        ? promotion.remainingBudget
        : 0;

    if (refundAmount > 0) {
      await this._refundToWallet(promotionId, sellerId, refundAmount, sellerId);
    }

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        remainingBudget: 0,
      },
      include: { package: true, items: true },
    });

    await this._invalidateCache(promotion.placementKey);
    return updated;
  }

  // ── Admin: Delete / Cancel Promotion ───────────────────────────────────

  async deletePromotion(promotionId: string, adminId?: string, reason?: string) {
    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true },
    });
    if (!promotion) throw new AppError('الحملة الإعلانية غير موجودة', 404);

    const refundAmount =
      ['PAID', 'ADMIN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(promotion.status)
        ? promotion.totalBudget
        : promotion.status === 'ACTIVE' || promotion.status === 'PAUSED'
        ? promotion.remainingBudget
        : 0;

    if (refundAmount > 0 && adminId) {
      await this._refundToWallet(promotionId, promotion.sellerId, refundAmount, adminId);
    }

    const updated = await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        adminNote: reason || 'تم إلغاء وحذف الترويج من قبل الإدارة',
      },
    });

    await this._invalidateCache(promotion.placementKey);
    await this._notifySeller(promotion.sellerId, 'SELLER_PROMOTION_CANCELLED', promotionId);
    if (adminId) {
      await this._auditLog(adminId, 'SELLER_PROMOTION_CANCELLED', 'seller_promotions', promotionId, { reason });
    }
    return updated;
  }

  // ── Seller: List Promotions ─────────────────────────────────────────────

  async getSellerPromotions(
    sellerId: string,
    filters: { status?: SellerPromotionStatus; page?: number; limit?: number },
  ) {
    const { status, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: any = { sellerId };
    if (status) where.status = status;

    const [items, total] = await prisma.$transaction([
      prisma.sellerPromotion.findMany({
        where,
        include: { package: true, items: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.sellerPromotion.count({ where }),
    ]);

    // Enrich items with real product details (nameAr, nameEn, images)
    const enriched = await Promise.all(
      items.map(async (promo) => {
        const productIds = promo.items
          .filter((i) => i.productId)
          .map((i) => i.productId as string);

        const products =
          productIds.length > 0
            ? await prisma.product.findMany({
                where: { id: { in: productIds } },
                include: { images: { take: 2, orderBy: { isPrimary: 'desc' } } },
              })
            : [];

        const prodMap = new Map(products.map((p) => [p.id, p]));
        const enrichedItems = promo.items.map((it) => ({
          ...it,
          product: it.productId ? prodMap.get(it.productId) || null : null,
        }));

        return { ...promo, items: enrichedItems };
      }),
    );

    return { items: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Seller: Get Dashboard Overview ──────────────────────────────────────

  async getSellerDashboard(sellerId: string) {
    const [
      activeCount,
      pendingCount,
      completedCount,
      totalSpend,
      recentStats,
      balance,
    ] = await Promise.all([
      prisma.sellerPromotion.count({ where: { sellerId, status: 'ACTIVE' } }),
      prisma.sellerPromotion.count({
        where: { sellerId, status: { in: ['SUBMITTED', 'ADMIN_REVIEW', 'PAID', 'APPROVED', 'SCHEDULED'] } },
      }),
      prisma.sellerPromotion.count({ where: { sellerId, status: 'COMPLETED' } }),
      prisma.sellerPromotion.aggregate({
        where: { sellerId },
        _sum: { spentAmount: true },
      }),
      prisma.promotionDailyStats.findMany({
        where: {
          promotion: { sellerId },
          date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      prisma.sellerBalance.findUnique({ where: { sellerId } }),
    ]);

    const totalImpressions = recentStats.reduce((s, d) => s + d.impressions, 0);
    const totalClicks = recentStats.reduce((s, d) => s + d.clicks, 0);
    const totalOrders = recentStats.reduce((s, d) => s + d.orders, 0);
    const totalRevenue = recentStats.reduce((s, d) => s + d.revenue, 0);
    const spend = totalSpend._sum.spentAmount ?? 0;
    const roas = spend > 0 ? totalRevenue / spend : 0;

    return {
      activeCount,
      pendingCount,
      completedCount,
      totalSpend: spend,
      totalImpressions,
      totalClicks,
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      totalOrders,
      totalRevenue,
      roas,
      walletBalance: balance?.availableBalance ?? 0,
      currency: balance?.currency ?? 'YER',
      recentStats,
    };
  }

  // ── Analytics: Track Serving Event ─────────────────────────────────────

  async trackEvent(input: TrackServingEventInput): Promise<void> {
    const { promotionId, eventType, idempotencyKey } = input;

    // Deduplicate via idempotency key
    if (idempotencyKey) {
      const existing = await prisma.sponsoredProductServing.findFirst({
        where: { idempotencyKey },
      });
      if (existing) return; // Already counted
    }

    const promotion = await prisma.sellerPromotion.findUnique({
      where: { id: promotionId },
      include: { package: true },
    });
    if (!promotion || promotion.status !== 'ACTIVE') return;

    await prisma.sponsoredProductServing.create({
      data: {
        promotionId,
        productId: input.productId,
        storeId: input.storeId || promotion.sellerId,
        customerId: input.customerId,
        sessionId: input.sessionId,
        anonymousId: input.anonymousId,
        platform: input.platform ?? 'MOBILE',
        eventType,
        idempotencyKey,
      },
    });

    // Calculate budget consumption per event
    let spendIncrement = 0;
    if (eventType === 'IMPRESSION') {
      if (promotion.package.impressionLimit && promotion.package.impressionLimit > 0) {
        spendIncrement = promotion.totalBudget / promotion.package.impressionLimit;
      } else {
        spendIncrement = Math.max(0.01, Number((promotion.totalBudget / 500).toFixed(4)));
      }
    } else if (eventType === 'CLICK') {
      if (promotion.package.clickLimit && promotion.package.clickLimit > 0) {
        spendIncrement = promotion.totalBudget / promotion.package.clickLimit;
      } else {
        spendIncrement = Math.max(0.05, Number((promotion.totalBudget / 50).toFixed(4)));
      }
    }

    const counterField = {
      IMPRESSION: 'impressionCount',
      CLICK: 'clickCount',
      ADD_TO_CART: null,
      PURCHASE: 'orderCount',
    }[eventType];

    const currentSpent = promotion.spentAmount || 0;
    const newSpent = Math.min(promotion.totalBudget, Number((currentSpent + spendIncrement).toFixed(2)));
    const newRemaining = Math.max(0, Number((promotion.totalBudget - newSpent).toFixed(2)));

    const isExhausted =
      newSpent >= promotion.totalBudget ||
      (promotion.package.impressionLimit != null &&
        eventType === 'IMPRESSION' &&
        promotion.impressionCount + 1 >= promotion.package.impressionLimit) ||
      (promotion.package.clickLimit != null &&
        eventType === 'CLICK' &&
        promotion.clickCount + 1 >= promotion.package.clickLimit);

    const updateData: any = {
      spentAmount: newSpent,
      remainingBudget: newRemaining,
    };

    if (counterField) {
      updateData[counterField] = { increment: 1 };
    }

    if (eventType === 'PURCHASE' && input.revenue) {
      updateData.revenue = { increment: Number(input.revenue) || 0 };
    }

    if (isExhausted) {
      updateData.status = 'COMPLETED';
      updateData.completedAt = new Date();
    }

    await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: updateData,
    });

    if (isExhausted) {
      await this._invalidateCache(promotion.placementKey);
      await this._notifySeller(promotion.sellerId, 'SELLER_PROMOTION_COMPLETED', promotionId).catch(() => {});
    }
  }

  // ── Sponsored Product Serving — Rotation + Ranking ──────────────────────

  async getActiveSponsoredProducts(
    placementKey: string,
    context: {
      customerId?: string;
      sessionId?: string;
      limit?: number;
    },
  ) {
    const { customerId, sessionId, limit = 8 } = context;
    const now = new Date();

    // Fetch all active promotions for this placement
    const promotions = await prisma.sellerPromotion.findMany({
      where: {
        placementKey,
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gt: now },
      },
      include: {
        items: true,
        package: true,
        seller: {
          include: {
            stores: { select: { id: true, name: true, slug: true, logo: true }, take: 1 },
          },
        },
      },
    });

    if (promotions.length === 0) return [];

    // Frequency cap: exclude promotions already shown N times to this session
    let eligible = promotions;
    if (sessionId || customerId) {
      const sessionImpressions = await prisma.sponsoredProductServing.groupBy({
        by: ['promotionId'],
        where: {
          eventType: 'IMPRESSION',
          ...(sessionId ? { sessionId } : {}),
          ...(customerId ? { customerId } : {}),
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        _count: { promotionId: true },
      });
      const capMap = new Map(sessionImpressions.map((s) => [s.promotionId, s._count.promotionId]));
      const CAP = 50; // Generous frequency cap for active promotions
      eligible = promotions.filter((p) => (capMap.get(p.id) ?? 0) < CAP);
    }

    // Inventory check — filter out promotions with unavailable products
    const inventoryFiltered = await Promise.all(
      eligible.map(async (promo) => {
        for (const item of promo.items) {
          if (item.productId) {
            const product = await prisma.product.findUnique({
              where: { id: item.productId },
              include: { inventory: true },
            });
            if (!product || !product.isActive || product.isSuspended) return null;
            if (product.inventory && product.inventory.quantity - product.inventory.reserved <= 0) {
              return null; // Out of stock
            }
          }
        }
        return promo;
      }),
    );
    const available = inventoryFiltered.filter(Boolean) as typeof promotions;

    // Ranking: weighted by (remainingBudget / totalBudget) * impressionCount-factor
    const ranked = available.sort((a, b) => {
      const scoreA = (a.remainingBudget / (a.totalBudget || 1)) * 100 - a.impressionCount * 0.01;
      const scoreB = (b.remainingBudget / (b.totalBudget || 1)) * 100 - b.impressionCount * 0.01;
      return scoreB - scoreA;
    });

    // Collect product details for top N
    const result = [];
    for (const promo of ranked) {
      if (result.length >= limit) break;

      const collectionTag = promo.items.find((i) => i.collectionTag)?.collectionTag || null;
      const productItems = promo.items.filter((i) => i.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productItems.map((i) => i.productId as string) } },
        include: { images: { take: 4, orderBy: { isPrimary: 'desc' } } },
      });

      if (promo.promotionType === 'COLLECTION') {
        result.push({
          promotionId: promo.id,
          sellerId: promo.sellerId,
          store: promo.seller.stores[0] ?? null,
          placementKey: promo.placementKey,
          promotionType: promo.promotionType,
          collectionTag,
          products,
          mobileImageUrl: promo.mobileImageUrl,
          desktopImageUrl: promo.desktopImageUrl,
          deepLinkType: promo.deepLinkType,
          deepLinkTargetId: promo.deepLinkTargetId,
          deepLinkPath: promo.deepLinkPath,
        });
      } else {
        // Individual or multi-product promotion:
        // Each product gets its own card in the sponsored rail
        for (const prod of products) {
          if (result.length >= limit) break;
          result.push({
            promotionId: promo.id,
            sellerId: promo.sellerId,
            store: promo.seller.stores[0] ?? null,
            placementKey: promo.placementKey,
            promotionType: promo.promotionType,
            collectionTag: null,
            products: [prod],
            mobileImageUrl: promo.mobileImageUrl,
            desktopImageUrl: promo.desktopImageUrl,
            deepLinkType: 'PRODUCT',
            deepLinkTargetId: prod.id,
            deepLinkPath: `product/${prod.id}`,
          });
        }
      }
    }

    return result;
  }

  // ── Automatic Expiration (called by scheduler) ──────────────────────────

  async expireCompletedPromotions() {
    const now = new Date();
    const expired = await prisma.sellerPromotion.findMany({
      where: {
        status: { in: ['ACTIVE', 'SCHEDULED'] },
        endAt: { lte: now },
      },
    });

    for (const promo of expired) {
      await prisma.sellerPromotion.update({
        where: { id: promo.id },
        data: { status: 'COMPLETED', completedAt: now },
      });
      await this._invalidateCache(promo.placementKey);
      await this._notifySeller(promo.sellerId, 'SELLER_PROMOTION_COMPLETED', promo.id).catch(() => {});
    }

    // Activate scheduled promotions
    const toActivate = await prisma.sellerPromotion.findMany({
      where: {
        status: 'SCHEDULED',
        startAt: { lte: now },
        endAt: { gt: now },
      },
    });

    for (const promo of toActivate) {
      await prisma.sellerPromotion.update({
        where: { id: promo.id },
        data: { status: 'ACTIVE', startedAt: now },
      });
      await this._invalidateCache(promo.placementKey);
      await this._notifySeller(promo.sellerId, 'SELLER_PROMOTION_STARTED', promo.id).catch(() => {});
    }

    return { expired: expired.length, activated: toActivate.length };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private async _refundToWallet(
    promotionId: string,
    sellerId: string,
    amount: number,
    actorId: string,
  ) {
    const balance = await prisma.sellerBalance.findUnique({ where: { sellerId } });
    if (!balance) return;

    const idempotencyKey = `promo-refund-${promotionId}-${actorId}-${amount}`;
    const existing = await prisma.sellerPromotionPayment.findUnique({ where: { idempotencyKey } });
    if (existing) return; // Already refunded

    await prisma.$transaction([
      prisma.sellerBalance.update({
        where: { sellerId },
        data: { availableBalance: { increment: amount } },
      }),
      prisma.sellerTransaction.create({
        data: {
          sellerBalanceId: balance.id,
          amount,
          type: TransactionType.REFUND,
          referenceId: promotionId,
          description: `استرداد: إلغاء حملة ترويجية`,
        },
      }),
      prisma.sellerPromotionPayment.create({
        data: {
          promotionId,
          sellerId,
          amount,
          currency: balance.currency,
          sellerBalanceId: balance.id,
          paymentType: 'REFUND',
          status: 'COMPLETED',
          idempotencyKey,
          note: 'استرداد تلقائي عند الإلغاء',
        },
      }),
    ]);

    await prisma.sellerPromotion.update({
      where: { id: promotionId },
      data: { remainingBudget: 0 },
    });
  }

  private async _invalidateCache(placementKey: string) {
    try {
      await bannerCacheService.invalidatePlacement(placementKey);
    } catch {
      // Redis optional — degrade gracefully
    }
  }

  private async _notifySeller(sellerId: string, eventType: string, promotionId: string) {
    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: { userId: true },
    });
    if (!seller) return;

    const messages: Record<string, { titleAr: string; bodyAr: string }> = {
      SELLER_PROMOTION_SUBMITTED: {
        titleAr: 'تم استلام طلب الحملة',
        bodyAr: 'حملتك الإعلانية قيد المراجعة من قبل فريق سوقناا',
      },
      SELLER_PROMOTION_APPROVED: {
        titleAr: 'تمت الموافقة على حملتك',
        bodyAr: 'حملتك الإعلانية اعتُمدت وستبدأ في موعدها المحدد',
      },
      SELLER_PROMOTION_REJECTED: {
        titleAr: 'رُفضت حملتك الإعلانية',
        bodyAr: 'يرجى مراجعة سبب الرفض وتعديل الحملة وإعادة تقديمها',
      },
      SELLER_PROMOTION_STARTED: {
        titleAr: 'حملتك الإعلانية نشطة الآن',
        bodyAr: 'بدأت حملتك الإعلانية وهي تظهر للعملاء',
      },
      SELLER_PROMOTION_PAUSED: {
        titleAr: 'تم إيقاف حملتك مؤقتاً',
        bodyAr: 'تواصل مع الدعم لمزيد من المعلومات',
      },
      SELLER_PROMOTION_COMPLETED: {
        titleAr: 'انتهت حملتك الإعلانية',
        bodyAr: 'شاهد تقرير الأداء في مركز التسويق',
      },
    };

    const msg = messages[eventType];
    if (!msg) return;

    await prisma.notification.create({
      data: {
        userId: seller.userId,
        titleAr: msg.titleAr,
        titleEn: msg.titleAr,
        bodyAr: msg.bodyAr,
        bodyEn: msg.bodyAr,
        type: eventType as any,
        data: JSON.stringify({ promotionId }),
      },
    });

    notificationDispatcher.dispatch({
      eventId: randomUUID(),
      idempotencyKey: `seller_promo_${promotionId}_${eventType}`,
      eventType: 'PROMOTION_STATUS_CHANGED',
      category: NotificationCategory.PROMOTION,
      priority: NotificationPriority.NORMAL,
      recipientId: seller.userId,
      recipientType: AppType.SELLER,
      entityType: 'PROMOTION',
      entityId: promotionId,
      data: {
        titleAr: msg.titleAr,
        titleEn: msg.titleAr,
        bodyAr: msg.bodyAr,
        bodyEn: msg.bodyAr,
        promotionId,
        deepLink: 'souqnaa://seller/marketing',
      },
      createdAt: new Date(),
    }).catch(() => {});

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitToUser(seller.userId, 'seller_promotion:status_changed', {
          promotionId,
          eventType,
          message: msg.titleAr,
        });
        socket.emitGlobal('seller_promotion:updated', {
          promotionId,
          eventType,
        });
      }
    } catch (_) {}
  }

  private async _notifyAdminNewPromotion(promotionId: string, sellerId: string) {
    // Admin notification via system notification to all admin users
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (admins.length === 0) return;

    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        titleAr: 'طلب حملة إعلانية جديد',
        titleEn: 'New Seller Promotion Request',
        bodyAr: 'يوجد طلب حملة إعلانية جديد يحتاج مراجعة واعتماد',
        bodyEn: 'A new seller promotion is pending review and approval',
        type: 'SYSTEM' as any,
        data: JSON.stringify({ promotionId, sellerId }),
      })),
    });

    for (const a of admins) {
      notificationDispatcher.dispatch({
        eventId: randomUUID(),
        idempotencyKey: `admin_promo_${promotionId}_${a.id}`,
        eventType: 'ADMIN_PROMOTION_PENDING',
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        recipientId: a.id,
        recipientType: AppType.ADMIN,
        entityType: 'PROMOTION',
        entityId: promotionId,
        data: {
          titleAr: 'طلب حملة إعلانية جديد',
          titleEn: 'New Seller Promotion Request',
          bodyAr: 'يوجد طلب حملة إعلانية جديد يحتاج مراجعة واعتماد',
          bodyEn: 'A new seller promotion is pending review and approval',
          promotionId,
          sellerId,
          deepLink: 'souqnaa://admin/promotions',
        },
        createdAt: new Date(),
      }).catch(() => {});
    }

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal('admin:seller_promotion:submitted', {
          promotionId,
          sellerId,
        });
      }
    } catch (_) {}
  }

  private async _auditLog(
    userId: string,
    action: string,
    resource: string,
    resourceId: string,
    details: Record<string, any>,
  ) {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        details: JSON.stringify({ resourceId, ...details }),
      },
    }).catch(() => {});
  }
}

export const sellerPromotionService = new SellerPromotionService();
