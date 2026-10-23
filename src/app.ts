import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'path';

import { config } from './config';
import { errorHandler } from './middleware/error.middleware';
import { globalLimiter } from './middleware/rate-limiter.middleware';
import { requestIdMiddleware } from './middleware/request-id.middleware';
import { maintenanceMiddleware, getMaintenanceConfig, setMaintenanceConfig } from './middleware/maintenance.middleware';
import { appVersionGate } from './middleware/app-version.middleware';
import { trafficProtectionService } from './services/traffic-protection.service';
import { authenticate } from './middleware/auth.middleware';
import { requireAdmin } from './middleware/rbac.middleware';
import { prisma } from './database/prisma';
import { redis } from './database/redis';

// Routes
import { authRoutes } from './modules/auth/auth.routes';
import { locationRoutes } from './modules/locations/location.routes';
import { addressRoutes } from './modules/addresses/address.routes';
import { categoryRoutes } from './modules/categories/category.routes';
import { productRoutes } from './modules/products/product.routes';
import { storeRoutes } from './modules/stores/store.routes';
import { sellerRoutes } from './modules/sellers/seller.routes';
import { cartRoutes } from './modules/cart/cart.routes';
import { deliveryRoutes } from './modules/delivery/delivery.routes';
import { orderRoutes } from './modules/orders/order.routes';
import { paymentRoutes } from './modules/payments/payment.routes';
import { promotionRoutes } from './modules/promotions/promotion.routes';
import { wishlistRoutes } from './modules/wishlist/wishlist.routes';
import { reviewRoutes } from './modules/reviews/review.routes';
import { notificationRoutes } from './modules/notifications/notification.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { uploadRoutes } from './modules/upload/upload.routes';
import { storageRoutes } from './modules/storage/storage.routes';
import { customerFlashSaleRoutes } from './modules/flash-sales/flash-sale.routes';
import { sellerFlashSaleRoutes } from './modules/flash-sales/seller-flash-sale.routes';
import { adminFlashSaleRoutes } from './modules/flash-sales/admin-flash-sale.routes';
import { customerVoucherRoutes } from './modules/vouchers/routes/voucher.routes';
import { sellerVoucherRoutes } from './modules/vouchers/routes/seller-voucher.routes';
import { adminVoucherRoutes } from './modules/vouchers/routes/admin-voucher.routes';

import { homeRoutes } from './modules/home/home.routes';
import { searchRoutes } from './modules/search/search.routes';
import { customerBannerRoutes } from './modules/promotions/routes/customer-banner.routes';
import { customerCampaignRoutes } from './modules/promotions/routes/customer-campaign.routes';
import { adminCampaignBannerRoutes } from './modules/promotions/routes/admin-campaign-banner.routes';
import { sellerMarketingRoutes } from './modules/promotions/routes/seller-promotion.routes';
import { adminSellerPromotionRoutes } from './modules/promotions/routes/admin-seller-promotion.routes';
import { followRoutes } from './modules/follows/follow.routes';
import { adminPromotionRoutes } from './modules/promotions/promotion.routes';
import { customerRefundRoutes } from './modules/refunds/routes/customer-refund.routes';
import { disputeRoutes } from './modules/disputes/dispute.routes';
import { sellerRefundRoutes } from './modules/refunds/routes/seller-refund.routes';
import { adminRefundRoutes } from './modules/refunds/routes/admin-refund.routes';
import { customerWalletRoutes } from './modules/wallet/customer-wallet.routes';
import { guestRoutes } from './modules/guest/guest.routes';
import { syncRoutes } from './modules/sync/sync.routes';
import { recommendationRoutes } from './modules/recommendations/routes/recommendation.routes';
import { adminRecommendationRoutes } from './modules/recommendations/routes/admin-recommendation.routes';
import { supportRoutes } from './modules/support/support.routes';
import { customerRewardsRoutes } from './modules/rewards/routes/customer-rewards.routes';
import { adminRewardsRoutes } from './modules/rewards/routes/admin-rewards.routes';
import { sellerRewardsRoutes } from './modules/rewards/routes/seller-rewards.routes';
import {
  remoteConfigPublicRoutes,
  remoteConfigAdminRoutes,
} from './modules/remote-config/remote-config.routes';
import taxRoutes, { taxAdminRoutes } from './modules/tax/tax.routes';
import { sellerStatementsRouter, adminStatementsRouter } from './modules/statements/statement.routes';
import { sellerAnalyticsRouter, adminAnalyticsRouter, analyticsRouter } from './modules/analytics/analytics.routes';
import { customerMembershipRoutes } from './modules/membership/customer-membership.routes';
import { adminMembershipRoutes } from './modules/membership/admin-membership.routes';
import {
  appLifecyclePublicRoutes,
  appLifecycleAdminRoutes,
} from './modules/app-lifecycle/app-lifecycle.routes';
import {
  customerActionCenterRoutes,
  adminActionCenterRoutes,
} from './modules/action-center/action-center.routes';
import { buyAgainRoutes } from './modules/buy-again/buy-again.routes';
import {
  publicSellerPerformanceRouter,
  sellerPerformanceRouter,
  adminSellerPerformanceRouter,
} from './modules/seller-performance/seller-performance.routes';
import integrityRoutes from './modules/integrity/integrity.routes';

