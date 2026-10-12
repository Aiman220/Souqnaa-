import { Request, Response, NextFunction } from 'express';

export type MaintenanceScope = 'GLOBAL' | 'CUSTOMER' | 'SELLER' | 'ADMIN' | 'SERVICE';

export interface MaintenanceConfig {
  enabled: boolean;
  scope: MaintenanceScope;
  message: {
    ar: string;
    en: string;
  };
  estimatedEndTime?: string;
  allowLogin: boolean;
  allowBrowsing: boolean;
}

// In-memory runtime maintenance state with safe defaults
let currentMaintenanceConfig: MaintenanceConfig = {
  enabled: process.env.MAINTENANCE_MODE === 'true',
  scope: (process.env.MAINTENANCE_SCOPE as MaintenanceScope) || 'GLOBAL',
  message: {
    ar: 'سوقناا تحت الصيانة المجدولة حالياً لتحسين تجربتكم. سنعود قريباً!',
    en: 'SOUQNAA is currently undergoing scheduled maintenance. We will be back soon!',
  },
  estimatedEndTime: process.env.MAINTENANCE_ESTIMATED_END,
  allowLogin: false,
  allowBrowsing: false,
};

export const getMaintenanceConfig = (): MaintenanceConfig => ({
  ...currentMaintenanceConfig,
});

export const setMaintenanceConfig = (config: Partial<MaintenanceConfig>): MaintenanceConfig => {
  currentMaintenanceConfig = {
    ...currentMaintenanceConfig,
    ...config,
    message: {
      ...currentMaintenanceConfig.message,
      ...(config.message || {}),
    },
  };
  return currentMaintenanceConfig;
};

/**
 * Maintenance Mode Interceptor / Middleware.
 * Rejects requests with HTTP 503 and MAINTENANCE_MODE code when active,
 * respecting scope and bypass for health, admin, and maintenance config endpoints.
 */
export const maintenanceMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!currentMaintenanceConfig.enabled) {
    return next();
  }

  const path = req.path.toLowerCase();

  // Always allow health checks and maintenance status inspection
  if (
    path === '/health' ||
    path.endsWith('/health') ||
    path.includes('/config/maintenance') ||
    path.includes('/maintenance')
  ) {
    return next();
  }

  // Check Scope
  const isCustomerRoute = path.includes('/cart') || path.includes('/orders') || path.includes('/checkout');
  const isSellerRoute = path.includes('/seller');
  const isAdminRoute = path.includes('/admin');

  let matchesScope = false;
  if (currentMaintenanceConfig.scope === 'GLOBAL') {
    matchesScope = true;
  } else if (currentMaintenanceConfig.scope === 'CUSTOMER' && isCustomerRoute) {
    matchesScope = true;
  } else if (currentMaintenanceConfig.scope === 'SELLER' && isSellerRoute) {
    matchesScope = true;
  } else if (currentMaintenanceConfig.scope === 'ADMIN' && isAdminRoute) {
    matchesScope = true;
  }

  if (matchesScope) {
    // If browsing is allowed and this is a safe GET request (not login or mutating checkout)
    if (
      currentMaintenanceConfig.allowBrowsing &&
      req.method === 'GET' &&
      !path.includes('/auth') &&
      !path.includes('/checkout')
    ) {
      return next();
    }

    res.status(503).json({
      success: false,
      error: {
        code: 'MAINTENANCE_MODE',
        message: currentMaintenanceConfig.message.en,
        localizedMessage: currentMaintenanceConfig.message,
        estimatedEndTime: currentMaintenanceConfig.estimatedEndTime,
        allowBrowsing: currentMaintenanceConfig.allowBrowsing,
        requestId: req.requestId || req.headers['x-request-id'] || 'system',
      },
    });
    return;
  }

  next();
};
