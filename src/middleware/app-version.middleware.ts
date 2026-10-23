import { Request, Response, NextFunction } from 'express';
import { AppTypeEnum, AppPlatformEnum } from '@prisma/client';
import { config } from '../config';
import { appLifecycleService } from '../modules/app-lifecycle/app-lifecycle.service';
import { parseAppVersion, isVersionSupported } from '../utils/version-comparator.util';

export type EnforcementMode = 'enforcing' | 'observe_only' | 'disabled';

export interface AppVersionGateOptions {
  enforcementMode?: EnforcementMode;
  allowLegacyWithoutVersion?: boolean;
}

/**
 * List of paths explicitly exempt from version enforcement.
 * Includes health/readiness probes, app lifecycle/update endpoints,
 * remote config, maintenance inspection, static uploads, and auth bootstrap.
 */
const EXEMPT_PREFIXES = [
  '/health',
  '/ready',
  '/uploads',
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/storage',
  '/api/v1/app',
  '/api/v1/config/remote',
  '/api/v1/remote-config',
  '/config/remote',
  '/remote-config',
  '/api/v1/config/maintenance',
  '/api/v1/integrity',
  // Auth bootstrap endpoints must remain reachable so users can authenticate / refresh tokens
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/social',
];

/**
 * Safe public browsing routes exempt for GET operations only.
 */
const PUBLIC_BROWSING_PREFIXES = [
  '/api/v1/products',
  '/api/v1/categories',
  '/api/v1/stores',
  '/api/v1/home',
  '/api/v1/search',
  '/api/v1/banners',
  '/api/v1/campaigns',
  '/api/v1/flash-sales',
];

/**
 * Normalizes app type from header, request path, and authenticated user role.
 * Security rule: Authenticated roles (e.g. SELLER or ADMIN) and dedicated route prefixes
 * override client-supplied headers to prevent clients from claiming a weaker policy.
 */
export function resolveAppType(req: Request): AppTypeEnum {
  const path = req.path.toLowerCase();
  const user = (req as any).user;

  // 1. Role-based override (authoritative)
  if (user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN') {
    return AppTypeEnum.ADMIN;
  }
  if (user?.role === 'SELLER') {
    return AppTypeEnum.SELLER;
  }

  // 2. Path-based override
  if (path.startsWith('/api/v1/admin') || path.startsWith('/admin')) {
    return AppTypeEnum.ADMIN;
  }
  if (path.startsWith('/api/v1/seller') || path.startsWith('/seller')) {
    return AppTypeEnum.SELLER;
  }

  // 3. Header-based declaration
  const headerType = (req.headers['x-app-type'] as string | undefined)?.toLowerCase().trim();
  if (headerType === 'seller') return AppTypeEnum.SELLER;
  if (headerType === 'admin') return AppTypeEnum.ADMIN;

  return AppTypeEnum.CUSTOMER;
}

/**
 * Normalizes platform from header or User-Agent.
 */
export function resolvePlatform(req: Request): AppPlatformEnum {
  const headerPlatform = (req.headers['x-app-platform'] as string | undefined)?.toLowerCase().trim();
  if (headerPlatform === 'ios') return AppPlatformEnum.IOS;
  if (headerPlatform === 'windows') return AppPlatformEnum.WINDOWS;
  if (headerPlatform === 'web') return AppPlatformEnum.WEB;
  if (headerPlatform === 'android') return AppPlatformEnum.ANDROID;

  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ios')) {
    return AppPlatformEnum.IOS;
  }
  if (userAgent.includes('windows')) {
    return AppPlatformEnum.WINDOWS;
  }
  if (userAgent.includes('mozilla') || userAgent.includes('chrome') || userAgent.includes('safari')) {
    return AppPlatformEnum.WEB;
  }

  return AppPlatformEnum.ANDROID;
}

/**
 * Determines whether a given request is exempt from minimum app-version enforcement.
 */
