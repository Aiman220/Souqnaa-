import { Request, Response, NextFunction } from 'express';
import { CustomerActionCenterService } from './customer-action-center.service';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

export class CustomerActionCenterController {
  public static async getActionCenter(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';
      const platform = (req.headers['x-platform'] as string) || undefined;
      const appVersion = (req.headers['x-app-version'] as string) || undefined;

      const result = await CustomerActionCenterService.getActionCenter(userId, {
        limit,
        locale,
        platform,
        appVersion,
      });

      ResponseUtil.success(res, result, 'Action center loaded successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async dismissAction(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      const actionId = String(req.params.id);
      const { deduplicationKey } = req.body || {};

      await CustomerActionCenterService.dismissAction(userId, actionId, deduplicationKey);
      ResponseUtil.success(res, { dismissed: true }, 'Action dismissed successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async snoozeAction(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      const actionId = String(req.params.id);
      const { deduplicationKey, snoozeHours } = req.body || {};

      await CustomerActionCenterService.snoozeAction(
        userId,
        actionId,
        deduplicationKey,
        snoozeHours ? parseInt(snoozeHours, 10) : 24
      );
      ResponseUtil.success(res, { snoozed: true }, 'Action snoozed successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async claimAction(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Unauthorized', 401);
      }

      const actionId = String(req.params.id);
      const { claimType, metadata } = req.body || {};

      const result = await CustomerActionCenterService.claimAction(
        userId,
        actionId,
        claimType,
        metadata
      );
      ResponseUtil.success(res, result, 'Action claimed successfully');
    } catch (err) {
      next(err);
    }
  }
}
