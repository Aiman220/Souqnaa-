import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import {
  FlashSaleStatus,
  FlashSaleDiscountType,
  FlashSaleItemStatus,
  FlashSaleSubmissionStatus,
  FlashSaleReservationStatus,
  FlashSaleCouponPolicy,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { AppType } from '../notifications/notification.types';

export interface PriceCalculationResult {
  originalPrice: number;
  flashSalePrice: number;
  discountType: FlashSaleDiscountType;
  discountValue: number;
  discountAmount: number;
  percentageSaved: number;
}

export class FlashSaleService {
  private static instance: FlashSaleService;

  static getInstance(): FlashSaleService {
    if (!FlashSaleService.instance) {
      FlashSaleService.instance = new FlashSaleService();
    }
    return FlashSaleService.instance;
  }

  // ============================================================================
  // 1. PRICING CALCULATION (Authoritative Server Logic)
  // ============================================================================
  calculateFinalPrice(
    originalPrice: number,
    discountType: FlashSaleDiscountType,
    discountValue: number,
    maximumDiscount?: number | null
  ): PriceCalculationResult {
    if (originalPrice < 0) throw new AppError('Original price cannot be negative', 400);

    let flashSalePrice = originalPrice;
    let discountAmount = 0;

    switch (discountType) {
      case FlashSaleDiscountType.PERCENTAGE: {
        const pct = Math.max(0, Math.min(100, discountValue));
        discountAmount = (originalPrice * pct) / 100;
        if (maximumDiscount !== null && maximumDiscount !== undefined && maximumDiscount > 0) {
          discountAmount = Math.min(discountAmount, maximumDiscount);
        }
        flashSalePrice = Math.max(0, originalPrice - discountAmount);
        break;
      }
      case FlashSaleDiscountType.FIXED: {
        discountAmount = Math.max(0, discountValue);
        if (maximumDiscount !== null && maximumDiscount !== undefined && maximumDiscount > 0) {
          discountAmount = Math.min(discountAmount, maximumDiscount);
        }
        discountAmount = Math.min(discountAmount, originalPrice);
        flashSalePrice = Math.max(0, originalPrice - discountAmount);
        break;
      }
      case FlashSaleDiscountType.SPECIAL_PRICE: {
        flashSalePrice = Math.max(0, discountValue);
        if (flashSalePrice > originalPrice) {
          flashSalePrice = originalPrice;
        }
        discountAmount = Math.max(0, originalPrice - flashSalePrice);
        break;
      }
      default:
        flashSalePrice = originalPrice;
        discountAmount = 0;
    }

    // Currency precision: round to 2 decimals or integer for YER
    flashSalePrice = Math.round(flashSalePrice * 100) / 100;
    discountAmount = Math.round(discountAmount * 100) / 100;
    const percentageSaved =
      originalPrice > 0 ? Math.round((discountAmount / originalPrice) * 100) : 0;

    return {
      originalPrice,
      flashSalePrice,
      discountType,
      discountValue,
      discountAmount,
      percentageSaved,
    };
  }

  // ============================================================================
  // 2. CAMPAIGN LIFECYCLE & STATE MACHINE
  // ============================================================================
  validateStatusTransition(current: FlashSaleStatus, next: FlashSaleStatus): void {
    const validTransitions: Record<FlashSaleStatus, FlashSaleStatus[]> = {
      [FlashSaleStatus.DRAFT]: [FlashSaleStatus.SCHEDULED, FlashSaleStatus.ACTIVE, FlashSaleStatus.CANCELLED],
      [FlashSaleStatus.SCHEDULED]: [FlashSaleStatus.ACTIVE, FlashSaleStatus.CANCELLED],
      [FlashSaleStatus.ACTIVE]: [FlashSaleStatus.PAUSED, FlashSaleStatus.ENDED, FlashSaleStatus.CANCELLED],
      [FlashSaleStatus.PAUSED]: [FlashSaleStatus.ACTIVE, FlashSaleStatus.ENDED, FlashSaleStatus.CANCELLED],
      [FlashSaleStatus.ENDED]: [],
      [FlashSaleStatus.CANCELLED]: [],
    };

    if (!validTransitions[current].includes(next)) {
      throw new AppError(
        `Invalid campaign status transition from ${current} to ${next}`,
        400,
        'FLASH_SALE_INVALID_STATE_TRANSITION'
      );
    }
  }

  async createCampaign(data: {
    name: string;
    slug?: string;
    description?: string;
    bannerImage?: string;
    mobileBanner?: string;
    desktopBanner?: string;
    campaignColor?: string;
    campaignBadge?: string;
    startAt: Date;
    endAt: Date;
    timezone?: string;
    priority?: number;
    displayOrder?: number;
    maxProducts?: number;
    isFeatured?: boolean;
    customerEligibility?: string;
    minimumAppVersion?: string;
    termsAndConditions?: string;
    couponPolicy?: FlashSaleCouponPolicy;
    allowedCustomerSegments?: string;
    allowedCountries?: string;
    allowedCities?: string;
    minimumOrderAmount?: number;
    maximumOrders?: number;
    createdBy?: string;
  }) {
    if (new Date(data.startAt) >= new Date(data.endAt)) {
      throw new AppError('Campaign start time must be before end time', 400);
    }

    const slug =
      data.slug ||
      `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;

    const campaign = await prisma.flashSaleCampaign.create({
      data: {
        name: data.name,
        slug,
        description: data.description,
        bannerImage: data.bannerImage,
        mobileBanner: data.mobileBanner,
        desktopBanner: data.desktopBanner,
        campaignColor: data.campaignColor,
        campaignBadge: data.campaignBadge,
        status: FlashSaleStatus.DRAFT,
        startAt: new Date(data.startAt),
        endAt: new Date(data.endAt),
        timezone: data.timezone || 'UTC',
        priority: data.priority || 0,
        displayOrder: data.displayOrder || 0,
        maxProducts: data.maxProducts,
        isFeatured: data.isFeatured ?? false,
        customerEligibility: data.customerEligibility || 'ALL',
        minimumAppVersion: data.minimumAppVersion,
        termsAndConditions: data.termsAndConditions,
        couponPolicy: data.couponPolicy || FlashSaleCouponPolicy.ALLOW_COUPONS,
        allowedCustomerSegments: data.allowedCustomerSegments,
        allowedCountries: data.allowedCountries,
        allowedCities: data.allowedCities,
        minimumOrderAmount: data.minimumOrderAmount,
        maximumOrders: data.maximumOrders,
        createdBy: data.createdBy,
      },
    });

    await this.logAudit(data.createdBy, 'CREATE_CAMPAIGN', 'FlashSaleCampaign', campaign.id, null, campaign);
    await this.invalidateCampaignCache();
    return campaign;
  }

  async updateCampaign(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      bannerImage: string;
      mobileBanner: string;
      desktopBanner: string;
      campaignColor: string;
      campaignBadge: string;
      startAt: Date;
      endAt: Date;
      priority: number;
      displayOrder: number;
      maxProducts: number;
      isFeatured: boolean;
      termsAndConditions: string;
      couponPolicy: FlashSaleCouponPolicy;
      minimumOrderAmount: number;
      maximumOrders: number;
    }>,
    adminId?: string
  ) {
    const existing = await prisma.flashSaleCampaign.findUnique({ where: { id } });
    if (!existing) throw new AppError('Campaign not found', 404, 'FLASH_SALE_NOT_FOUND');

    if (existing.status === FlashSaleStatus.ENDED || existing.status === FlashSaleStatus.CANCELLED) {
      throw new AppError('Cannot update an ended or cancelled campaign', 400);
    }

    const updated = await prisma.flashSaleCampaign.update({
      where: { id },
      data: {
        ...data,
        startAt: data.startAt ? new Date(data.startAt) : undefined,
        endAt: data.endAt ? new Date(data.endAt) : undefined,
      },
    });

    await this.logAudit(adminId, 'UPDATE_CAMPAIGN', 'FlashSaleCampaign', id, existing, updated);
    await this.invalidateCampaignCache();
    return updated;
  }

  async setCampaignStatus(id: string, nextStatus: FlashSaleStatus, adminId?: string) {
    const campaign = await prisma.flashSaleCampaign.findUnique({ where: { id } });
    if (!campaign) throw new AppError('Campaign not found', 404, 'FLASH_SALE_NOT_FOUND');

    this.validateStatusTransition(campaign.status, nextStatus);

    const updateData: any = { status: nextStatus };
    if (nextStatus === FlashSaleStatus.ACTIVE && !campaign.publishedAt) {
      updateData.publishedAt = new Date();
    }
    if (nextStatus === FlashSaleStatus.CANCELLED) {
      updateData.cancelledAt = new Date();
    }

    const updated = await prisma.flashSaleCampaign.update({
      where: { id },
      data: updateData,
    });

    // Notify via WebSocket
    this.broadcastCampaignEvent(nextStatus, updated);

    await this.logAudit(adminId, `CAMPAIGN_STATUS_${nextStatus}`, 'FlashSaleCampaign', id, campaign.status, nextStatus);
    await this.invalidateCampaignCache();
    return updated;
  }

  // ============================================================================
  // 3. SELLER SUBMISSION & ADMIN APPROVAL WORKFLOW
  // ============================================================================
  async submitProduct(sellerId: string, data: {
    campaignId: string;
    productId: string;
    variantId?: string;
    proposedPrice: number;
    proposedStock: number;
    proposedPurchaseLimit?: number;
    notes?: string;
  }) {
    const campaign = await prisma.flashSaleCampaign.findUnique({ where: { id: data.campaignId } });
    if (!campaign) throw new AppError('Campaign not found', 404, 'FLASH_SALE_NOT_FOUND');

    if (
      campaign.status !== FlashSaleStatus.DRAFT &&
      campaign.status !== FlashSaleStatus.SCHEDULED &&
      campaign.status !== FlashSaleStatus.ACTIVE
    ) {
      throw new AppError('Campaign is not accepting seller submissions', 400);
    }

    const product = await prisma.product.findUnique({
      where: { id: data.productId },
      include: { store: true, variants: true, inventory: true },
    });

    if (!product || product.store.sellerId !== sellerId) {
      throw new AppError('Product not found or does not belong to this seller', 403);
    }

    let originalPrice = product.price;
    if (data.variantId) {
      const v = product.variants.find((x) => x.id === data.variantId);
      if (!v) throw new AppError('Variant not found', 404);
      originalPrice = v.price;
    }

    if (data.proposedPrice <= 0 || data.proposedPrice >= originalPrice) {
      throw new AppError('Proposed Flash Sale price must be greater than 0 and less than original price', 400);
    }

    if (data.proposedStock <= 0) {
      throw new AppError('Proposed stock allocation must be greater than 0', 400);
    }

    // Check existing submission
    const existing = await prisma.flashSaleSellerSubmission.findFirst({
      where: {
        campaignId: data.campaignId,
        productId: data.productId,
        variantId: data.variantId || null,
        status: { in: [FlashSaleSubmissionStatus.PENDING_REVIEW, FlashSaleSubmissionStatus.APPROVED] },
      },
    });

    if (existing) {
      throw new AppError('A submission for this product already exists for this campaign', 400);
    }

    const submission = await prisma.flashSaleSellerSubmission.create({
      data: {
        campaignId: data.campaignId,
        sellerId,
        productId: data.productId,
        variantId: data.variantId || null,
        proposedPrice: data.proposedPrice,
        proposedStock: data.proposedStock,
        proposedPurchaseLimit: data.proposedPurchaseLimit || 1,
        notes: data.notes,
        status: FlashSaleSubmissionStatus.PENDING_REVIEW,
      },
    });

    // Real-time broadcast to Admins & Clients
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal('flashsale:submission:new', {
          submissionId: submission.id,
          campaignId: data.campaignId,
          sellerId,
          productId: data.productId,
          status: 'PENDING_REVIEW',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (_) {}

    await this.logAudit(sellerId, 'SUBMIT_PRODUCT', 'FlashSaleSellerSubmission', submission.id, null, submission);
    return submission;
  }

  async reviewSubmission(
    submissionId: string,
    action: 'APPROVE' | 'REJECT',
    options?: {
      overridePrice?: number;
      overrideStock?: number;
      overrideLimit?: number;
      discountType?: FlashSaleDiscountType;
      rejectionReason?: string;
    },
    adminId?: string
  ) {
    const submission = await prisma.flashSaleSellerSubmission.findUnique({
      where: { id: submissionId },
      include: {
        product: true,
        variant: true,
        campaign: true,
        seller: {
          select: {
            id: true,
            userId: true,
            stores: { select: { name: true }, take: 1 },
          },
        },
      },
    });

    if (!submission) throw new AppError('Submission not found', 404, 'FLASH_SALE_SUBMISSION_NOT_FOUND');
    if (submission.status !== FlashSaleSubmissionStatus.PENDING_REVIEW) {
      throw new AppError('Submission has already been reviewed', 400, 'FLASH_SALE_SUBMISSION_ALREADY_REVIEWED');
    }

    const prodName = submission.product.nameAr || submission.product.nameEn || 'المنتج';

    if (action === 'REJECT') {
      const reason = options?.rejectionReason || 'تم الرفض من قبل إدارة المنصة';
      const updated = await prisma.flashSaleSellerSubmission.update({
        where: { id: submissionId },
        data: {
          status: FlashSaleSubmissionStatus.REJECTED,
          rejectionReason: reason,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });

      // Notify seller of rejection via centralized notification platform
      if (submission.seller?.userId) {
        try {
          notificationEventBus.publish(
            NotificationEventFactory.campaignEvent({
              eventType: 'FLASH_SALE_SUBMISSION_REJECTED',
              recipientId: submission.seller.userId,
              campaignId: submission.campaignId,
              campaignTitleAr: submission.campaign.name,
              campaignTitleEn: submission.campaign.name,
              recipientType: AppType.SELLER,
              data: {
                submissionId,
                productId: submission.productId,
                productName: prodName,
                campaignName: submission.campaign.name,
                reason,
              },
            })
          );
        } catch (err) {
          console.error('[FlashSale Notification Error]:', err);
        }
      }

      // Real-time broadcast rejection to seller & admins
      try {
        const socket = SocketService.get();
        if (socket) {
          const payload = {
            submissionId,
            campaignId: submission.campaignId,
            sellerId: submission.sellerId,
            status: 'REJECTED',
            rejectionReason: reason,
            timestamp: new Date().toISOString(),
          };
          socket.emitGlobal('flashsale:submission:reviewed', payload);
          if (submission.seller?.userId) {
            socket.emitToUser(submission.seller.userId, 'flashsale:submission:reviewed', payload);
          }
        }
      } catch (_) {}

      await this.logAudit(adminId, 'REJECT_SUBMISSION', 'FlashSaleSellerSubmission', submissionId, null, updated);
      return updated;
    }

    // APPROVAL: copy into authoritative FlashSaleItem
    const originalPrice = submission.variant?.price ?? submission.product.price;
    const finalPrice = options?.overridePrice ?? submission.proposedPrice;
    const finalStock = options?.overrideStock ?? submission.proposedStock;
    const finalLimit = options?.overrideLimit ?? submission.proposedPurchaseLimit;
    const discountType = options?.discountType || FlashSaleDiscountType.SPECIAL_PRICE;
    const discountValue =
      discountType === FlashSaleDiscountType.PERCENTAGE
        ? Math.round(((originalPrice - finalPrice) / originalPrice) * 100)
        : finalPrice;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Mark submission approved
      const subUpdated = await tx.flashSaleSellerSubmission.update({
        where: { id: submissionId },
        data: {
          status: FlashSaleSubmissionStatus.APPROVED,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });

      // 2. Create or update authoritative FlashSaleItem
      const item = await tx.flashSaleItem.upsert({
        where: {
          campaignId_productId_variantId: {
            campaignId: submission.campaignId,
            productId: submission.productId,
            variantId: submission.variantId || '',
          },
        },
        create: {
          campaignId: submission.campaignId,
          sellerId: submission.sellerId,
          productId: submission.productId,
          variantId: submission.variantId || null,
          skuId: submission.variant?.sku || submission.product.sku || null,
          originalPrice,
          flashSalePrice: finalPrice,
          discountType,
          discountValue,
          allocatedStock: finalStock,
          reservedStock: 0,
          soldStock: 0,
          remainingStock: finalStock,
          perCustomerLimit: finalLimit,
          sellerProposedPrice: submission.proposedPrice,
          sellerProposedStock: submission.proposedStock,
          submittedAt: submission.createdAt,
          reviewedAt: new Date(),
          approvedAt: new Date(),
          status: FlashSaleItemStatus.ACTIVE,
        },
        update: {
          originalPrice,
          flashSalePrice: finalPrice,
          discountType,
          discountValue,
          allocatedStock: finalStock,
          remainingStock: finalStock,
          perCustomerLimit: finalLimit,
          approvedAt: new Date(),
          status: FlashSaleItemStatus.ACTIVE,
        },
      });

      return { subUpdated, item };
    });

    // Notify seller of approval via centralized notification platform
    if (submission.seller?.userId) {
      try {
        notificationEventBus.publish(
          NotificationEventFactory.campaignEvent({
            eventType: 'FLASH_SALE_SUBMISSION_APPROVED',
            recipientId: submission.seller.userId,
            campaignId: submission.campaignId,
            campaignTitleAr: submission.campaign.name,
            campaignTitleEn: submission.campaign.name,
            recipientType: AppType.SELLER,
            data: {
              submissionId,
              productId: submission.productId,
              productName: prodName,
              campaignName: submission.campaign.name,
              flashPrice: finalPrice,
              stock: finalStock,
            },
          })
        );
      } catch (err) {
        console.error('[FlashSale Notification Error]:', err);
      }
    }

    // Real-time broadcast approval to seller & admins
    try {
      const socket = SocketService.get();
      if (socket) {
        const payload = {
          submissionId,
          campaignId: submission.campaignId,
          sellerId: submission.sellerId,
          status: 'APPROVED',
          approvedPrice: finalPrice,
          approvedStock: finalStock,
          timestamp: new Date().toISOString(),
        };
        socket.emitGlobal('flashsale:submission:reviewed', payload);
        if (submission.seller?.userId) {
          socket.emitToUser(submission.seller.userId, 'flashsale:submission:reviewed', payload);
        }
      }
    } catch (_) {}

    await this.logAudit(adminId, 'APPROVE_SUBMISSION', 'FlashSaleItem', result.item.id, null, result.item);
    await this.invalidateCampaignCache(submission.campaignId);
    return result;
  }

  // ============================================================================
  // 4. ATOMIC ANTI-OVERSELLING STOCK RESERVATION
  // ============================================================================
  async reserveStock(params: {
    flashSaleItemId: string;
    customerId: string;
    quantity: number;
    idempotencyKey?: string;
    cartId?: string;
    reservationTtlMinutes?: number;
  }) {
    const { flashSaleItemId, customerId, quantity, idempotencyKey, cartId, reservationTtlMinutes = 10 } = params;

    if (quantity <= 0) {
      throw new AppError('Quantity must be greater than 0', 400, 'FLASH_SALE_INVALID_QUANTITY');
    }

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existingReservation = await prisma.flashSaleReservation.findUnique({
        where: { idempotencyKey },
      });
      if (existingReservation) {
        if (existingReservation.customerId !== customerId) {
          throw new AppError('Idempotency key mismatch', 400);
        }
        if (
          existingReservation.status === FlashSaleReservationStatus.RESERVED &&
          existingReservation.expiresAt > new Date()
        ) {
          return existingReservation;
        }
      }
    }

    // 2. Fetch Item and validate active campaign
    const item = await prisma.flashSaleItem.findUnique({
      where: { id: flashSaleItemId },
      include: { campaign: true },
    });

    if (!item) throw new AppError('Flash sale item not found', 404, 'FLASH_SALE_ITEM_NOT_FOUND');
    if (item.status !== FlashSaleItemStatus.ACTIVE) {
      throw new AppError('Flash sale item is not active', 400, 'FLASH_SALE_ITEM_INACTIVE');
    }

    const now = new Date();
    if (
      item.campaign.status !== FlashSaleStatus.ACTIVE ||
      now < item.campaign.startAt ||
      now > item.campaign.endAt
    ) {
      throw new AppError('Flash sale campaign is not currently active', 400, 'FLASH_SALE_NOT_ACTIVE');
    }

    // 3. Check Customer Purchase Limit
    const userConverted = await prisma.flashSaleReservation.aggregate({
      where: {
        flashSaleItemId,
        customerId,
        status: FlashSaleReservationStatus.CONVERTED,
      },
      _sum: { quantity: true },
    });

    const userActiveReserved = await prisma.flashSaleReservation.aggregate({
      where: {
        flashSaleItemId,
        customerId,
        status: FlashSaleReservationStatus.RESERVED,
        expiresAt: { gt: now },
      },
      _sum: { quantity: true },
    });

    const totalUserQty =
      (userConverted._sum.quantity || 0) + (userActiveReserved._sum.quantity || 0) + quantity;

    if (totalUserQty > item.perCustomerLimit) {
      throw new AppError(
        `Purchase limit reached. Maximum allowed per customer: ${item.perCustomerLimit}`,
        400,
        'FLASH_SALE_CUSTOMER_LIMIT_REACHED'
      );
    }

    // 4. ATOMIC CONDITIONAL SQL UPDATE (Crucial anti-overselling requirement)
    // Decrement remaining, increment reservedStock in a single atomic statement
    const updatedRows = await prisma.$queryRaw<Array<{
      id: string;
      allocatedStock: number;
      reservedStock: number;
      soldStock: number;
      remainingStock: number;
    }>>`
      UPDATE "FlashSaleItem"
      SET 
        "reservedStock" = "reservedStock" + ${quantity},
        "remainingStock" = "allocatedStock" - ("reservedStock" + ${quantity}) - "soldStock",
        "updatedAt" = NOW()
      WHERE "id" = ${flashSaleItemId}
        AND ("allocatedStock" - "reservedStock" - "soldStock") >= ${quantity}
        AND "status" = 'ACTIVE'
      RETURNING "id", "allocatedStock", "reservedStock", "soldStock", "remainingStock";
    `;

    if (!updatedRows || updatedRows.length === 0) {
      // Check if completely sold out to update status
      const fresh = await prisma.flashSaleItem.findUnique({ where: { id: flashSaleItemId } });
      if (fresh && fresh.allocatedStock - fresh.reservedStock - fresh.soldStock <= 0) {
        await prisma.flashSaleItem.update({
          where: { id: flashSaleItemId },
          data: { status: FlashSaleItemStatus.SOLD_OUT },
        });
        this.broadcastItemEvent('flashsale:item:sold_out', { itemId: flashSaleItemId });
      }
      throw new AppError(
        'The requested flash sale stock is unavailable or has been claimed',
        409,
        'FLASH_SALE_STOCK_UNAVAILABLE'
      );
    }

    const updatedItem = updatedRows[0];
    const expiresAt = new Date(Date.now() + reservationTtlMinutes * 60 * 1000);

    // 5. Create authoritative Reservation record
    const reservation = await prisma.flashSaleReservation.create({
      data: {
        flashSaleItemId,
        campaignId: item.campaignId,
        customerId,
        cartId,
        quantity,
        unitPrice: item.flashSalePrice,
        totalAmount: item.flashSalePrice * quantity,
        status: FlashSaleReservationStatus.RESERVED,
        idempotencyKey,
        expiresAt,
      },
    });

    // Broadcast stock update
    this.broadcastItemEvent('flashsale:item:stock', {
      itemId: flashSaleItemId,
      remainingStock: updatedItem.remainingStock,
      allocatedStock: updatedItem.allocatedStock,
    });

    return reservation;
  }

  // ============================================================================
  // 5. RESERVATION RELEASE & CONVERSION
  // ============================================================================
  async releaseReservation(reservationId: string, customerId?: string, reason = 'EXPIRED') {
    const reservation = await prisma.flashSaleReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) return null;
    if (reservation.status !== FlashSaleReservationStatus.RESERVED) return reservation;

    if (customerId && reservation.customerId !== customerId) {
      throw new AppError('Unauthorized reservation release', 403);
    }

    const nextStatus =
      reason === 'EXPIRED' ? FlashSaleReservationStatus.EXPIRED : FlashSaleReservationStatus.RELEASED;

    return await prisma.$transaction(async (tx) => {
      // 1. Mark reservation released/expired
      const updatedRes = await tx.flashSaleReservation.update({
        where: { id: reservationId },
        data: { status: nextStatus },
      });

      // 2. Atomic release of reserved stock back to available pool
      await tx.$executeRaw`
        UPDATE "FlashSaleItem"
        SET 
          "reservedStock" = GREATEST(0, "reservedStock" - ${reservation.quantity}),
          "remainingStock" = "allocatedStock" - GREATEST(0, "reservedStock" - ${reservation.quantity}) - "soldStock",
          "status" = CASE WHEN "status" = 'SOLD_OUT' THEN 'ACTIVE'::"FlashSaleItemStatus" ELSE "status" END,
          "updatedAt" = NOW()
        WHERE "id" = ${reservation.flashSaleItemId};
      `;

      return updatedRes;
    });
  }

  async convertReservation(reservationId: string, orderId: string) {
    const reservation = await prisma.flashSaleReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) throw new AppError('Reservation not found', 404);
    if (reservation.status === FlashSaleReservationStatus.CONVERTED) {
      return reservation; // Idempotent
    }
    if (reservation.status !== FlashSaleReservationStatus.RESERVED) {
      throw new AppError('Cannot convert inactive or expired reservation', 400);
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Mark reservation CONVERTED
      const updatedRes = await tx.flashSaleReservation.update({
        where: { id: reservationId },
        data: {
          status: FlashSaleReservationStatus.CONVERTED,
          orderId,
        },
      });

      // 2. Atomic conversion: decrement reservedStock, increment soldStock
      await tx.$executeRaw`
        UPDATE "FlashSaleItem"
        SET 
          "reservedStock" = GREATEST(0, "reservedStock" - ${reservation.quantity}),
          "soldStock" = "soldStock" + ${reservation.quantity},
          "remainingStock" = "allocatedStock" - GREATEST(0, "reservedStock" - ${reservation.quantity}) - ("soldStock" + ${reservation.quantity}),
          "status" = CASE 
            WHEN ("allocatedStock" - GREATEST(0, "reservedStock" - ${reservation.quantity}) - ("soldStock" + ${reservation.quantity})) <= 0 
            THEN 'SOLD_OUT'::"FlashSaleItemStatus" 
            ELSE "status" 
          END,
          "updatedAt" = NOW()
        WHERE "id" = ${reservation.flashSaleItemId};
      `;

      return updatedRes;
    });
  }

  // ============================================================================
  // 6. INVENTORY RECONCILIATION & BACKGROUND CLEANUP
  // ============================================================================
  async expireStaleReservations(): Promise<number> {
    const now = new Date();
    const staleReservations = await prisma.flashSaleReservation.findMany({
      where: {
        status: FlashSaleReservationStatus.RESERVED,
        expiresAt: { lt: now },
      },
      take: 100,
    });

    let count = 0;
    for (const res of staleReservations) {
      try {
        await this.releaseReservation(res.id, undefined, 'EXPIRED');
        count++;
      } catch (err) {
        console.error(`[FlashSale] Failed to expire reservation ${res.id}:`, err);
      }
    }
    return count;
  }

  async activateScheduledCampaigns(): Promise<number> {
    const now = new Date();
    const scheduled = await prisma.flashSaleCampaign.findMany({
      where: {
        status: FlashSaleStatus.SCHEDULED,
        startAt: { lte: now },
        endAt: { gt: now },
      },
    });

    for (const c of scheduled) {
      await this.setCampaignStatus(c.id, FlashSaleStatus.ACTIVE, 'SYSTEM');
    }
    return scheduled.length;
  }

  async endExpiredCampaigns(): Promise<number> {
    const now = new Date();
    const active = await prisma.flashSaleCampaign.findMany({
      where: {
        status: { in: [FlashSaleStatus.ACTIVE, FlashSaleStatus.PAUSED] },
        endAt: { lte: now },
      },
    });

    for (const c of active) {
      await this.setCampaignStatus(c.id, FlashSaleStatus.ENDED, 'SYSTEM');
    }
    return active.length;
  }

  async reconcileInventory(): Promise<{ discrepanciesFound: number; corrected: number }> {
    const items = await prisma.flashSaleItem.findMany();
    let discrepanciesFound = 0;
    let corrected = 0;

    for (const item of items) {
      const calculatedRemaining = item.allocatedStock - item.reservedStock - item.soldStock;
      if (item.remainingStock !== calculatedRemaining || calculatedRemaining < 0) {
        discrepanciesFound++;
        await prisma.flashSaleItem.update({
          where: { id: item.id },
          data: {
            remainingStock: Math.max(0, calculatedRemaining),
            status: calculatedRemaining <= 0 ? FlashSaleItemStatus.SOLD_OUT : item.status,
          },
        });
        await this.logAudit(
          'SYSTEM',
          'RECONCILE_STOCK_DISCREPANCY',
          'FlashSaleItem',
          item.id,
          { remainingStock: item.remainingStock },
          { remainingStock: Math.max(0, calculatedRemaining) }
        );
        corrected++;
      }
    }

    return { discrepanciesFound, corrected };
  }

  // ============================================================================
  // 7. ANALYTICS (Admin & Seller Isolation)
  // ============================================================================
  async getAdminCampaignAnalytics(campaignId: string) {
    const campaign = await prisma.flashSaleCampaign.findUnique({
      where: { id: campaignId },
      include: {
        items: {
          include: {
            product: { select: { id: true, nameAr: true, nameEn: true, price: true } },
            seller: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    if (!campaign) throw new AppError('Campaign not found', 404);

    const convertedReservations = await prisma.flashSaleReservation.findMany({
      where: {
        campaignId,
        status: FlashSaleReservationStatus.CONVERTED,
      },
    });

    const totalSoldUnits = convertedReservations.reduce((sum, r) => sum + r.quantity, 0);
    const totalRevenue = convertedReservations.reduce((sum, r) => sum + r.totalAmount, 0);

    const totalAllocatedStock = campaign.items.reduce((sum, i) => sum + i.allocatedStock, 0);
    const totalReservedStock = campaign.items.reduce((sum, i) => sum + i.reservedStock, 0);
    const totalRemainingStock = campaign.items.reduce((sum, i) => sum + i.remainingStock, 0);

    const totalOriginalValue = campaign.items.reduce(
      (sum, i) => sum + i.originalPrice * i.soldStock,
      0
    );
    const totalDiscountsGiven = Math.max(0, totalOriginalValue - totalRevenue);
    const sellThroughRate =
      totalAllocatedStock > 0 ? Math.round((totalSoldUnits / totalAllocatedStock) * 100) : 0;

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: campaign.status,
      totalProducts: campaign.items.length,
      totalAllocatedStock,
      totalReservedStock,
      totalSoldUnits,
      totalRemainingStock,
      totalRevenue,
      totalDiscountsGiven,
      sellThroughRate,
      items: campaign.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.product.nameAr,
        sellerName: `${i.seller.user.firstName} ${i.seller.user.lastName}`,
        originalPrice: i.originalPrice,
        flashSalePrice: i.flashSalePrice,
        allocatedStock: i.allocatedStock,
        reservedStock: i.reservedStock,
        soldStock: i.soldStock,
        remainingStock: i.remainingStock,
        revenue: i.soldStock * i.flashSalePrice,
        status: i.status,
      })),
    };
  }

  async getSellerAnalytics(sellerId: string) {
    const items = await prisma.flashSaleItem.findMany({
      where: { sellerId },
      include: {
        campaign: { select: { id: true, name: true, status: true, startAt: true, endAt: true } },
        product: { select: { id: true, nameAr: true } },
      },
    });

    const submissions = await prisma.flashSaleSellerSubmission.findMany({
      where: { sellerId },
    });

    const totalAllocated = items.reduce((sum, i) => sum + i.allocatedStock, 0);
    const totalSold = items.reduce((sum, i) => sum + i.soldStock, 0);
    const totalRevenue = items.reduce((sum, i) => sum + i.soldStock * i.flashSalePrice, 0);
    const sellThrough = totalAllocated > 0 ? Math.round((totalSold / totalAllocated) * 100) : 0;

    return {
      totalSubmissions: submissions.length,
      approvedProducts: items.length,
      totalAllocatedStock: totalAllocated,
      totalSoldUnits: totalSold,
      totalRevenue,
      sellThroughRate: sellThrough,
      campaigns: items.map((i) => ({
        campaignId: i.campaignId,
        campaignName: i.campaign.name,
        campaignStatus: i.campaign.status,
        productName: i.product.nameAr,
        flashSalePrice: i.flashSalePrice,
        soldStock: i.soldStock,
        remainingStock: i.remainingStock,
        revenue: i.soldStock * i.flashSalePrice,
      })),
    };
  }

  // ============================================================================
  // 8. REDIS CACHE & REAL-TIME WEBSOCKET HELPERS
  // ============================================================================
  async getActiveCampaignsCached() {
    const cacheKey = 'flash_sales:active_list';
    const cached = await redis.getJson<any[]>(cacheKey);
    if (cached) return cached;

    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: FlashSaleStatus.ACTIVE,
        startAt: { lte: new Date() },
        endAt: { gt: new Date() },
      },
      orderBy: [{ priority: 'desc' }, { displayOrder: 'asc' }],
      include: {
        items: {
          where: { status: { in: [FlashSaleItemStatus.ACTIVE, FlashSaleItemStatus.SOLD_OUT] } },
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true } },
                store: { select: { id: true, name: true, logo: true } },
              },
            },
          },
        },
      },
    });

    await redis.setJson(cacheKey, campaigns, 60); // 1 minute TTL
    return campaigns;
  }

  async invalidateCampaignCache(campaignId?: string) {
    await redis.del('flash_sales:active_list');
    await redis.del('flash_sales:upcoming_list');
    if (campaignId) {
      await redis.del(`flash_sales:campaign:${campaignId}`);
    }
  }

  private broadcastCampaignEvent(status: FlashSaleStatus, campaign: any) {
    try {
      const socket = SocketService.get();
      if (!socket) return;
      const eventMap: Partial<Record<FlashSaleStatus, string>> = {
        [FlashSaleStatus.ACTIVE]: 'flashsale:campaign:started',
        [FlashSaleStatus.PAUSED]: 'flashsale:campaign:paused',
        [FlashSaleStatus.ENDED]: 'flashsale:campaign:ended',
        [FlashSaleStatus.CANCELLED]: 'flashsale:campaign:cancelled',
      };
      const evt = eventMap[status];
      if (evt) {
        socket.emitGlobal(evt, {
          campaignId: campaign.id,
          name: campaign.name,
          status,
          serverTime: new Date().toISOString(),
        });
      }
    } catch (_) {}
  }

  private broadcastItemEvent(event: string, data: any) {
    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal(event, { ...data, serverTime: new Date().toISOString() });
      }
    } catch (_) {}
  }

  private async logAudit(
    actorId: string | undefined,
    action: string,
    resource: string,
    entityId: string,
    before: any,
    after: any
  ) {
    try {
      await prisma.auditLog.create({
        data: {
          userId: actorId || null,
          action,
          resource,
          details: JSON.stringify({ entityId, before, after }),
        },
      });
    } catch (_) {}
  }
}

export const flashSaleService = FlashSaleService.getInstance();