export const createApp = (): Application => {
  const app = express();

  // Disable automatic ETag generation for API routes to prevent 304 empty responses in Flutter Web
  app.set('etag', false);
  app.set('trust proxy', 1);

  // Security & Middleware
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],  // unsafe-inline needed for admin SPA inline styles
          imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
          connectSrc: ["'self'", 'https://api.souqnaa.com', 'wss:'],
          fontSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'", 'https:'],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: config.cloudflare.hstsEnabled
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      noSniff: true,
      // xssFilter is deprecated and removed; CSP replaces it
    })
  );

  const allowedOriginsList = [
    // Production Subdomains
    'https://www.souqnaa.com',
    'https://souqnaa.com',
    'https://admin.souqnaa.com',
    'https://seller.souqnaa.com',
    // Development Subdomains
    'https://dev.souqnaa.com',
    'https://dev-api.souqnaa.com',
    'https://dev-admin.souqnaa.com',
    'https://dev-seller.souqnaa.com',
    // Staging Subdomains
    'https://staging.souqnaa.com',
    'https://staging-api.souqnaa.com',
    'https://staging-admin.souqnaa.com',
    'https://staging-seller.souqnaa.com',
    // Localhost & Emulators
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:8080',
    'http://10.0.2.2:4000',
    'http://127.0.0.1:4000',
    'http://127.0.0.1:3000',
    ...(config.corsOrigin !== '*' ? config.corsOrigin.split(',').map((o) => o.trim()) : []),
  ];

  const allowedHeadersList = [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Request-Id',
    'X-Correlation-ID',
    'X-Idempotency-Key',
    'Idempotency-Key',
    'Accept',
    'Origin',
    'Cache-Control',
    'Pragma',
    'Expires',
    'X-Platform',
    'X-Device-Id',
    'X-App-Version',
    'X-Client-Version',
    'X-Session-Id',
    'If-None-Match',
    'If-Match',
    'If-Modified-Since',
    'Accept-Language',
    'Range',
    // Lowercase variants for strict proxies/browsers
    'cache-control',
    'pragma',
    'x-platform',
    'x-device-id',
    'x-app-version',
    'x-client-version',
    'x-session-id',
    'x-request-id',
    'x-correlation-id',
    'x-idempotency-key',
    'idempotency-key',
    'if-none-match',
    'if-match',
    'if-modified-since',
  ];

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin || config.corsOrigin === '*' || config.env === 'development') {
        callback(null, true);
      } else if (
        allowedOriginsList.includes(origin) ||
        allowedOriginsList.includes('*') ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: config.env === 'development' ? undefined : allowedHeadersList,
    exposedHeaders: [
      'X-Request-Id',
      'X-Correlation-ID',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'ETag',
      'Content-Range',
      'Accept-Ranges',
    ],
    maxAge: 86400,
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(requestIdMiddleware);
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );

  // Cache-Control headers: public static catalog routes can cache briefly; all user/order/mutation routes must not cache
  app.use((req: Request, res: Response, next) => {
    const isApi = req.path.startsWith('/api') || req.path.startsWith(config.apiPrefix);
    if (!isApi) {
      return next();
    }

    const publicCacheablePaths = [
      '/categories',
      '/locations',
      '/tax',
      '/config/remote',
      '/remote-config',
      '/app-lifecycle/public',
    ];

    const isPublicGet =
      req.method === 'GET' &&
      publicCacheablePaths.some((p) => req.path.includes(p));

    if (isPublicGet) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());
  app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));

  // Rate Limiting, Maintenance & Traffic Protection Load Shedding
  app.use(globalLimiter);
  app.use(maintenanceMiddleware);
  app.use(trafficProtectionService.loadSheddingMiddleware());
  app.use(appVersionGate);

  // Static uploads directory with seamless fallback to R2 storage endpoint
  app.use('/uploads', express.static(path.resolve(process.cwd(), config.storage.uploadDir)));
  app.get('/uploads/*', (req: Request, res: Response) => {
    const fileKey = req.params[0];
    res.redirect(301, `${config.apiPrefix}/storage/file/${fileKey}`);
  });

  // Root welcome & API status
  app.get('/', (req: Request, res: Response) => {
    res.json({
      success: true,
      service: 'سوقناا Backend API',
      status: 'online',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        readiness: '/ready',
        api: config.apiPrefix,
      },
    });
  });

  // Health check
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'souqnaa-backend',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      requestId: req.requestId,
    });
  });
  app.get(`${config.apiPrefix}/health`, (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'souqnaa-backend',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      requestId: req.requestId,
    });
  });

  // Readiness check (Readiness probe - verifies DB & Redis without exposing internal secrets)
  const readinessHandler = async (req: Request, res: Response) => {
    let dbStatus = 'healthy';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'unhealthy';
    }

    const redisHealth = await redis.ping();
    const isReady = dbStatus === 'healthy';
    const statusCode = isReady ? 200 : 503;

    res.status(statusCode).json({
      status: isReady ? 'ready' : 'unavailable',
      service: 'souqnaa-backend',
      timestamp: new Date().toISOString(),
      environment: config.env,
      dependencies: {
        database: {
          status: dbStatus,
          critical: true,
        },
        cache: {
          status: redisHealth.ok ? 'healthy' : 'degraded',
          mode: redisHealth.mode,
          latencyMs: redisHealth.latencyMs,
          critical: false,
        },
      },
      requestId: req.requestId,
    });
  };
  app.get('/ready', readinessHandler);
  app.get(`${config.apiPrefix}/ready`, readinessHandler);

  // Maintenance Configuration Route (§22, §64)
  app.get(`${config.apiPrefix}/config/maintenance`, (req: Request, res: Response) => {
    res.json({
      success: true,
      data: getMaintenanceConfig(),
      requestId: req.requestId,
    });
  });

  app.post(
    `${config.apiPrefix}/config/maintenance`,
    authenticate,
    requireAdmin,
    (req: Request, res: Response) => {
      const updated = setMaintenanceConfig(req.body || {});
      res.json({
        success: true,
        data: updated,
        requestId: req.requestId,
      });
    }
  );

  // API v1 Routes
  const p = config.apiPrefix;
  app.use(`${p}/auth`, authRoutes);
  app.use(`${p}/customer`, authRoutes);
  app.use(`${p}/home`, homeRoutes);
  app.use(`${p}/search`, searchRoutes);
  app.use(`${p}/locations`, locationRoutes);
  app.use(`${p}/addresses`, addressRoutes);
  app.use(`${p}/categories`, categoryRoutes);
  app.use(`${p}/products`, productRoutes);
  // Authoritative Seller Performance Score Engine (Protected Seller Routes)
  app.use(`${p}/sellers/me`, sellerPerformanceRouter);
  app.use(`${p}/seller/me`, sellerPerformanceRouter);
  app.use(`${p}/seller`, sellerPerformanceRouter);

  // Public Seller Performance Score (accessible by customers & storefronts before generic routes)
  app.use(`${p}/stores`, publicSellerPerformanceRouter);
  app.use(`${p}/sellers`, publicSellerPerformanceRouter);
  app.use(`${p}/stores`, storeRoutes);
  app.use(`${p}/sellers`, sellerRoutes);
  app.use(`${p}/cart`, cartRoutes);
  app.use(`${p}/buy-again`, buyAgainRoutes);
  app.use(`${p}/customer/buy-again`, buyAgainRoutes);
  app.use(`${p}/guest`, guestRoutes);
  app.use(`${p}/sync`, syncRoutes);
  app.use(`${p}/delivery`, deliveryRoutes);
  app.use(`${p}/orders`, orderRoutes);
  app.use(`${p}/payments`, paymentRoutes);
  app.use(`${p}/promotions`, promotionRoutes);
  app.use(`${p}/wishlist`, wishlistRoutes);
  app.use(`${p}/reviews`, reviewRoutes);
  app.use(`${p}/notifications`, notificationRoutes);
  app.use(`${p}/conversations`, chatRoutes);
  app.use(`${p}/support`, supportRoutes);
  app.use(`${p}/flash-sales`, customerFlashSaleRoutes);
  app.use(`${p}/seller/flash-sales`, sellerFlashSaleRoutes);
  app.use(`${p}/admin/flash-sales`, adminFlashSaleRoutes);
  app.use(`${p}/vouchers`, customerVoucherRoutes);
  app.use(`${p}/seller/vouchers`, sellerVoucherRoutes);
  // Refund, Returns & Disputes System
  app.use(`${p}/customer/refunds`, customerRefundRoutes);
  app.use(`${p}/seller/refunds`, sellerRefundRoutes);
  app.use(`${p}/admin/refunds`, adminRefundRoutes);
  app.use(`${p}/wallet`, customerWalletRoutes);
  app.use(`${p}/disputes`, disputeRoutes);
  app.use(`${p}/integrity`, integrityRoutes);

  app.use(`${p}/admin`, adminRoutes);
  app.use('/admin', adminRoutes);
  app.use(`${p}/upload`, uploadRoutes);
  app.use(`${p}/storage`, storageRoutes);
  app.use(`${p}/follows`, followRoutes);
  app.use(`${p}/banners`, customerBannerRoutes);
  // Customer Campaigns & Mega Campaign Landing Pages
  app.use(`${p}/campaigns`, customerCampaignRoutes);
  // Seller Marketing (replaces old /seller/banners — full paid promotion lifecycle)
  app.use(`${p}/seller/marketing`, sellerMarketingRoutes);
  // adminCampaignBannerRoutes exposes /campaigns, /banners, /placements, /deep-links
  app.use(`${p}/admin`, adminCampaignBannerRoutes);
  // Admin seller promotion management (packages, approval queue)
  app.use(`${p}/admin/marketing`, adminSellerPromotionRoutes);
  // Legacy Banner CRUD used by the admin Banners Tab
  app.use(`${p}/admin/promotions`, adminPromotionRoutes);

  // Production-Grade Recommendation Engine & Event Tracking (§28 - §31, §71, §72)
  app.use(`${p}/recommendations`, recommendationRoutes);
  app.use(`${p}/admin/recommendations`, adminRecommendationRoutes);

  // SOUQNAA Coins & Rewards Engine (§1 - §117)
  app.use(`${p}/rewards`, customerRewardsRoutes);
  app.use(`${p}/admin/rewards`, adminRewardsRoutes);
  app.use(`${p}/seller/rewards`, sellerRewardsRoutes);

  // Production-Grade Remote Configuration & Feature Flags System
  app.use(`${p}/config/remote`, remoteConfigPublicRoutes);
  app.use(`${p}/remote-config`, remoteConfigPublicRoutes);
  app.use('/config/remote', remoteConfigPublicRoutes);
  app.use('/remote-config', remoteConfigPublicRoutes);
  app.use(`${p}/admin/feature-flags`, remoteConfigAdminRoutes);

  // Production-Grade Centralized Tax Engine (SOUQNAA Marketplace)
  app.use(`${p}/tax`, taxRoutes);
  app.use(`${p}/admin/tax`, taxAdminRoutes);

  // Production-Grade Centralized Financial Statements Engine (SOUQNAA Marketplace)
  app.use(`${p}/seller`, sellerStatementsRouter);
  app.use(`${p}/admin`, adminStatementsRouter);
  app.use('/seller', sellerStatementsRouter);
  app.use('/admin', adminStatementsRouter);

  // Production-Grade Advanced Analytics Engine (Client Batch & Seller/Admin Analysis) (§39)
  app.use(`${p}/analytics`, analyticsRouter);
  app.use('/analytics', analyticsRouter);
  app.use(`${p}/seller/analytics`, sellerAnalyticsRouter);
  app.use(`${p}/admin/analytics`, adminAnalyticsRouter);
  app.use('/seller/analytics', sellerAnalyticsRouter);
  app.use('/admin/analytics', adminAnalyticsRouter);
  app.use(`${p}/sellers/me/analytics`, sellerAnalyticsRouter);
  app.use(`${p}/admin/reports/analytics`, adminAnalyticsRouter);
  app.use('/sellers/me/analytics', sellerAnalyticsRouter);
  app.use('/admin/reports/analytics', adminAnalyticsRouter);

  // Production-Grade Customer Membership & VIP Tiers Engine
  app.use(`${p}/customers/me/membership`, customerMembershipRoutes);
  app.use(`${p}/customer/membership`, customerMembershipRoutes);
  app.use(`${p}/membership`, customerMembershipRoutes);
  app.use(`${p}/admin/membership`, adminMembershipRoutes);
  app.use('/admin/membership', adminMembershipRoutes);

  // Production-Grade Universal App Lifecycle, Version Policy & Distribution Engine (§46)
  app.use(`${p}/app`, appLifecyclePublicRoutes);
  app.use(`${p}/admin/app`, appLifecycleAdminRoutes);
  app.use('/admin/app', appLifecycleAdminRoutes);

  // Production-Grade Customer Profile Smart Action Center Engine
  app.use(`${p}/customers/me/action-center`, customerActionCenterRoutes);
  app.use(`${p}/customer/action-center`, customerActionCenterRoutes);
  app.use(`${p}/action-center`, customerActionCenterRoutes);
  app.use(`${p}/admin/action-center`, adminActionCenterRoutes);
  app.use('/admin/action-center', adminActionCenterRoutes);

  // Production-Grade Authoritative Seller Performance Score Engine
  app.use(`${p}/seller`, sellerPerformanceRouter);
  app.use(`${p}/seller/me`, sellerPerformanceRouter);
  app.use(`${p}/sellers/me`, sellerPerformanceRouter);
  app.use(`${p}/admin`, adminSellerPerformanceRouter);
  app.use('/admin', adminSellerPerformanceRouter);

  // 404 Route handler — do NOT echo raw req.originalUrl to avoid reflected path info leakage
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
};
