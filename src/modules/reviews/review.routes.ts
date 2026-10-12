import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
import { requireSeller } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { storageService } from '../../services/storage/storage.service';
import {
  checkEligibility,
  createReview,
  updateReview,
  deleteReview,
  listReviews,
  getRatingSummary,
  voteHelpful,
  reportReview,
  createSellerResponse,
  updateSellerResponse,
  deleteSellerResponse,
  REVIEW_PUBLIC_SELECT,
  getReviewPolicy,
} from './reviews.service';
import { ReviewStatus } from '@prisma/client';

const router = Router();

// ── Multer for review media uploads (images / short videos) ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('نوع الملف غير مدعوم. يُسمح بـ JPEG، PNG، WebP، MP4، MOV فقط', 400, 'INVALID_MEDIA') as any);
    }
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: PRODUCT RATING SUMMARY
// GET /api/v1/reviews/products/:productId/rating-summary
// ══════════════════════════════════════════════════════════════════════════════
router.get(['/products/:productId/rating-summary', '/product/:productId/rating-summary'], optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.productId);
    const summary = await getRatingSummary(productId);
    ResponseUtil.success(res, summary);
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: LIST PRODUCT REVIEWS (paginated, filtered)
// GET /api/v1/reviews/products/:productId
// ══════════════════════════════════════════════════════════════════════════════
router.get(['/products/:productId', '/product/:productId'], optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.productId);
    const rating = req.query.rating ? parseInt(req.query.rating as string, 10) : undefined;
    const verified = req.query.verified === 'true' ? true : req.query.verified === 'false' ? false : undefined;
    const withMedia = req.query.with_media === 'true';
    const mediaType = req.query.media_type as 'IMAGE' | 'VIDEO' | undefined;
    const sort = (req.query.sort as any) || 'NEWEST';
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 20;

    const result = await listReviews({
      productId,
      rating,
      verified,
      withMedia: withMedia || undefined,
      mediaType,
      sort,
      cursor,
      limit,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: ELIGIBILITY CHECK
// GET /api/v1/reviews/eligibility/:orderItemId
// ══════════════════════════════════════════════════════════════════════════════
router.get('/eligibility/:orderItemId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderItemId = String(req.params.orderItemId);
    const result = await checkEligibility(req.user!.userId, orderItemId);
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: MY REVIEWS
// GET /api/v1/reviews/me
// ══════════════════════════════════════════════════════════════════════════════
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sort = (req.query.sort as any) || 'NEWEST';
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const status = req.query.status as ReviewStatus | undefined;

    const result = await listReviews({
      userId: req.user!.userId,
      status: status ? [status] : [ReviewStatus.PENDING, ReviewStatus.PUBLISHED, ReviewStatus.REJECTED, ReviewStatus.HIDDEN],
      sort,
      cursor,
      limit,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: UPLOAD REVIEW MEDIA
// POST /api/v1/reviews/media/upload
// ══════════════════════════════════════════════════════════════════════════════
router.post('/media/upload', authenticate, upload.array('files', 6), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new AppError('لم يتم رفع أي ملف', 400);

    const results = await Promise.all(
      files.map(async (file) => {
        const isVideo = file.mimetype.startsWith('video/');
        const folder = isVideo ? 'review-videos' : 'review-images';
        const uploaded = await storageService.uploadFile(file, folder);
        return {
          storageKey: uploaded.key,
          url: uploaded.url,
          mediaType: isVideo ? 'VIDEO' : 'IMAGE',
          mimeType: uploaded.mimeType,
          fileSize: uploaded.size,
        };
      })
    );

    ResponseUtil.created(res, results, 'تم رفع الوسائط بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: CREATE REVIEW
// POST /api/v1/reviews
// ══════════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderItemId, rating, title, body, locale, mediaKeys } = req.body;
    if (!orderItemId) throw new AppError('orderItemId مطلوب', 400);
    if (rating === undefined || rating === null) throw new AppError('التقييم مطلوب', 400);

    const review = await createReview({
      userId: req.user!.userId,
      orderItemId: String(orderItemId),
      rating: parseInt(rating, 10),
      title,
      body,
      locale,
      mediaKeys,
    });

    ResponseUtil.created(res, review, 'تم إرسال تقييمك بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: GET REVIEW POLICY
// GET /api/v1/reviews/policy
// ══════════════════════════════════════════════════════════════════════════════
router.get('/policy', optionalAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await getReviewPolicy();
    ResponseUtil.success(res, {
      reviewsEnabled: policy.reviewsEnabled,
      allowReviewEdit: policy.allowReviewEdit,
      reviewEditWindowHours: policy.reviewEditWindowHours,
      allowReviewDelete: policy.allowReviewDelete,
      reviewDeleteWindowHours: policy.reviewDeleteWindowHours,
      maxReviewBodyLength: policy.maxReviewBodyLength,
      maxReviewTitleLength: policy.maxReviewTitleLength,
      maxImagesPerReview: policy.maxImagesPerReview,
      maxVideosPerReview: policy.maxVideosPerReview,
    });
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: GET SINGLE REVIEW
// GET /api/v1/reviews/:id
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const review = await prisma.productReview.findUnique({
      where: { id, status: ReviewStatus.PUBLISHED },
      select: REVIEW_PUBLIC_SELECT,
    });
    if (!review) throw new AppError('التقييم غير موجود', 404, 'REVIEW_NOT_FOUND');
    ResponseUtil.success(res, review);
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: UPDATE REVIEW
// PATCH /api/v1/reviews/:id
// ══════════════════════════════════════════════════════════════════════════════
router.patch('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { rating, title, body, mediaKeys } = req.body;
    const updated = await updateReview(id, req.user!.userId, { rating, title, body, mediaKeys });
    ResponseUtil.success(res, updated, 'تم تحديث التقييم بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: DELETE REVIEW
// DELETE /api/v1/reviews/:id
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await deleteReview(id, req.user!.userId);
    ResponseUtil.success(res, null, 'تم حذف التقييم بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: VOTE HELPFUL
// POST /api/v1/reviews/:id/helpful
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/helpful', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const vote = req.body.vote === 'NOT_HELPFUL' ? 'NOT_HELPFUL' : 'HELPFUL';
    await voteHelpful(id, req.user!.userId, vote);
    ResponseUtil.success(res, null, 'تم تسجيل تصويتك');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED: REPORT REVIEW
// POST /api/v1/reviews/:id/reports
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/reports', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, description } = req.body;
    if (!reason) throw new AppError('سبب الإبلاغ مطلوب', 400);
    await reportReview(id, req.user!.userId, reason, description);
    ResponseUtil.created(res, null, 'تم إرسال البلاغ بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLER: CREATE SELLER RESPONSE
// POST /api/v1/reviews/:id/seller-response
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/seller-response', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = String(req.params.id);
    const { body } = req.body;
    if (!body?.trim()) throw new AppError('نص الرد مطلوب', 400);

    const seller = await prisma.seller.findUnique({ where: { userId: req.user!.userId } });
    if (!seller) throw new AppError('لم يتم العثور على حساب البائع', 403);

    const response = await createSellerResponse(reviewId, seller.id, body);
    ResponseUtil.created(res, response, 'تم نشر ردك بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLER: UPDATE SELLER RESPONSE
// PATCH /api/v1/reviews/:id/seller-response
// ══════════════════════════════════════════════════════════════════════════════
router.patch('/:id/seller-response', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = String(req.params.id);
    const { body } = req.body;
    if (!body?.trim()) throw new AppError('نص الرد مطلوب', 400);

    const seller = await prisma.seller.findUnique({ where: { userId: req.user!.userId } });
    if (!seller) throw new AppError('لم يتم العثور على حساب البائع', 403);

    const response = await updateSellerResponse(reviewId, seller.id, body);
    ResponseUtil.success(res, response, 'تم تحديث الرد بنجاح');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLER: DELETE SELLER RESPONSE
// DELETE /api/v1/reviews/:id/seller-response
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id/seller-response', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = String(req.params.id);
    const seller = await prisma.seller.findUnique({ where: { userId: req.user!.userId } });
    if (!seller) throw new AppError('لم يتم العثور على حساب البائع', 403);
    await deleteSellerResponse(reviewId, seller.id);
    ResponseUtil.success(res, null, 'تم حذف الرد بنجاح');
  } catch (error) {
    next(error);
  }
});

export { router as reviewRoutes };
