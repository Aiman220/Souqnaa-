import { Router } from 'express';
import { appLifecycleController } from './app-lifecycle.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';

// ==========================================
// PUBLIC CLIENT ROUTES (/api/v1/app)
// ==========================================
export const appLifecyclePublicRoutes = Router();

appLifecyclePublicRoutes.get(
  '/config',
  appLifecycleController.getAppConfig.bind(appLifecycleController)
);

appLifecyclePublicRoutes.get(
  '/releases',
  appLifecycleController.getReleases.bind(appLifecycleController)
);

appLifecyclePublicRoutes.get(
  '/version-policy',
  appLifecycleController.getVersionPolicy.bind(appLifecycleController)
);

appLifecyclePublicRoutes.get(
  '/store-links',
  appLifecycleController.getStoreLinks.bind(appLifecycleController)
);

appLifecyclePublicRoutes.post(
  '/update-events',
  appLifecycleController.recordUpdateEvent.bind(appLifecycleController)
);

appLifecyclePublicRoutes.post(
  '/rating-events',
  appLifecycleController.recordRatingEvent.bind(appLifecycleController)
);

// ==========================================
// ADMIN MANAGEMENT ROUTES (/api/v1/admin/app)
// ==========================================
export const appLifecycleAdminRoutes = Router();

appLifecycleAdminRoutes.use(authenticate, requireAdmin);

// Releases
appLifecycleAdminRoutes.get(
  '/releases',
  appLifecycleController.adminListReleases.bind(appLifecycleController)
);

appLifecycleAdminRoutes.post(
  '/releases',
  appLifecycleController.adminCreateRelease.bind(appLifecycleController)
);

appLifecycleAdminRoutes.patch(
  '/releases/:id',
  appLifecycleController.adminUpdateRelease.bind(appLifecycleController)
);

// Version Policies
appLifecycleAdminRoutes.get(
  '/version-policies',
  appLifecycleController.adminListVersionPolicies.bind(appLifecycleController)
);

appLifecycleAdminRoutes.patch(
  '/version-policies/:id',
  appLifecycleController.adminUpdateVersionPolicy.bind(appLifecycleController)
);

// Store Links
appLifecycleAdminRoutes.get(
  '/store-links',
  appLifecycleController.adminListStoreLinks.bind(appLifecycleController)
);

appLifecycleAdminRoutes.patch(
  '/store-links/:id',
  appLifecycleController.adminUpdateStoreLink.bind(appLifecycleController)
);

// Analytics
appLifecycleAdminRoutes.get(
  '/analytics',
  appLifecycleController.adminGetAnalytics.bind(appLifecycleController)
);

// Maintenance
appLifecycleAdminRoutes.get(
  '/maintenance',
  appLifecycleController.adminGetMaintenance.bind(appLifecycleController)
);

appLifecycleAdminRoutes.patch(
  '/maintenance',
  appLifecycleController.adminUpdateMaintenance.bind(appLifecycleController)
);

appLifecycleAdminRoutes.post(
  '/maintenance',
  appLifecycleController.adminUpdateMaintenance.bind(appLifecycleController)
);

// Audit Logs
appLifecycleAdminRoutes.get(
  '/audit-logs',
  appLifecycleController.adminGetAuditLogs.bind(appLifecycleController)
);
