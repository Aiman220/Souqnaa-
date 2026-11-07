import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { PaymentStatus } from '@prisma/client';
import { requireFeature } from '../remote-config/remote-config.middleware';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { financialLimiter, checkoutLimiter } from '../../middleware/rate-limiter.middleware';
import { UrlSecurityUtil } from '../../utils/url-security.util';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { requireProviderVerifiedPayment } from './payment-confirmation.util';

const router = Router();

// POST /api/v1/payments/:orderId/intent
router.post(
  '/:orderId/intent',
  authenticate,
  financialLimiter,
  requireFeature('online_payment', 'عمليات الدفع الإلكتروني معطلة حالياً لأسباب الصيانة التشغيلية.'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = String(req.params.orderId);
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      });

      if (!order) throw new AppError('Order not found', 404);

      if (order.userId !== req.user!.userId && req.user!.role !== 'ADMIN') {
        throw new AppError('Forbidden: Access denied to other customer orders', 403, 'FORBIDDEN');
      }

      ResponseUtil.success(res, {
        clientSecret: `pi_mock_${order.id}_secret_${Date.now()}`,
        amount: order.total,
        currency: order.currency,
        paymentMethod: order.payment?.method || 'CASH_ON_DELIVERY',
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/payments/:orderId/confirm
router.post(
  '/:orderId/confirm',
  authenticate,
  financialLimiter,
  requireFeature('online_payment', 'عمليات الدفع الإلكتروني معطلة حالياً لأسباب الصيانة التشغيلية.'),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireProviderVerifiedPayment();
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/payments/merchant-wallets
// Returns official store/marketplace accounts for Yemeni digital wallet providers (dynamically configured by admin)
router.get('/merchant-wallets', checkoutLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isWalletsActive = await remoteConfigService.isFeatureActive('electronic_wallet_providers');
    if (!isWalletsActive) {
      return ResponseUtil.success(res, [], 'خدمة الدفع بالمحافظ الإلكترونية معطلة حالياً');
    }

    const merchantWallets = await remoteConfigService.getPlatformWalletAccounts('CHECKOUT');
    return ResponseUtil.success(res, merchantWallets, 'تم جلب حسابات المحافظ الرقمية للمتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/payments/platform-wallets
// Returns active platform wallet accounts for customers & sellers depositing or paying
router.get('/platform-wallets', checkoutLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = req.query.channel as string | undefined;
    const wallets = await remoteConfigService.getPlatformWalletAccounts(channel);
    return ResponseUtil.success(res, wallets, 'تم جلب حسابات محافظ المنصة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/payments/:orderId/wallet-transfer
// Customer submits/attaches wallet proof and reference for their order
router.post(
  '/:orderId/wallet-transfer',
  authenticate,
  idempotencyMiddleware,
  financialLimiter,
  requireFeature('electronic_wallet_providers', 'الدفع عبر المحافظ الإلكترونية معطل حالياً.'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = String(req.params.orderId);
      const {
        walletProvider,
        walletSenderNumber,
        walletTransactionRef,
        walletReceiptUrl,
      } = req.body;

      if (!walletProvider) throw new AppError('يرجى تحديد مزود المحفظة الرقمية', 400);
      if (!walletTransactionRef) throw new AppError('يرجى إدخال رقم العملية أو المرجع البنكي للتحويل', 400);

      const cleanRef = String(walletTransactionRef).trim();
      if (cleanRef.length < 3) {
        throw new AppError('يرجى إدخال رقم مرجع تحويل صالح', 400);
      }

      // Replay protection: verify reference is not reused across different orders
      const existingRef = await prisma.payment.findFirst({
        where: {
          walletTransactionRef: cleanRef,
          orderId: { not: orderId },
        },
        select: { id: true },
      });
      if (existingRef) {
        throw new AppError(
          'رقم العملية أو المرجع البنكي تم استخدامه مسبقاً لطلب آخر. يرجى التأكد من بيانات التحويل.',
          409,
          'DUPLICATE_TRANSACTION_REFERENCE'
        );
      }

      if (walletReceiptUrl && typeof walletReceiptUrl === 'string') {
        if (!UrlSecurityUtil.isSafeUrl(walletReceiptUrl.trim())) {
          throw new AppError('رابط إشعار التحويل غير صالح أو غير مسموح به لأسباب أمنية', 400, 'INVALID_RECEIPT_URL');
        }
      }

      const isProviderActive = await remoteConfigService.isWalletProviderActive(walletProvider);
      if (!isProviderActive) {
        throw new AppError(`مزود المحفظة [${walletProvider}] معطل حالياً من قبل الإدارة`, 403, 'PROVIDER_DISABLED');
      }

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: req.user!.userId },
      include: { payment: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const updated = await prisma.$transaction(async (tx) => {
      let payment = order.payment;
      if (!payment) {
        payment = await tx.payment.create({
          data: {
            orderId: order.id,
            method: 'YEMENI_WALLET' as any,
            amount: order.total,
            status: PaymentStatus.PENDING,
            transactionId: walletTransactionRef,
            walletProvider,
            walletSenderNumber,
            walletTransactionRef,
            walletReceiptUrl,
          },
        });
      } else {
        payment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            method: 'YEMENI_WALLET' as any,
            transactionId: walletTransactionRef,
            walletProvider,
            walletSenderNumber,
            walletTransactionRef,
            walletReceiptUrl,
          },
        });
      }

      await tx.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          gateway: walletProvider,
          referenceId: walletTransactionRef,
          amount: order.total,
          status: PaymentStatus.PENDING,
          rawResponse: JSON.stringify({
            walletProvider,
            walletSenderNumber,
            walletTransactionRef,
            walletReceiptUrl,
            submittedAt: new Date(),
            userId: req.user!.userId,
          }),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: order.status,
          toStatus: order.status,
          changedBy: req.user!.userId,
          changedByRole: 'CUSTOMER',
          note: `تم إرفاق إشعار التحويل اليدوي عبر محفظة (${walletProvider}) - مرجع: ${walletTransactionRef}`,
        },
      });

      return payment;
    });

    ResponseUtil.success(res, updated, 'تم إرسال إشعار وبيانات التحويل للمراجعة والتأكيد بنجاح');
  } catch (error) {
    next(error);
  }
});

export const paymentRoutes = router;
