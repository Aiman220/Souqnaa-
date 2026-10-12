import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { config } from '../../config';
import { GuestService } from './guest.service';

const router = Router();

// Anti-abuse rate limiter for public guest APIs (§26)
const guestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: config.env === 'development' ? 5000 : 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'تم تجاوز معدل الطلبات المسموح به كزائر. يرجى الانتظار لحظات والمحاولة مجدداً.',
      429
    );
  },
});

router.use(guestLimiter);

/**
 * POST /api/v1/guest/session — Create or restore guest shopping session (§3, §27)
 */
router.post('/session', (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientSessionId = (
      (req.headers['x-guest-session-id'] as string) ||
      req.body.guestSessionId ||
      req.body.sessionId ||
      ''
    ).trim();

    const session = GuestService.createOrRestoreSession(clientSessionId);
    ResponseUtil.success(res, session, 'تم إنشاء / استعادة جلسة الزائر بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/guest/cart/validate — Validate local guest cart against DB (§7, §8, §27)
 */
router.post('/cart/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items = [], couponCode } = req.body;
    const result = await GuestService.validateCart({ items, couponCode });
    ResponseUtil.success(res, result, 'تم التحقق من سلة الزائر بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/guest/wishlist/validate — Validate local guest wishlist against DB (§11, §12)
 */
router.post('/wishlist/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items = [] } = req.body;
    const result = await GuestService.validateWishlist(items);
    ResponseUtil.success(res, result, 'تم التحقق من قائمة أمنيات الزائر بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/guest/checkout/prepare — Prepare guest checkout draft with live delivery calculation (§14-§20)
 */
router.post('/checkout/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      guestSessionId = '',
      items = [],
      contact,
      address,
      deliveryMethodCode,
      isExpress,
      deliveryScheduleType,
      deliveryDate,
      deliveryTimeSlotId,
      couponCode,
      paymentMethod,
    } = req.body;

    if (!items || items.length === 0) {
      throw new AppError('سلة المشتريات فارغة', 400);
    }
    if (!contact || !contact.fullName || !contact.phoneNumber) {
      throw new AppError('يرجى تقديم بيانات الاتصال الأساسية (الاسم الكامل ورقم الهاتف)', 400);
    }
    if (!address || !address.city || !address.street) {
      throw new AppError('يرجى تقديم تفاصيل عنوان التوصيل (المدينة والشارع)', 400);
    }

    const result = await GuestService.prepareCheckout({
      guestSessionId,
      items,
      contact,
      address,
      deliveryMethodCode,
      isExpress,
      deliveryScheduleType,
      deliveryDate,
      deliveryTimeSlotId,
      couponCode,
      paymentMethod,
    });

    ResponseUtil.success(res, result, 'تم تجهيز مسودة الدفع للزائر بنجاح');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/guest/merge — Merge guest session data into authenticated account (§21, §22, §23, §24)
 * Requires customer JWT token.
 */
router.post('/merge', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { guestSessionId, cartItems = [], wishlistItems = [] } = req.body;

    if (!guestSessionId) {
      throw new AppError('معرف جلسة الزائر مطلوب لإتمام الدمج', 400);
    }

    const result = await GuestService.mergeSession(req.user!.userId, {
      guestSessionId,
      cartItems,
      wishlistItems,
    });

    ResponseUtil.success(res, result, 'تم دمج بيانات سلة ومفضلة الزائر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const guestRoutes = router;
