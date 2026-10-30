import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { storageService } from '../../services/storage/storage.service';
import {
  ReviewStatus,
  ReviewMediaType,
  ReviewHelpfulVoteType,
  OrderStatus,
  SellerOrderStatus,
  ReviewSellerResponseStatus,
  ReviewMediaModerationStatus,
} from '@prisma/client';
import { SocketService } from '../../services/websocket/socket.service';
import { RewardsEarningService } from '../rewards/services/rewards-earning.service';
import { notificationEventBus } from '../notifications/services/event-bus';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { AppType } from '../notifications/notification.types';

// ──────────────────────────────────────────────────────────────────────────────
// REVIEW POLICY DEFAULTS (overridden by SystemSetting table at runtime)
// ──────────────────────────────────────────────────────────────────────────────

export interface ReviewPolicy {
  reviewsEnabled: boolean;
  requireVerifiedPurchase: boolean;
  autoPublishReviews: boolean;
  allowReviewEdit: boolean;
  reviewEditWindowHours: number;
  allowReviewDelete: boolean;
  reviewDeleteWindowHours: number;
  maxReviewBodyLength: number;
  maxReviewTitleLength: number;
  maxImagesPerReview: number;
  maxVideosPerReview: number;
  maxImageSizeMb: number;
  maxVideoSizeMb: number;
  requireMediaModeration: boolean;
}

const POLICY_DEFAULTS: ReviewPolicy = {
  reviewsEnabled: true,
  requireVerifiedPurchase: true,
  autoPublishReviews: true,
  allowReviewEdit: true,
  reviewEditWindowHours: 48,
  allowReviewDelete: true,
  reviewDeleteWindowHours: 720, // 30 days window
  maxReviewBodyLength: 2000,
  maxReviewTitleLength: 200,
  maxImagesPerReview: 5,
  maxVideosPerReview: 1,
  maxImageSizeMb: 10,
  maxVideoSizeMb: 50,
  requireMediaModeration: false,
};

/**
 * Load review policy from SystemSetting table, falling back to defaults.
 * Settings are stored as group='reviews' in SystemSetting.
 */
export async function getReviewPolicy(): Promise<ReviewPolicy> {
  const settings = await prisma.systemSetting.findMany({ where: { group: 'reviews' } });
  const map = new Map(settings.map((s) => [s.key, s.value]));

  function boolVal(key: string, def: boolean): boolean {
    const v = map.get(key);
    if (v === undefined) return def;
    return v === 'true';
  }
  function intVal(key: string, def: number): number {
    const v = map.get(key);
    if (v === undefined) return def;
    const n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  }

  return {
    reviewsEnabled: boolVal('reviews_enabled', POLICY_DEFAULTS.reviewsEnabled),
    requireVerifiedPurchase: boolVal('require_verified_purchase', POLICY_DEFAULTS.requireVerifiedPurchase),
    autoPublishReviews: boolVal('auto_publish_reviews', POLICY_DEFAULTS.autoPublishReviews),
    allowReviewEdit: boolVal('allow_review_edit', POLICY_DEFAULTS.allowReviewEdit),
    reviewEditWindowHours: intVal('review_edit_window_hours', POLICY_DEFAULTS.reviewEditWindowHours),
    allowReviewDelete: boolVal('allow_review_delete', POLICY_DEFAULTS.allowReviewDelete),
    reviewDeleteWindowHours: intVal('review_delete_window_hours', POLICY_DEFAULTS.reviewDeleteWindowHours),
    maxReviewBodyLength: intVal('max_review_body_length', POLICY_DEFAULTS.maxReviewBodyLength),
    maxReviewTitleLength: intVal('max_review_title_length', POLICY_DEFAULTS.maxReviewTitleLength),
    maxImagesPerReview: intVal('max_images_per_review', POLICY_DEFAULTS.maxImagesPerReview),
    maxVideosPerReview: intVal('max_videos_per_review', POLICY_DEFAULTS.maxVideosPerReview),
    maxImageSizeMb: intVal('max_image_size_mb', POLICY_DEFAULTS.maxImageSizeMb),
    maxVideoSizeMb: intVal('max_video_size_mb', POLICY_DEFAULTS.maxVideoSizeMb),
    requireMediaModeration: boolVal('require_media_moderation', POLICY_DEFAULTS.requireMediaModeration),
  };
}

/**
 * Save review policy to SystemSetting table.
 */
