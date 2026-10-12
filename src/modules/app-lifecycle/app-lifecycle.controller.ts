import { Request, Response, NextFunction } from 'express';
import { appLifecycleService } from './app-lifecycle.service';
import { ResponseUtil } from '../../utils/response.util';

export class AppLifecycleController {
  // ==========================================
  // CLIENT ENDPOINTS (§18, §19, §46)
  // ==========================================
  async getAppConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const appType = (req.query.appType as string) || (req.headers['x-app-type'] as string);
      const platform = (req.query.platform as string) || (req.headers['x-platform'] as string);
      const deviceType = (req.query.deviceType as string) || (req.headers['x-device-type'] as string);
      const version = (req.query.version as string) || (req.headers['x-app-version'] as string);
      const build = (req.query.build as string) || (req.headers['x-app-build'] as string);
      const environment = (req.query.environment as string) || (req.headers['x-environment'] as string);

      const config = await appLifecycleService.resolveAppConfig({
        appType,
        platform,
        deviceType,
        version,
        build,
        environment,
      });

      ResponseUtil.success(res, config, 'App configuration retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async getReleases(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await appLifecycleService.listReleases({
        appType: req.query.appType as string,
        platform: req.query.platform as string,
        channel: req.query.channel as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      });

      ResponseUtil.paginated(
        res,
        result.releases,
        result.total,
        result.page,
        result.limit,
        'App releases retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  async getVersionPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const config = await appLifecycleService.resolveAppConfig({
        appType: req.query.appType as string,
        platform: req.query.platform as string,
        deviceType: req.query.deviceType as string,
        environment: req.query.environment as string,
      });

      ResponseUtil.success(
        res,
        {
          app: config.app,
          versionPolicy: config.versionPolicy,
          store: config.store,
        },
        'Version policy retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  async getStoreLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const links = await appLifecycleService.listStoreLinks();
      ResponseUtil.success(res, links, 'Store links retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async recordUpdateEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await appLifecycleService.recordUpdateEvent(req.body);
      ResponseUtil.created(res, event, 'Update event logged successfully');
    } catch (error) {
      next(error);
    }
  }

  async recordRatingEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await appLifecycleService.recordRatingEvent(req.body);
      ResponseUtil.created(res, event, 'Rating event logged successfully');
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // ADMIN ENDPOINTS (§31 - §40, §46)
  // ==========================================
  async adminListReleases(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await appLifecycleService.listReleases({
        appType: req.query.appType as string,
        platform: req.query.platform as string,
        channel: req.query.channel as string,
        status: req.query.status as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      });

      ResponseUtil.paginated(
        res,
        result.releases,
        result.total,
        result.page,
        result.limit,
        'Admin releases list retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  async adminCreateRelease(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user?.userId || 'admin';
      const release = await appLifecycleService.createRelease(req.body, adminId, req.requestId);
      ResponseUtil.created(res, release, 'Release created successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminUpdateRelease(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user?.userId || 'admin';
      const release = await appLifecycleService.updateRelease(
        String(req.params.id),
        req.body,
        adminId,
        req.requestId
      );
      ResponseUtil.success(res, release, 'Release updated successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminListVersionPolicies(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const policies = await appLifecycleService.listVersionPolicies(req.query.environment as string);
      ResponseUtil.success(res, policies, 'Version policies retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminUpdateVersionPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user?.userId || 'admin';
      const policy = await appLifecycleService.updateVersionPolicy(
        String(req.params.id),
        req.body,
        adminId,
        req.requestId
      );
      ResponseUtil.success(res, policy, 'Version policy updated successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminListStoreLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const links = await appLifecycleService.listStoreLinks();
      ResponseUtil.success(res, links, 'Store links retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminUpdateStoreLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user?.userId || 'admin';
      const link = await appLifecycleService.updateStoreLink(
        String(req.params.id),
        req.body,
        adminId,
        req.requestId
      );
      ResponseUtil.success(res, link, 'Store link updated successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminGetAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
      const analytics = await appLifecycleService.getAnalyticsDashboard({
        appType: req.query.appType as string,
        platform: req.query.platform as string,
        environment: req.query.environment as string,
        days,
      });

      ResponseUtil.success(res, analytics, 'Update analytics retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminGetMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rules = await appLifecycleService.getMaintenanceRules();
      ResponseUtil.success(res, rules, 'Maintenance rules retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminUpdateMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user?.userId || 'admin';
      const ruleId = req.body.id || (req.params as any)?.id || null;
      const rule = await appLifecycleService.updateMaintenanceRule(
        ruleId,
        req.body,
        adminId,
        req.requestId
      );
      ResponseUtil.success(res, rule, 'Maintenance rule updated successfully');
    } catch (error) {
      next(error);
    }
  }

  async adminGetAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const logs = await appLifecycleService.listAuditLogs(page, limit);
      ResponseUtil.paginated(
        res,
        logs.logs,
        logs.total,
        logs.page,
        logs.limit,
        'Release audit logs retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }
}

export const appLifecycleController = new AppLifecycleController();