export function isExemptRoute(req: Request): boolean {
  const path = req.path.toLowerCase();

  // Root or exact health/ready
  if (path === '/' || path === '/health' || path === '/ready') {
    return true;
  }

  // Exempt prefixes
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  // Public catalog browsing (GET only)
  if (req.method === 'GET' && PUBLIC_BROWSING_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  return false;
}

/**
 * Production-grade Backend Minimum App-Version Enforcement Middleware.
 * Enforces server-side version policy with support for:
 * - Strict enforcement (HTTP 426 Upgrade Required)
 * - Controlled observe-only mode for audit & metrics
 * - Backward-compatible migration period for unversioned legacy clients
 * - Role-governed app-type isolation
 */
export const createAppVersionGate = (options: AppVersionGateOptions = {}) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const enforcementMode = options.enforcementMode ?? config.appVersion?.enforcementMode ?? 'enforcing';
    const allowLegacy = options.allowLegacyWithoutVersion ?? config.appVersion?.allowLegacyWithoutVersion ?? true;

    if (enforcementMode === 'disabled') {
      return next();
    }

    if (isExemptRoute(req)) {
      return next();
    }

    const appType = resolveAppType(req);
    const platform = resolvePlatform(req);

    const rawVersion = req.headers['x-app-version'] as string | undefined;
    const rawBuild = req.headers['x-app-build'] as string | undefined;

    // Handle missing version header
    if (!rawVersion || rawVersion.trim().length === 0) {
      if (allowLegacy) {
        // Safe migration window: allow request, attach diagnostic header for telemetry
        res.setHeader('X-App-Version-Status', 'legacy-unversioned');
        return next();
      }

      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_APP_VERSION',
          message: 'X-App-Version header is required for this endpoint.',
          messageAr: 'رأس إصدار التطبيق (X-App-Version) مطلوب لإتمام هذا الطلب.',
        },
      });
      return;
    }

    // Parse and validate version string
    const parsed = parseAppVersion(rawVersion);
    if (!parsed) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_APP_VERSION',
          message: 'Malformed or invalid X-App-Version header value.',
          messageAr: 'قيمة رأس إصدار التطبيق غير صحيحة.',
        },
      });
      return;
    }

    const clientBuild = rawBuild ? parseInt(rawBuild, 10) : parsed.build;

    try {
      const policy = await appLifecycleService.getActiveVersionPolicy(appType, platform);

      // If force update is disabled in policy, allow request
      if (!policy.forceUpdateEnabled) {
        res.setHeader('X-App-Version-Status', 'optional-update');
        return next();
      }

      const supported = isVersionSupported(
        rawVersion,
        policy.minimumSupportedVersion,
        Number.isNaN(clientBuild) ? undefined : clientBuild,
        policy.minimumSupportedBuild
      );

      if (!supported) {
        if (enforcementMode === 'observe_only') {
          // Observe-only telemetry mode: record status without blocking
          res.setHeader('X-App-Version-Status', 'upgrade-required');
          return next();
        }

        // Enforcing mode: reject with HTTP 426 Upgrade Required
        res.setHeader('Upgrade', 'SOUQNA-App');
        res.setHeader('X-App-Version-Status', 'upgrade-required');

        res.status(426).json({
          success: false,
          error: {
            code: 'UPGRADE_REQUIRED',
            message: 'Your app version is no longer supported. Please update to continue.',
            messageAr: 'إصدار التطبيق المستخدم لديك لم يعد مدعوماً. يرجى التحديث إلى أحدث إصدار للمتابعة.',
            minimumSupportedVersion: policy.minimumSupportedVersion,
            minimumSupportedBuild: policy.minimumSupportedBuild,
            latestVersion: policy.latestVersion,
            latestBuild: policy.latestBuild,
            forceUpdate: true,
            storeUrl: policy.storeUrl,
            configUrl: `${config.apiPrefix}/app/config`,
          },
        });
        return;
      }

      res.setHeader('X-App-Version-Status', 'supported');
      next();
    } catch {
      // In case of transient internal error retrieving policy, fail open safely
      res.setHeader('X-App-Version-Status', 'policy-unavailable');
      next();
    }
  };
};

export const appVersionGate = createAppVersionGate();
