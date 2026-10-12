import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../../database/prisma';
import { authenticate, optionalAuth } from '../../../middleware/auth.middleware';
import { ResponseUtil } from '../../../utils/response.util';
import { AppError } from '../../../middleware/error.middleware';
import { VoucherService } from '../voucher.service';
import { VoucherClaimService } from '../services/voucher-claim.service';
import { VoucherCalculationService } from '../services/voucher-calculation.service';
import { VoucherRecommendationService } from '../services/voucher-recommendation.service';
import { CartEvaluationItem } from '../voucher.types';

const router = Router();

// ==============================================================================
// 1. PUBLIC & DISCOVERY
// ==============================================================================

// GET /api/v1/vouchers — Voucher Center discovery
router.get('/', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as string | undefined;
    const customerId = (req as any).user?.userId;
    const vouchers = await VoucherService.getVoucherCenterVouchers({
      customerId,
      category,
    });
    ResponseUtil.success(res, vouchers);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/vouchers/available — Available vouchers to claim
router.get('/available', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = (req as any).user?.userId;
    const vouchers = await VoucherService.getVoucherCenterVouchers({
      customerId,
    });
    const available = vouchers.filter((v) => !v.isClaimed && !v.isDepleted);
    ResponseUtil.success(res, available);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/vouchers/product/:productId — Vouchers for a product
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.productId);
    const sellerId = req.query.sellerId as string | undefined;
    const customerId = (req as any).user?.userId;
    const vouchers = await VoucherService.getProductVouchers(productId, sellerId, customerId);
    ResponseUtil.success(res, vouchers);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/vouchers/store/:sellerId — Vouchers for a store
router.get('/store/:sellerId', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = String(req.params.sellerId);
    const customerId = (req as any).user?.userId;
    const vouchers = await VoucherService.getStoreVouchers(sellerId, customerId);
    ResponseUtil.success(res, vouchers);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 2. AUTHENTICATED CUSTOMER ENDPOINTS
// ==============================================================================

// GET /api/v1/vouchers/my — My collected vouchers (MUST be before /:id)
router.get('/my', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tab = req.query.tab as string | undefined;
    const myVouchers = await VoucherClaimService.getCustomerVouchers(req.user!.userId, tab);
    ResponseUtil.success(res, myVouchers);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/vouchers/:id — Voucher details
router.get('/:id', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const voucher = await prisma.voucher.findUnique({
      where: { id: String(req.params.id) },
      include: {
        seller: { include: { stores: true } },
        products: { include: { product: true } },
        categories: { include: { category: true } },
      },
    });
    if (!voucher) throw new AppError('القسيمة غير موجودة', 404);
    ResponseUtil.success(res, voucher);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vouchers/:id/claim — Collect a voucher
router.post('/:id/claim', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { claimSource } = req.body;
    const claimed = await VoucherClaimService.claimVoucher({
      voucherId: String(req.params.id),
      customerId: req.user!.userId,
      claimSource,
    });
    ResponseUtil.success(res, claimed, 'تم استلام القسيمة بنجاح وإضافتها إلى قسائمك');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vouchers/validate — Validate a voucher code
router.post('/validate', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, items } = req.body;
    if (!code) throw new AppError('رمز القسيمة مطلوب', 400);

    const customerId = (req as any).user?.userId;
    const voucher = await VoucherService.validateCode(code, customerId, items);
    ResponseUtil.success(res, voucher, 'القسيمة صالحة للاستخدام');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vouchers/calculate — Calculate discounts for cart
router.post('/calculate', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { voucherCodes = [], shippingFee = 0, items = [], currency = 'SAR' } = req.body;
    const customerId = (req as any).user?.userId;

    // Resolve vouchers from codes
    const vouchers = await prisma.voucher.findMany({
      where: {
        code: { in: voucherCodes.map((c: string) => c.trim()) },
      },
      include: {
        products: true,
        categories: true,
      },
    });

    const result = await VoucherCalculationService.calculateCartDiscounts({
      customerId,
      items,
      shippingFee,
      vouchers,
      currency,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vouchers/recommend-best — Automatic best voucher engine
router.post('/recommend-best', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items = [], shippingFee = 0, currency = 'SAR' } = req.body;
    const customerId = (req as any).user?.userId;

    const result = await VoucherRecommendationService.recommendBestVouchers({
      customerId,
      items,
      shippingFee,
      currency,
    });

    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vouchers/apply — Apply voucher to user's cart
router.post('/apply', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code) throw new AppError('رمز القسيمة مطلوب', 400);

    const voucher = await VoucherService.validateCode(code, req.user!.userId);

    const cart = await prisma.cart.findUnique({
      where: { userId: req.user!.userId },
    });
    if (!cart) throw new AppError('السلة غير موجودة', 404);

    // Add code to appliedVouchers list
    const existing = cart.appliedVouchers ? cart.appliedVouchers.split(',').map((c) => c.trim()) : [];
    if (!existing.includes(voucher.code)) {
      existing.push(voucher.code);
    }

    await prisma.cart.update({
      where: { id: cart.id },
      data: {
        couponCode: voucher.code,
        appliedVouchers: existing.join(','),
      },
    });

    ResponseUtil.success(res, { appliedVouchers: existing }, 'تم تطبيق القسيمة على السلة');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/vouchers/remove — Remove voucher from cart
router.delete('/remove', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    const cart = await prisma.cart.findUnique({
      where: { userId: req.user!.userId },
    });
    if (!cart) throw new AppError('السلة غير موجودة', 404);

    let updatedList: string[] = [];
    if (cart.appliedVouchers) {
      const existing = cart.appliedVouchers.split(',').map((c) => c.trim());
      updatedList = code ? existing.filter((c) => c !== code.trim()) : [];
    }

    await prisma.cart.update({
      where: { id: cart.id },
      data: {
        couponCode: updatedList.length > 0 ? updatedList[0] : null,
        appliedVouchers: updatedList.length > 0 ? updatedList.join(',') : null,
      },
    });

    ResponseUtil.success(res, { appliedVouchers: updatedList }, 'تمت إزالة القسيمة من السلة');
  } catch (error) {
    next(error);
  }
});

export const customerVoucherRoutes = router;