export async function saveReviewPolicy(policy: Partial<ReviewPolicy>): Promise<void> {
  const entries: Array<{ key: string; value: string }> = [];
  if (policy.reviewsEnabled !== undefined) entries.push({ key: 'reviews_enabled', value: String(policy.reviewsEnabled) });
  if (policy.requireVerifiedPurchase !== undefined) entries.push({ key: 'require_verified_purchase', value: String(policy.requireVerifiedPurchase) });
  if (policy.autoPublishReviews !== undefined) entries.push({ key: 'auto_publish_reviews', value: String(policy.autoPublishReviews) });
  if (policy.allowReviewEdit !== undefined) entries.push({ key: 'allow_review_edit', value: String(policy.allowReviewEdit) });
  if (policy.reviewEditWindowHours !== undefined) entries.push({ key: 'review_edit_window_hours', value: String(policy.reviewEditWindowHours) });
  if (policy.allowReviewDelete !== undefined) entries.push({ key: 'allow_review_delete', value: String(policy.allowReviewDelete) });
  if (policy.reviewDeleteWindowHours !== undefined) entries.push({ key: 'review_delete_window_hours', value: String(policy.reviewDeleteWindowHours) });
  if (policy.maxReviewBodyLength !== undefined) entries.push({ key: 'max_review_body_length', value: String(policy.maxReviewBodyLength) });
  if (policy.maxReviewTitleLength !== undefined) entries.push({ key: 'max_review_title_length', value: String(policy.maxReviewTitleLength) });
  if (policy.maxImagesPerReview !== undefined) entries.push({ key: 'max_images_per_review', value: String(policy.maxImagesPerReview) });
  if (policy.maxVideosPerReview !== undefined) entries.push({ key: 'max_videos_per_review', value: String(policy.maxVideosPerReview) });
  if (policy.maxImageSizeMb !== undefined) entries.push({ key: 'max_image_size_mb', value: String(policy.maxImageSizeMb) });
  if (policy.maxVideoSizeMb !== undefined) entries.push({ key: 'max_video_size_mb', value: String(policy.maxVideoSizeMb) });
  if (policy.requireMediaModeration !== undefined) entries.push({ key: 'require_media_moderation', value: String(policy.requireMediaModeration) });

  await Promise.all(
    entries.map((e) =>
      prisma.systemSetting.upsert({
        where: { key: e.key },
        update: { value: e.value, group: 'reviews', type: 'boolean' },
        create: { key: e.key, value: e.value, group: 'reviews', type: 'boolean' },
      })
    )
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY ENGINE
// ──────────────────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  eligible: boolean;
  alreadyReviewed: boolean;
  orderItemId: string;
  productId: string;
  sellerId: string;
  orderId: string;
  sellerOrderId: string;
  verifiedPurchase: boolean;
  reason?: string;
}

/**
 * Checks whether a customer is eligible to write a review for a specific order item.
 * This is the backend-authoritative eligibility check.
 */
export async function checkEligibility(userId: string, orderItemId: string): Promise<EligibilityResult> {
  // 1. Load order item with full chain: orderItem → sellerOrder → order → product → store
  const orderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: {
      sellerOrder: {
        include: {
          order: true,
          seller: true,
        },
      },
      product: {
        include: { store: { select: { sellerId: true } } },
      },
    },
  });

  if (!orderItem) throw new AppError('عنصر الطلب غير موجود', 404, 'ORDER_ITEM_NOT_FOUND');

  // 2. Verify the order belongs to this customer
  const order = orderItem.sellerOrder.order;
  if (order.userId !== userId) throw new AppError('غير مصرح', 403, 'UNAUTHORIZED_REVIEW');

  // 3. Check seller order status — must be DELIVERED
  const sellerOrder = orderItem.sellerOrder;
  const isDelivered =
    sellerOrder.status === SellerOrderStatus.DELIVERED ||
    order.status === OrderStatus.DELIVERED;

  if (!isDelivered) {
    return {
      eligible: false,
      alreadyReviewed: false,
      orderItemId,
      productId: orderItem.productId,
      sellerId: sellerOrder.sellerId,
      orderId: order.id,
      sellerOrderId: sellerOrder.id,
      verifiedPurchase: false,
      reason: 'PURCHASE_NOT_ELIGIBLE',
    };
  }

  // Sync suborder status if parent order was marked DELIVERED
  if (sellerOrder.status !== SellerOrderStatus.DELIVERED && order.status === OrderStatus.DELIVERED) {
    try {
      await prisma.sellerOrder.update({
        where: { id: sellerOrder.id },
        data: { status: SellerOrderStatus.DELIVERED, deliveredAt: new Date() },
      });
    } catch (_) {}
  }

  // 4. Check for existing review
  const existing = await prisma.productReview.findUnique({
    where: { userId_orderItemId: { userId, orderItemId } },
    select: { id: true, status: true },
  });

  if (existing && existing.status !== ReviewStatus.DELETED) {
    return {
      eligible: false,
      alreadyReviewed: true,
      orderItemId,
      productId: orderItem.productId,
      sellerId: sellerOrder.sellerId,
      orderId: order.id,
      sellerOrderId: sellerOrder.id,
      verifiedPurchase: true,
      reason: 'ALREADY_REVIEWED',
    };
  }

  return {
    eligible: true,
    alreadyReviewed: false,
    orderItemId,
    productId: orderItem.productId,
    sellerId: sellerOrder.sellerId,
    orderId: order.id,
    sellerOrderId: sellerOrder.id,
    verifiedPurchase: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// RATING AGGREGATE ENGINE  (transactional, race-condition safe)
// ──────────────────────────────────────────────────────────────────────────────

function starKey(rating: number): { oneStarCount?: any; twoStarCount?: any; threeStarCount?: any; fourStarCount?: any; fiveStarCount?: any } {
  switch (rating) {
    case 1: return { oneStarCount: { increment: 1 } };
    case 2: return { twoStarCount: { increment: 1 } };
    case 3: return { threeStarCount: { increment: 1 } };
    case 4: return { fourStarCount: { increment: 1 } };
    case 5: return { fiveStarCount: { increment: 1 } };
    default: return {};
  }
}

function starKeyDecrement(rating: number): { oneStarCount?: any; twoStarCount?: any; threeStarCount?: any; fourStarCount?: any; fiveStarCount?: any } {
  switch (rating) {
    case 1: return { oneStarCount: { decrement: 1 } };
    case 2: return { twoStarCount: { decrement: 1 } };
    case 3: return { threeStarCount: { decrement: 1 } };
    case 4: return { fourStarCount: { decrement: 1 } };
    case 5: return { fiveStarCount: { decrement: 1 } };
    default: return {};
  }
}

type PrismaTx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Full recompute of a product's rating summary from the DB.
 * Used after any operation that could affect the aggregate.
 * Runs within an existing transaction.
 */
export async function recomputeRatingSummary(tx: PrismaTx, productId: string): Promise<void> {
  const agg = await tx.productReview.aggregate({
    where: { productId, status: ReviewStatus.PUBLISHED },
    _avg: { rating: true },
    _count: { id: true },
  });

  const distribution = await tx.productReview.groupBy({
    by: ['rating'],
    where: { productId, status: ReviewStatus.PUBLISHED },
    _count: { id: true },
  });

  const distMap = new Map(distribution.map((d) => [d.rating, d._count.id]));

  const withBodyCount = await tx.productReview.count({
    where: { productId, status: ReviewStatus.PUBLISHED, body: { not: null } },
  });

  const photoCount = await tx.reviewMedia.count({
    where: {
      review: { productId, status: ReviewStatus.PUBLISHED },
      mediaType: ReviewMediaType.IMAGE,
      moderationStatus: ReviewMediaModerationStatus.APPROVED,
    },
  });

  const videoCount = await tx.reviewMedia.count({
    where: {
      review: { productId, status: ReviewStatus.PUBLISHED },
      mediaType: ReviewMediaType.VIDEO,
      moderationStatus: ReviewMediaModerationStatus.APPROVED,
    },
  });

  const verifiedCount = await tx.productReview.count({
    where: { productId, status: ReviewStatus.PUBLISHED, verifiedPurchase: true },
  });

  const ratingCount = agg._count.id;
  const averageRating = agg._avg.rating ? parseFloat(agg._avg.rating.toFixed(2)) : 0;

  await tx.productRatingSummary.upsert({
    where: { productId },
    create: {
      productId,
      averageRating,
      ratingCount,
      oneStarCount: distMap.get(1) ?? 0,
      twoStarCount: distMap.get(2) ?? 0,
      threeStarCount: distMap.get(3) ?? 0,
      fourStarCount: distMap.get(4) ?? 0,
      fiveStarCount: distMap.get(5) ?? 0,
      reviewCount: withBodyCount,
      photoReviewCount: photoCount,
      videoReviewCount: videoCount,
      verifiedReviewCount: verifiedCount,
    },
    update: {
      averageRating,
      ratingCount,
      oneStarCount: distMap.get(1) ?? 0,
      twoStarCount: distMap.get(2) ?? 0,
      threeStarCount: distMap.get(3) ?? 0,
      fourStarCount: distMap.get(4) ?? 0,
      fiveStarCount: distMap.get(5) ?? 0,
      reviewCount: withBodyCount,
      photoReviewCount: photoCount,
      videoReviewCount: videoCount,
      verifiedReviewCount: verifiedCount,
    },
  });

  // Keep denormalized product fields in sync
  await tx.product.update({
    where: { id: productId },
    data: { rating: averageRating, reviewCount: ratingCount },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// REVIEW SELECTS (safe — never exposes private data)
// ──────────────────────────────────────────────────────────────────────────────

export const REVIEW_PUBLIC_SELECT = {
  id: true,
  userId: true,
  productId: true,
  sellerId: true,
  orderId: true,
  orderItemId: true,
  rating: true,
  title: true,
  body: true,
  status: true,
  verifiedPurchase: true,
  helpfulCount: true,
  reportCount: true,
  sellerResponseExists: true,
  locale: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  user: {
    select: {
      firstName: true,
      lastName: true,
      avatar: true,
      // Never expose: email, phone, passwordHash
    },
  },
  media: {
    select: {
      id: true,
      mediaType: true,
      url: true,
      thumbnailUrl: true,
      mimeType: true,
      width: true,
      height: true,
      durationSeconds: true,
      processingStatus: true,
      moderationStatus: true,
      sortOrder: true,
    },
    where: { moderationStatus: ReviewMediaModerationStatus.APPROVED },
    orderBy: { sortOrder: 'asc' as const },
  },
  sellerResponse: {
    select: {
      id: true,
      body: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    where: { status: ReviewSellerResponseStatus.PUBLISHED },
  },
} as const;

// ──────────────────────────────────────────────────────────────────────────────
// REVIEW CRUD
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateReviewInput {
  userId: string;
  orderItemId: string;
  rating: number;
  title?: string;
  body?: string;
  locale?: string;
  mediaKeys?: Array<{ storageKey: string; url: string; mediaType: 'IMAGE' | 'VIDEO'; mimeType: string; fileSize: number; width?: number; height?: number; durationSeconds?: number }>;
}

export async function createReview(input: CreateReviewInput) {
  const { userId, orderItemId, rating, title, body, locale, mediaKeys = [] } = input;
  const policy = await getReviewPolicy();

  if (!policy.reviewsEnabled) throw new AppError('التقييمات معطلة حالياً', 403, 'REVIEWS_DISABLED');

  // Validate rating range
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError('التقييم يجب أن يكون بين 1 و 5', 400, 'INVALID_RATING');
  }

  // Validate text lengths
  if (title && title.length > policy.maxReviewTitleLength) {
    throw new AppError(`عنوان التقييم طويل جداً (الحد: ${policy.maxReviewTitleLength} حرف)`, 400);
  }
  if (body && body.length > policy.maxReviewBodyLength) {
    throw new AppError(`نص التقييم طويل جداً (الحد: ${policy.maxReviewBodyLength} حرف)`, 400);
  }

  // Eligibility check
  const eligibility = await checkEligibility(userId, orderItemId);
  if (!eligibility.eligible) {
    if (eligibility.alreadyReviewed) throw new AppError('لقد قمت بتقييم هذا المنتج سابقاً', 409, 'ALREADY_REVIEWED');
    throw new AppError('غير مؤهل لتقييم هذا المنتج. يجب استلام الطلب أولاً', 403, 'REVIEW_NOT_ELIGIBLE');
  }

  // Validate media counts
  const images = mediaKeys.filter((m) => m.mediaType === 'IMAGE');
  const videos = mediaKeys.filter((m) => m.mediaType === 'VIDEO');
  if (images.length > policy.maxImagesPerReview) throw new AppError(`عدد الصور يتجاوز الحد المسموح (${policy.maxImagesPerReview})`, 400, 'INVALID_MEDIA');
  if (videos.length > policy.maxVideosPerReview) throw new AppError(`عدد الفيديوهات يتجاوز الحد المسموح (${policy.maxVideosPerReview})`, 400, 'INVALID_MEDIA');

  // Ratings and reviews are auto-published and approved automatically without admin intervention
  const initialStatus: ReviewStatus = ReviewStatus.PUBLISHED;
  const mediaModerationStatus = ReviewMediaModerationStatus.APPROVED;

  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.productReview.create({
      data: {
        userId,
        productId: eligibility.productId,
        sellerId: eligibility.sellerId,
        orderId: eligibility.orderId,
        sellerOrderId: eligibility.sellerOrderId,
        orderItemId,
        rating,
        title: title?.trim() || null,
        body: body?.trim() || null,
        locale: locale || 'ar',
        status: initialStatus,
        verifiedPurchase: eligibility.verifiedPurchase,
        publishedAt: new Date(),
        media: {
          create: mediaKeys.map((m, i) => ({
            mediaType: m.mediaType as ReviewMediaType,
            storageKey: m.storageKey,
            url: m.url,
            mimeType: m.mimeType,
            fileSize: m.fileSize,
            width: m.width ?? null,
            height: m.height ?? null,
            durationSeconds: m.durationSeconds ?? null,
            sortOrder: i,
            processingStatus: 'READY' as any,
            moderationStatus: mediaModerationStatus,
          })),
        },
      },
      select: REVIEW_PUBLIC_SELECT,
    });

    await recomputeRatingSummary(tx, eligibility.productId);

    return created;
  });

  // Notify seller & broadcast real-time review publication
  await notifySellerNewReview(eligibility.sellerId, eligibility.productId).catch(() => {});
  try {
    SocketService.get()?.emitGlobal('review:created', {
      reviewId: review.id,
      productId: eligibility.productId,
      rating,
    });
    SocketService.get()?.emitGlobal('review:approved', {
      reviewId: review.id,
      productId: eligibility.productId,
    });
  } catch (_) {}

  // SOUQNAA Coins Review Rewards (§32, §33, §34)
  try {
    await RewardsEarningService.onReviewCreated({
      reviewId: review.id,
      userId,
      productId: eligibility.productId,
      hasPhoto: images.length > 0,
      hasVideo: videos.length > 0,
    });
  } catch (err) {
    console.error('[Rewards] Failed to award review coins:', err);
  }

  // Seller Performance Score Engine event ingestion
  try {
    const { SellerPerformanceEventService } = await import('../seller-performance/seller-performance-event.service');
    SellerPerformanceEventService.recordEvent({
      sellerId: eligibility.sellerId,
      eventType: 'REVIEW_CREATED',
      entityId: review.id,
      payload: { rating },
    }).catch(() => {});
  } catch (err) {}

  // Invalidate customer order summary cache and notify client in real-time
  try {
    const { redis } = await import('../../database/redis');
    await redis.del(`order_summary:${userId}`);
    SocketService.get()?.emitToUser(userId, 'order:summary_updated', {
      userId,
      filter: 'TO_REVIEW',
    });
  } catch (_) {}

  return review;
}

export async function updateReview(
  reviewId: string,
  userId: string,
  data: { rating?: number; title?: string; body?: string; mediaKeys?: CreateReviewInput['mediaKeys'] }
) {
  const policy = await getReviewPolicy();
  if (!policy.allowReviewEdit) {
    throw new AppError('تعديل التقييم غير مسموح به وفقاً لسياسة المنصة', 403, 'REVIEW_EDIT_NOT_ALLOWED');
  }

  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');
  if (review.userId !== userId) throw new AppError('غير مصرح لك بتعديل هذا التقييم', 403, 'UNAUTHORIZED_REVIEW');
  if (review.status === ReviewStatus.DELETED) throw new AppError('لا يمكن تعديل تقييم تم حذفه', 400, 'REVIEW_ALREADY_DELETED');

  // Check edit policy time window
  const windowMs = policy.reviewEditWindowHours * 60 * 60 * 1000;
  const elapsedMs = Date.now() - review.createdAt.getTime();
  if (elapsedMs > windowMs) {
    const hours = policy.reviewEditWindowHours;
    const days = Math.floor(hours / 24);
    const windowDesc = days > 0 && hours % 24 === 0
      ? `${days} ${days === 1 ? 'يوم' : 'أيام'}`
      : `${hours} ساعة`;
    throw new AppError(
      `انتهت المهلة المسموح بها لتعديل التقييم (${windowDesc} من تاريخ النشر). لا يمكن تعديل التقييم بعد انقضاء هذه المهلة وفقاً لسياسة المنصة.`,
      403,
      'REVIEW_EDIT_WINDOW_EXPIRED'
    );
  }

  // Validate rating range
  if (data.rating !== undefined) {
    if (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) {
      throw new AppError('التقييم يجب أن يكون عدداً صحيحاً بين 1 و 5 نجوم', 400, 'INVALID_RATING');
    }
  }

  // Validate title & body lengths
  if (data.title && data.title.length > policy.maxReviewTitleLength) {
    throw new AppError(`عنوان التقييم طويل جداً (الحد الأقصى: ${policy.maxReviewTitleLength} حرف)`, 400, 'TITLE_TOO_LONG');
  }
  if (data.body && data.body.length > policy.maxReviewBodyLength) {
    throw new AppError(`نص التقييم طويل جداً (الحد الأقصى: ${policy.maxReviewBodyLength} حرف)`, 400, 'BODY_TOO_LONG');
  }

  // Validate media counts if mediaKeys provided
  if (data.mediaKeys !== undefined) {
    const images = data.mediaKeys.filter((m) => m.mediaType === 'IMAGE');
    const videos = data.mediaKeys.filter((m) => m.mediaType === 'VIDEO');
    if (images.length > policy.maxImagesPerReview) {
      throw new AppError(`عدد الصور يتجاوز الحد المسموح (${policy.maxImagesPerReview})`, 400, 'INVALID_MEDIA');
    }
    if (videos.length > policy.maxVideosPerReview) {
      throw new AppError(`عدد الفيديوهات يتجاوز الحد المسموح (${policy.maxVideosPerReview})`, 400, 'INVALID_MEDIA');
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    // If mediaKeys was explicitly provided, update review media
    if (data.mediaKeys !== undefined) {
      await tx.reviewMedia.deleteMany({ where: { reviewId } });
      if (data.mediaKeys.length > 0) {
        const mediaModerationStatus = policy.requireMediaModeration
          ? ReviewMediaModerationStatus.PENDING
          : ReviewMediaModerationStatus.APPROVED;
        await tx.reviewMedia.createMany({
          data: data.mediaKeys.map((m, i) => ({
            reviewId,
            mediaType: m.mediaType as ReviewMediaType,
            storageKey: m.storageKey,
            url: m.url,
            mimeType: m.mimeType,
            fileSize: m.fileSize,
            width: m.width ?? null,
            height: m.height ?? null,
            durationSeconds: m.durationSeconds ?? null,
            sortOrder: i,
            processingStatus: 'READY' as any,
            moderationStatus: mediaModerationStatus,
          })),
        });
      }
    }

    const updatedReview = await tx.productReview.update({
      where: { id: reviewId },
      data: {
        rating: data.rating ?? review.rating,
        title: data.title !== undefined ? data.title.trim() || null : review.title,
        body: data.body !== undefined ? data.body.trim() || null : review.body,
        updatedAt: new Date(),
      },
      select: REVIEW_PUBLIC_SELECT,
    });

    if (review.status === ReviewStatus.PUBLISHED) {
      await recomputeRatingSummary(tx, review.productId);
    }

    return updatedReview;
  });

  return updated;
}

export async function deleteReview(reviewId: string, userId: string) {
  const policy = await getReviewPolicy();
  if (!policy.allowReviewDelete) throw new AppError('حذف التقييم غير مسموح به', 403, 'REVIEW_DELETE_NOT_ALLOWED');

  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');
  if (review.userId !== userId) throw new AppError('غير مصرح', 403, 'UNAUTHORIZED_REVIEW');
  if (review.status === ReviewStatus.DELETED) throw new AppError('التقييم محذوف بالفعل', 404, 'REVIEW_NOT_FOUND');

  const windowMs = policy.reviewDeleteWindowHours * 60 * 60 * 1000;
  if (Date.now() - review.createdAt.getTime() > windowMs) {
    throw new AppError('انتهت مدة حذف التقييم', 403, 'REVIEW_DELETE_NOT_ALLOWED');
  }

  await prisma.$transaction(async (tx) => {
    await tx.productReview.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.DELETED, deletedAt: new Date() },
    });

    if (review.status === ReviewStatus.PUBLISHED) {
      await recomputeRatingSummary(tx, review.productId);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// LISTING & FILTERING
// ──────────────────────────────────────────────────────────────────────────────

export interface ListReviewsOptions {
  productId?: string;
  userId?: string;
  sellerId?: string;
  rating?: number;
  verified?: boolean;
  withMedia?: boolean;
  mediaType?: 'IMAGE' | 'VIDEO';
  status?: ReviewStatus | ReviewStatus[];
  sort?: 'NEWEST' | 'HIGHEST' | 'LOWEST' | 'MOST_HELPFUL' | 'MOST_RELEVANT';
  cursor?: string;
  limit?: number;
}

export async function listReviews(opts: ListReviewsOptions) {
  const limit = Math.min(opts.limit ?? 20, 50);

  const where: any = {};

  if (opts.productId) where.productId = opts.productId;
  if (opts.userId) where.userId = opts.userId;
  if (opts.sellerId) where.sellerId = opts.sellerId;
  if (opts.rating) where.rating = opts.rating;
  if (opts.verified !== undefined) where.verifiedPurchase = opts.verified;
  if (opts.withMedia) where.media = { some: {} };
  if (opts.mediaType) where.media = { some: { mediaType: opts.mediaType } };

  if (opts.status) {
    where.status = Array.isArray(opts.status) ? { in: opts.status } : opts.status;
  } else if (!opts.userId) {
    // Public listing: only show published
    where.status = ReviewStatus.PUBLISHED;
  }

  let orderBy: any = {};
  switch (opts.sort) {
    case 'HIGHEST': orderBy = { rating: 'desc' }; break;
    case 'LOWEST': orderBy = { rating: 'asc' }; break;
    case 'MOST_HELPFUL': orderBy = { helpfulCount: 'desc' }; break;
    default: orderBy = { createdAt: 'desc' }; break;
  }

  const cursorObj = opts.cursor ? { id: opts.cursor } : undefined;

  const reviews = await prisma.productReview.findMany({
    where,
    orderBy,
    cursor: cursorObj,
    skip: cursorObj ? 1 : 0,
    take: limit + 1, // fetch one extra to detect next page
    select: REVIEW_PUBLIC_SELECT,
  });

  const hasMore = reviews.length > limit;
  const data = hasMore ? reviews.slice(0, limit) : reviews;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  const formatted = data.map((r: any) => {
    const customerName = [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ') || 'عميل موثق';
    return {
      ...r,
      customerId: r.userId,
      customerName,
      customerAvatar: r.user?.avatar || null,
      isVerifiedPurchase: r.verifiedPurchase ?? true,
      images: Array.isArray(r.media) ? r.media.map((m: any) => m.url) : [],
      sellerReply: r.sellerResponse?.body || null,
      user: {
        ...r.user,
        name: customerName,
      },
    };
  });

  return { reviews: formatted, nextCursor, hasMore };
}

export async function getRatingSummary(productId: string) {
  const summary = await prisma.productRatingSummary.findUnique({ where: { productId } });
  if (!summary) {
    return {
      averageRating: 0,
      ratingCount: 0,
      reviewCount: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      verifiedReviewCount: 0,
      photoReviewCount: 0,
      videoReviewCount: 0,
    };
  }
  return {
    averageRating: summary.averageRating,
    ratingCount: summary.ratingCount,
    reviewCount: summary.reviewCount,
    distribution: {
      1: summary.oneStarCount,
      2: summary.twoStarCount,
      3: summary.threeStarCount,
      4: summary.fourStarCount,
      5: summary.fiveStarCount,
    },
    verifiedReviewCount: summary.verifiedReviewCount,
    photoReviewCount: summary.photoReviewCount,
    videoReviewCount: summary.videoReviewCount,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// SELLER RESPONSE
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Verifies that the authenticated seller owns the product being reviewed.
 * Never trusts sellerId from the client.
 */
async function assertSellerOwnsReview(reviewId: string, sellerId: string) {
  const review = await prisma.productReview.findUnique({
    where: { id: reviewId },
    include: { product: { include: { store: true } } },
  });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');
  if (review.product.store.sellerId !== sellerId) {
    throw new AppError('غير مصرح بالرد على هذا التقييم', 403, 'UNAUTHORIZED_SELLER_RESPONSE');
  }
  return review;
}

export async function createSellerResponse(reviewId: string, sellerId: string, body: string) {
  const review = await assertSellerOwnsReview(reviewId, sellerId);

  if (review.status !== ReviewStatus.PUBLISHED) {
    throw new AppError('لا يمكن الرد على تقييم غير منشور', 400);
  }

  const existing = await prisma.reviewSellerResponse.findUnique({ where: { reviewId } });
  if (existing && existing.status !== 'DELETED') {
    throw new AppError('لديك رد بالفعل على هذا التقييم', 409);
  }

  const response = await prisma.$transaction(async (tx) => {
    const resp = await tx.reviewSellerResponse.upsert({
      where: { reviewId },
      create: { reviewId, sellerId, body: body.trim(), status: 'PUBLISHED' },
      update: { body: body.trim(), status: 'PUBLISHED', updatedAt: new Date() },
    });

    await tx.productReview.update({
      where: { id: reviewId },
      data: { sellerResponseExists: true },
    });

    return resp;
  });

  // Notify customer
  await notifyCustomerSellerResponded(review.userId, reviewId, review.productId).catch(() => {});

  return response;
}

export async function updateSellerResponse(reviewId: string, sellerId: string, body: string) {
  await assertSellerOwnsReview(reviewId, sellerId);

  const response = await prisma.reviewSellerResponse.findUnique({ where: { reviewId } });
  if (!response || response.status === 'DELETED') throw new AppError('الرد غير موجود', 404);
  if (response.sellerId !== sellerId) throw new AppError('غير مصرح', 403);

  return prisma.reviewSellerResponse.update({
    where: { reviewId },
    data: { body: body.trim(), updatedAt: new Date() },
  });
}

export async function deleteSellerResponse(reviewId: string, sellerId: string) {
  await assertSellerOwnsReview(reviewId, sellerId);

  const response = await prisma.reviewSellerResponse.findUnique({ where: { reviewId } });
  if (!response) throw new AppError('الرد غير موجود', 404);
  if (response.sellerId !== sellerId) throw new AppError('غير مصرح', 403);

  await prisma.$transaction(async (tx) => {
    await tx.reviewSellerResponse.update({
      where: { reviewId },
      data: { status: ReviewSellerResponseStatus.DELETED },
    });
    await tx.productReview.update({
      where: { id: reviewId },
      data: { sellerResponseExists: false },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPFUL VOTES
// ──────────────────────────────────────────────────────────────────────────────

export async function voteHelpful(reviewId: string, userId: string, vote: 'HELPFUL' | 'NOT_HELPFUL') {
  const review = await prisma.productReview.findUnique({ where: { id: reviewId, status: ReviewStatus.PUBLISHED } });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');

  await prisma.$transaction(async (tx) => {
    const existing = await tx.reviewHelpfulVote.findUnique({
      where: { reviewId_userId: { reviewId, userId } },
    });

    if (existing) {
      await tx.reviewHelpfulVote.update({
        where: { reviewId_userId: { reviewId, userId } },
        data: { vote: vote as ReviewHelpfulVoteType },
      });
    } else {
      await tx.reviewHelpfulVote.create({
        data: { reviewId, userId, vote: vote as ReviewHelpfulVoteType },
      });
    }

    // Recount helpful votes
    const helpfulCount = await tx.reviewHelpfulVote.count({
      where: { reviewId, vote: ReviewHelpfulVoteType.HELPFUL },
    });

    await tx.productReview.update({
      where: { id: reviewId },
      data: { helpfulCount },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// REVIEW REPORTS
// ──────────────────────────────────────────────────────────────────────────────

export async function reportReview(
  reviewId: string,
  reporterId: string,
  reason: string,
  description?: string
) {
  const review = await prisma.productReview.findUnique({
    where: { id: reviewId },
  });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');
  if (review.userId === reporterId) throw new AppError('لا يمكنك الإبلاغ عن تقييمك الشخصي', 400);

  const validReasons = [
    'SPAM',
    'OFFENSIVE',
    'FAKE_REVIEW',
    'IRRELEVANT',
    'PERSONAL_INFORMATION',
    'HARASSMENT',
    'FRAUD',
    'OTHER',
  ];
  const formattedReason = reason?.toUpperCase() as any;
  if (!validReasons.includes(formattedReason)) {
    throw new AppError('سبب الإبلاغ غير صالح', 400);
  }

  const existing = await prisma.reviewReport.findUnique({
    where: { reviewId_reporterId: { reviewId, reporterId } },
  });
  if (existing) throw new AppError('لقد أبلغت عن هذا التقييم سابقاً', 409, 'REPORT_ALREADY_EXISTS');

  await prisma.$transaction(async (tx) => {
    await tx.reviewReport.create({
      data: {
        reviewId,
        reporterId,
        reason: formattedReason,
        description: description?.trim() || null,
        status: 'PENDING',
      },
    });

    await tx.productReview.update({
      where: { id: reviewId },
      data: { reportCount: { increment: 1 } },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN MODERATION
// ──────────────────────────────────────────────────────────────────────────────

async function moderateReview(
  reviewId: string,
  adminUserId: string,
  newStatus: ReviewStatus,
  reason?: string
) {
  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');

  const wasPublished = review.status === ReviewStatus.PUBLISHED;
  const willBePublished = newStatus === ReviewStatus.PUBLISHED;

  await prisma.$transaction(async (tx) => {
    await tx.reviewModerationHistory.create({
      data: {
        reviewId,
        adminUserId,
        previousStatus: review.status,
        newStatus,
        reason: reason || null,
      },
    });

    await tx.productReview.update({
      where: { id: reviewId },
      data: {
        status: newStatus,
        publishedAt: willBePublished && !review.publishedAt ? new Date() : review.publishedAt,
        deletedAt: newStatus === ReviewStatus.DELETED ? new Date() : review.deletedAt,
      },
    });

    // Recompute aggregate if publication status changed
    if (wasPublished !== willBePublished) {
      await recomputeRatingSummary(tx, review.productId);
    }
  });
}

export const approveReview = (id: string, adminUserId: string, reason?: string) =>
  moderateReview(id, adminUserId, ReviewStatus.PUBLISHED, reason);

export const rejectReview = (id: string, adminUserId: string, reason?: string) =>
  moderateReview(id, adminUserId, ReviewStatus.REJECTED, reason);

export const hideReview = (id: string, adminUserId: string, reason?: string) =>
  moderateReview(id, adminUserId, ReviewStatus.HIDDEN, reason);

export const restoreReview = (id: string, adminUserId: string, reason?: string) =>
  moderateReview(id, adminUserId, ReviewStatus.PUBLISHED, reason);

export const adminDeleteReview = (id: string, adminUserId: string, reason?: string) =>
  moderateReview(id, adminUserId, ReviewStatus.DELETED, reason);

export async function moderateSellerResponse(
  responseId: string,
  adminUserId: string,
  newStatus: ReviewSellerResponseStatus,
  reason?: string
) {
  const resp = await prisma.reviewSellerResponse.findUnique({ where: { id: responseId } });
  if (!resp) throw new AppError('الرد غير موجود', 404);

  await prisma.$transaction(async (tx) => {
    await tx.reviewSellerResponse.update({
      where: { id: responseId },
      data: { status: newStatus },
    });

    await tx.reviewModerationHistory.create({
      data: {
        sellerResponseId: responseId,
        adminUserId,
        previousStatus: resp.status,
        newStatus,
        reason: reason || null,
      },
    });

    // If hidden/deleted, mark sellerResponseExists = false on review
    if (newStatus !== ReviewSellerResponseStatus.PUBLISHED) {
      await tx.productReview.update({
        where: { id: resp.reviewId },
        data: { sellerResponseExists: false },
      });
    } else {
      await tx.productReview.update({
        where: { id: resp.reviewId },
        data: { sellerResponseExists: true },
      });
    }
  });
}

export async function resolveReport(reportId: string, adminUserId: string, adminNote?: string) {
  const report = await prisma.reviewReport.findUnique({ where: { id: reportId } });
  if (!report) throw new AppError('البلاغ غير موجود', 404);

  await prisma.reviewReport.update({
    where: { id: reportId },
    data: { status: 'RESOLVED', resolvedBy: adminUserId, resolvedAt: new Date(), adminNote: adminNote || null },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ──────────────────────────────────────────────────────────────────────────────

export async function getAdminAnalytics() {
  const [
    totalReviews,
    publishedReviews,
    pendingReviews,
    rejectedReviews,
    hiddenReviews,
    reportedReviews,
    verifiedReviews,
    avgRatingAgg,
    dailySeries,
  ] = await Promise.all([
    prisma.productReview.count({ where: { status: { not: ReviewStatus.DELETED } } }),
    prisma.productReview.count({ where: { status: ReviewStatus.PUBLISHED } }),
    prisma.productReview.count({ where: { status: ReviewStatus.PENDING } }),
    prisma.productReview.count({ where: { status: ReviewStatus.REJECTED } }),
    prisma.productReview.count({ where: { status: ReviewStatus.HIDDEN } }),
    prisma.productReview.count({ where: { status: ReviewStatus.PUBLISHED, reportCount: { gt: 0 } } }),
    prisma.productReview.count({ where: { status: ReviewStatus.PUBLISHED, verifiedPurchase: true } }),
    prisma.productReview.aggregate({
      where: { status: ReviewStatus.PUBLISHED },
      _avg: { rating: true },
    }),
    prisma.$queryRaw<Array<{ date: string; count: number }>>`
      SELECT TO_CHAR("createdAt", 'YYYY-MM-DD') as date, CAST(COUNT(*) AS INTEGER) as count
      FROM "ProductReview"
      WHERE "createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY TO_CHAR("createdAt", 'YYYY-MM-DD')
      ORDER BY date ASC
    `,
  ]);

  const avgRating = avgRatingAgg._avg.rating ? parseFloat(avgRatingAgg._avg.rating.toFixed(2)) : 0;

  return {
    totalReviews,
    publishedReviews,
    pendingReviews,
    rejectedReviews,
    hiddenReviews,
    reportedReviews,
    verifiedReviews,
    verifiedPercentage: publishedReviews > 0 ? Math.round((verifiedReviews / publishedReviews) * 100) : 0,
    averageRating: avgRating,
    dailySeries: dailySeries.map((d) => ({ date: String(d.date), count: Number(d.count || 0) })),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// NOTIFICATION HELPERS (delegate to existing notification system)
// ──────────────────────────────────────────────────────────────────────────────

async function notifySellerNewReview(sellerId: string, productId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { userId: true },
  });
  if (!seller) return;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { nameAr: true, nameEn: true },
  });

  try {
    notificationEventBus.publish(
      NotificationEventFactory.reviewEvent({
        eventType: 'NEW_REVIEW_RECEIVED',
        recipientId: seller.userId,
        recipientType: AppType.SELLER,
        productId,
        productNameAr: product?.nameAr || 'منتجك',
        productNameEn: product?.nameEn || product?.nameAr || 'Your product',
      })
    );
  } catch (_) {}
}

async function notifyCustomerSellerResponded(customerId: string, reviewId: string, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { nameAr: true, nameEn: true },
  });

  try {
    notificationEventBus.publish(
      NotificationEventFactory.reviewEvent({
        eventType: 'SELLER_RESPONDED_TO_REVIEW',
        recipientId: customerId,
        recipientType: AppType.CUSTOMER,
        productId,
        productNameAr: product?.nameAr || 'المنتج',
        productNameEn: product?.nameEn || product?.nameAr || 'Product',
        reviewId,
      })
    );
  } catch (_) {}
}
