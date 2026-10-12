import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/error.middleware';
import { remoteConfigService } from './remote-config.service';

/**
 * Server-side guard to strictly enforce feature flag states on backend API endpoints.
 * Completely independent of Flutter UI state, client local storage, or forged payloads.
 */
export const requireFeature = (featureKey: string, customMessage?: string) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const platform = (req.headers['x-platform'] as string) || (req.query.platform as string) || undefined;
      const userId = (req as any).user?.userId || (req as any).user?.id;

      const isActive = await remoteConfigService.isFeatureActive(featureKey, {
        userId,
        platform,
      });

      if (!isActive) {
        const errorMsg =
          customMessage ||
          `العملية غير متاحة: تم تعطيل الميزة [${featureKey}] على مستوى المنصة لأسباب فنية أو صيانة تشغيلية مؤقتة.`;
        return next(new AppError(errorMsg, 403, 'FEATURE_DISABLED'));
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Server-side guard to check electronic wallet provider status.
 */
export const requireWalletProvider = (providerCode: string) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const isActive = await remoteConfigService.isWalletProviderActive(providerCode);

      if (!isActive) {
        return next(
          new AppError(
            `مزود المحفظة الإلكترونية [${providerCode}] معطل حالياً من قبل إدارة المنصة.`,
            403,
            'PROVIDER_DISABLED'
          )
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
