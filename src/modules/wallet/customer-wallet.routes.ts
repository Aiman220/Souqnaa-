import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { CustomerWalletService } from './customer-wallet.service';
import { WalletProviderRegistry } from '../payments/adapters/wallet-provider.adapter';
import { SocketService } from '../../services/websocket/socket.service';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { financialLimiter } from '../../middleware/rate-limiter.middleware';

const router = Router();
router.use(authenticate);

// ── GET /api/v1/wallet, /account, /summary, /balance ─────────────────────────
router.get(['/', '/account', '/summary', '/balance'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const account = await CustomerWalletService.getAccountDetails(userId);
    ResponseUtil.success(res, account);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/transactions ───────────────────────────────────────────
router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const type = req.query.type as any;

    const result = await CustomerWalletService.getTransactions(userId, { page, limit, type });
    ResponseUtil.success(res, result);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/destinations (and /saved alias) ─────────────────────
router.get(['/destinations', '/saved'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const destinations = await prisma.customerSavedWallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, destinations);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/wallet/destinations (and /saved alias) ────────────────────
router.post(['/destinations', '/saved'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { provider, walletNumber, holderName } = req.body;

    if (!provider || !walletNumber) {
      throw new AppError('مزود المحفظة ورقم المحفظة مطلوبان', 400);
    }

    const adapter = WalletProviderRegistry.getAdapter(provider);
    const validation = adapter.validateWalletNumber(walletNumber);
    if (!validation.isValid) {
      throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
    }

    const normalized = validation.normalized || walletNumber.trim();
    const masked = adapter.maskWalletNumber(normalized);

    const saved = await prisma.customerSavedWallet.create({
      data: {
        userId,
        provider: adapter.code,
        walletNumberMasked: masked,
        walletNumberFull: normalized,   // Store unmasked for admin withdrawal processing
        holderName: holderName || null,
        isVerified: false,
      },
    });

    ResponseUtil.created(res, saved, 'تم حفظ بيانات المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── PUT /api/v1/wallet/destinations/:id ──────────────────────────────────────────
router.put('/destinations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    const { provider, walletNumber, holderName } = req.body;

    const existing = await prisma.customerSavedWallet.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError('المحفظة غير موجودة أو ليس لديك صلاحية تعديلها', 404);
    }

    const targetProvider = provider || existing.provider;
    let walletNumberFull = existing.walletNumberFull;
    let walletNumberMasked = existing.walletNumberMasked;

    if (walletNumber && walletNumber.trim() !== '') {
      const adapter = WalletProviderRegistry.getAdapter(targetProvider);
      const validation = adapter.validateWalletNumber(walletNumber);
      if (!validation.isValid) {
        throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
      }
      walletNumberFull = validation.normalized || walletNumber.trim();
      walletNumberMasked = adapter.maskWalletNumber(walletNumberFull || '');
    } else if (provider && provider !== existing.provider) {
      const adapter = WalletProviderRegistry.getAdapter(provider);
      if (walletNumberFull) {
        const validation = adapter.validateWalletNumber(walletNumberFull);
        if (!validation.isValid) {
          throw new AppError(`رقم المحفظة غير متوافق مع مزود الخدمة الجديد: ${validation.error}`, 400);
        }
        walletNumberMasked = adapter.maskWalletNumber(walletNumberFull);
      }
    }

    const updated = await prisma.customerSavedWallet.update({
      where: { id },
      data: {
        provider: targetProvider,
        walletNumberFull,
        walletNumberMasked,
        holderName: holderName !== undefined ? (holderName ? holderName.trim() : null) : existing.holderName,
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث بيانات المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── PATCH /api/v1/wallet/destinations/:id ────────────────────────────────────────
router.patch('/destinations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    const { provider, walletNumber, holderName } = req.body;

    const existing = await prisma.customerSavedWallet.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError('المحفظة غير موجودة أو ليس لديك صلاحية تعديلها', 404);
    }

    const targetProvider = provider || existing.provider;
    let walletNumberFull = existing.walletNumberFull;
    let walletNumberMasked = existing.walletNumberMasked;

    if (walletNumber && walletNumber.trim() !== '') {
      const adapter = WalletProviderRegistry.getAdapter(targetProvider);
      const validation = adapter.validateWalletNumber(walletNumber);
      if (!validation.isValid) {
        throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
      }
      walletNumberFull = validation.normalized || walletNumber.trim();
      walletNumberMasked = adapter.maskWalletNumber(walletNumberFull || '');
    }

    const updated = await prisma.customerSavedWallet.update({
      where: { id },
      data: {
        provider: targetProvider,
        walletNumberFull,
        walletNumberMasked,
        holderName: holderName !== undefined ? (holderName ? holderName.trim() : null) : existing.holderName,
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث بيانات المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── DELETE /api/v1/wallet/destinations/:id ───────────────────────────────────────
router.delete('/destinations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);

    const existing = await prisma.customerSavedWallet.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError('المحفظة غير موجودة أو تم حذفها مسبقاً', 404);
    }

    await prisma.customerSavedWallet.delete({
      where: { id },
    });

    ResponseUtil.success(res, null, 'تم حذف المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/providers ──────────────────────────────────────────────
router.get('/providers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = WalletProviderRegistry.listSupportedProviders();
    ResponseUtil.success(res, providers);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/wallet/withdraw ─────────────────────────────────────────────
router.post('/withdraw', financialLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { savedWalletId, amount } = req.body;
    if (!savedWalletId) throw new AppError('يرجى تحديد المحفظة الرقمية المراد السحب إليها', 400);
    if (!amount || isNaN(Number(amount))) throw new AppError('يرجى إدخال مبلغ صحيح', 400);
    const result = await CustomerWalletService.requestWithdrawal({
      userId, savedWalletId, amount: parseFloat(String(amount)),
    });

    SocketService.get()?.emitToUser(userId, 'customer:withdrawal_created', result);
    SocketService.get()?.emitToUser(userId, 'customer:wallet_updated', { withdrawalId: result.id });
    SocketService.get()?.emitGlobal('admin:customer_withdrawal_created', result);
    SocketService.get()?.emitGlobal('customer:withdrawal_updated', result);

    ResponseUtil.created(res, result, 'تم تقديم طلب السحب بنجاح وسيتم معالجته في أقرب وقت');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/withdrawals ───────────────────────────────────────────
router.get('/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const withdrawals = await CustomerWalletService.getMyWithdrawals(userId);
    ResponseUtil.success(res, withdrawals);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/deposit-instructions ──────────────────────────────────
router.get('/deposit-instructions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = WalletProviderRegistry.listSupportedProviders();
    const allProviders = [
      ...providers,
      {
        code: 'BANK_TRANSFER',
        nameAr: 'تحويل بنكي مباشر (حساب بنكي / IBAN)',
        nameEn: 'Direct Bank Transfer',
        merchantWalletNumber: 'YE1200010000000123456789',
        merchantAccountName: 'منصة سوقناا للتجارة الإلكترونية',
        capabilities: {
          supportsPayment: false,
          supportsVerification: false,
          supportsRefund: false,
          supportsWebhook: false,
          supportsPayout: true,
          supportsWalletTransfer: true,
          supportsManualDeposit: true,
        },
      },
    ];
    ResponseUtil.success(res, allProviders);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/wallet/deposits ─────────────────────────────────────────────
router.post('/deposits', financialLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { amount, walletProvider, transferReference, proofImageUrl, senderName, senderPhone } = req.body;

    const parsedAmount = parseFloat(String(amount));
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 500) {
      throw new AppError('الحد الأدنى لطلب الشحن هو 500 ريال يمني', 400);
    }
    if (!walletProvider || typeof walletProvider !== 'string') {
      throw new AppError('يرجى تحديد مزود المحفظة أو البنك المحول منه', 400);
    }
    if (!transferReference || typeof transferReference !== 'string' || !transferReference.trim()) {
      throw new AppError('رقم الحوالة أو مرجع العملية مطلوب', 400);
    }
    if (!proofImageUrl || typeof proofImageUrl !== 'string' || !proofImageUrl.trim()) {
      throw new AppError('صورة سند التحويل أو إشعار الإيداع مطلوبة', 400);
    }

    const deposit = await prisma.walletDeposit.create({
      data: {
        userType: 'CUSTOMER',
        userId,
        amount: parsedAmount,
        currency: 'YER',
        walletProvider: walletProvider.trim().toUpperCase(),
        transferReference: transferReference.trim(),
        proofImageUrl: proofImageUrl.trim(),
        senderName: senderName ? String(senderName).trim() : null,
        senderPhone: senderPhone ? String(senderPhone).trim() : null,
        status: 'PENDING',
      },
    });

    // Real-time broadcast
    SocketService.get()?.emitToUser(userId, 'customer:deposit_created', deposit);
    SocketService.get()?.emitGlobal('customer:deposit_created', deposit);
    SocketService.get()?.emitGlobal('deposit:created', deposit);
    SocketService.get()?.emitGlobal('admin:deposit_created', deposit);

    ResponseUtil.created(res, deposit, 'تم إرسال طلب شحن المحفظة بنجاح وهو الآن قيد مراجعة الإدارة');
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/deposits ──────────────────────────────────────────────
router.get('/deposits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const deposits = await prisma.walletDeposit.findMany({
      where: { userId, userType: 'CUSTOMER' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    ResponseUtil.success(res, deposits);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/wallet/platform-accounts ──────────────────────────────────────
// Returns dynamic platform wallet accounts for customers to deposit funds into
router.get('/platform-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await remoteConfigService.getPlatformWalletAccounts('CUSTOMER_DEPOSIT');
    ResponseUtil.success(res, accounts, 'تم استرجاع حسابات منصة سوقناا للإيداع بنجاح');
  } catch (error) {
    next(error);
  }
});

export const customerWalletRoutes = router;

