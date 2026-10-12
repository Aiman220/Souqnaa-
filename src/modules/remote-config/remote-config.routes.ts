import multer from 'multer';
import { Router, Request, Response, NextFunction } from 'express';
import { remoteConfigService } from './remote-config.service';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { storageService } from '../../services/storage/storage.service';

const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('الملف المرفوع يجب أن يكون صورة صالحة (PNG, JPG, SVG, WebP, ICO)', 400));
    }
  },
});

export const remoteConfigPublicRoutes = Router();
export const remoteConfigAdminRoutes = Router();

// ==========================================
// PUBLIC CLIENT REMOTE CONFIG ENDPOINTS
// ==========================================

/**
 * GET /api/v1/config/remote
 * Fetches the resolved configuration for customer, seller, or admin apps.
 * Supports ETag / If-None-Match conditional request and client version comparison.
 */
remoteConfigPublicRoutes.get(
  '/',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const platform = (req.query.platform as string) || (req.headers['x-platform'] as string);
      const deviceId = (req.query.device_id as string) || (req.headers['x-device-id'] as string);
      const clientVersionStr = req.query.version as string;
      const clientVersion = clientVersionStr ? parseInt(clientVersionStr, 10) : undefined;
      const ifNoneMatchHeader = req.headers['if-none-match'];
      const ifNoneMatch = typeof ifNoneMatchHeader === 'string' ? ifNoneMatchHeader : undefined;

      const resolved = await remoteConfigService.getResolvedConfig({
        platform,
        deviceId,
        userId: req.user?.userId,
        userRole: req.user?.role,
        ifNoneMatch,
        clientVersion,
      });

      if (!resolved.modified) {
        res.status(304).end();
        return;
      }

      res.setHeader('ETag', resolved.etag);
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');

      ResponseUtil.success(res, resolved, 'تم استرجاع إعدادات المنصة بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

// Alias: /api/v1/remote-config (direct path)
remoteConfigPublicRoutes.get(
  '/sync',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const platform = (req.query.platform as string) || (req.headers['x-platform'] as string);
      const deviceId = (req.query.device_id as string) || (req.headers['x-device-id'] as string);
      const ifNoneMatch = req.headers['if-none-match'];

      const resolved = await remoteConfigService.getResolvedConfig({
        platform,
        deviceId,
        userId: req.user?.userId,
        ifNoneMatch,
      });

      if (!resolved.modified) {
        res.status(304).end();
        return;
      }

      res.setHeader('ETag', resolved.etag);
      ResponseUtil.success(res, resolved);
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN FEATURE FLAGS & CONFIG ENDPOINTS
// ==========================================

remoteConfigAdminRoutes.use(authenticate, requireAdmin);

/**
 * GET /api/v1/admin/feature-flags
 * Lists all feature flags for the Admin Dashboard.
 */
remoteConfigAdminRoutes.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const flags = await remoteConfigService.getAllFlagsForAdmin();
      ResponseUtil.success(res, flags, 'تم استرجاع قائمة ميزات النظام.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/audit-logs
 * Retrieves global audit log records.
 */
remoteConfigAdminRoutes.get(
  '/audit-logs',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const featureKey = req.query.key as string;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const { logs, total } = await remoteConfigService.getAuditLogs(featureKey, limit, offset);
      ResponseUtil.paginated(res, logs, total, Math.floor(offset / limit) + 1, limit);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/admin/feature-flags/wallet-providers/:providerCode
 * Enables or disables an individual Yemeni electronic wallet provider.
 */
remoteConfigAdminRoutes.put(
  '/wallet-providers/:providerCode',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerCode = String(req.params.providerCode);
      const { enabled, reason } = req.body;
      if (typeof enabled !== 'boolean') {
        throw new AppError('قيمة enabled مطلوبة (true/false)', 400);
      }

      const updated = await remoteConfigService.updateWalletProvider(
        providerCode,
        enabled,
        reason,
        { id: req.user!.userId, email: req.user!.email },
        req
      );

      ResponseUtil.success(
        res,
        updated,
        `تم ${enabled ? 'تفعيل' : 'تعطيل'} مزود المحفظة بنجاح.`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/reset-defaults
 * Resets all feature flags to factory default safe values.
 */
remoteConfigAdminRoutes.post(
  '/reset-defaults',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await remoteConfigService.resetToDefaults(
        { id: req.user!.userId, email: req.user!.email },
        req
      );
      ResponseUtil.success(res, null, 'تمت إعادة ضبط الميزات إلى القيم الآمنة الافتراضية بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/branding
 * Retrieves application branding, platform icons, and deep-link click actions.
 */
remoteConfigAdminRoutes.get(
  '/branding',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const branding = await remoteConfigService.getBrandingConfig();
      ResponseUtil.success(res, branding, 'تم استرجاع إعدادات الهوية وأيقونات التطبيقات بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/admin/feature-flags/branding
 * Updates application branding, platform icons (Android, iPhone, Tablet, Desktop, Web) and deep-linking.
 */
remoteConfigAdminRoutes.put(
  '/branding',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const updates = req.body;
      const updated = await remoteConfigService.updateBrandingConfig(
        updates,
        { id: req.user!.userId, email: req.user!.email },
        req
      );
      ResponseUtil.success(res, updated, 'تم حفظ إعدادات الهوية وأيقونات التطبيقات بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/branding/upload-icon
 * Uploads an app icon or splash logo image file and returns its public URL.
 */
remoteConfigAdminRoutes.post(
  '/branding/upload-icon',
  iconUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        throw new AppError('يرجى اختيار ملف صورة للأيقونة للرفع', 400);
      }
      const platform = (req.body.platform as string) || 'general';
      const result = await storageService.uploadFile(req.file, `branding/${platform}`);
      ResponseUtil.created(res, result, 'تم رفع أيقونة التطبيق بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/platform-wallets
 * Returns all configured platform wallet accounts for payments & deposits.
 */
remoteConfigAdminRoutes.get(
  '/platform-wallets',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const wallets = await remoteConfigService.getPlatformWalletAccounts(undefined, true);
      ResponseUtil.success(res, wallets, 'تم استرجاع حسابات محافظ المنصة بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/admin/feature-flags/platform-wallets/:providerCode
 * Configures platform wallet account number, phone number, holder name, instructions, etc.
 */
remoteConfigAdminRoutes.put(
  '/platform-wallets/:providerCode',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerCode = String(req.params.providerCode);
      const updates = req.body;
      const updated = await remoteConfigService.updatePlatformWalletAccount(
        providerCode,
        updates,
        { id: req.user!.userId, email: req.user!.email },
        req
      );
      ResponseUtil.success(res, updated, 'تم حفظ بيانات حساب المنصة للمحفظة بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/platform-wallets/reset
 * Resets platform wallet accounts to factory defaults.
 */
remoteConfigAdminRoutes.post(
  '/platform-wallets/reset',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await remoteConfigService.resetPlatformWalletAccounts(
        { id: req.user!.userId, email: req.user!.email },
        req
      );
      ResponseUtil.success(res, null, 'تمت إعادة ضبط حسابات محافظ المنصة إلى القيم الافتراضية بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/:key
 * Retrieves single feature flag with complete history.
 */
remoteConfigAdminRoutes.get(
  '/:key',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = String(req.params.key);
      const flag = await remoteConfigService.getFlagByKey(key);
      ResponseUtil.success(res, flag);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/:key/toggle
 * Fast toggle on/off with safety confirmation requirement for sensitive features.
 */
remoteConfigAdminRoutes.post(
  '/:key/toggle',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = String(req.params.key);
      const { enabled, reason, confirmed } = req.body;

      if (typeof enabled !== 'boolean') {
        throw new AppError('حالة الميزة (enabled) مطلوبة وقيمتها يجب أن تكون true أو false', 400);
      }

      const existing = await remoteConfigService.getFlagByKey(key);

      // Enforce confirmation check on sensitive features when turning OFF
      if (existing.isSensitive && enabled === false && confirmed !== true) {
        throw new AppError(
          `هذه الميزة [${existing.displayNameAr}] مصنفة كـ حساسة للغاية (High Impact). يجب تأكيد التعطيل صراحة مع إرفاق سبب الإجراء.`,
          400,
          'CONFIRMATION_REQUIRED'
        );
      }

      const updated = await remoteConfigService.toggleFlag(
        key,
        enabled,
        reason || (enabled ? 'تفعيل فوري' : 'تعطيل فوري من لوحة الإدارة'),
        { id: req.user!.userId, email: req.user!.email },
        req
      );

      ResponseUtil.success(
        res,
        updated,
        `تم ${enabled ? 'تفعيل' : 'تعطيل'} ميزة [${existing.displayNameAr}] بنجاح.`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/admin/feature-flags/:key
 * Updates full configuration of a feature flag (rollout, schedule, platforms, dependencies).
 */
remoteConfigAdminRoutes.put(
  '/:key',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = String(req.params.key);
      const {
        enabled,
        displayNameAr,
        displayNameEn,
        descriptionAr,
        descriptionEn,
        maintenanceMessageAr,
        maintenanceMessageEn,
        rolloutPercentage,
        startDate,
        endDate,
        platforms,
        dependencies,
        metadata,
        reason,
      } = req.body;

      const updated = await remoteConfigService.updateFlag(
        key,
        {
          enabled,
          displayNameAr,
          displayNameEn,
          descriptionAr,
          descriptionEn,
          maintenanceMessageAr,
          maintenanceMessageEn,
          rolloutPercentage,
          startDate,
          endDate,
          platforms,
          dependencies,
          metadata,
          reason,
        },
        { id: req.user!.userId, email: req.user!.email },
        req
      );

      ResponseUtil.success(res, updated, 'تم حفظ إعدادات الميزة بنجاح.');
    } catch (error) {
      next(error);
    }
  }
);

