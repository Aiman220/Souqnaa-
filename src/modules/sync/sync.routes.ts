import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { SyncService } from './sync.service';

const router = Router();
router.use(authenticate);

/**
 * POST /api/v1/sync — Centralized batch synchronization endpoint (§1, §14, §15, §18)
 * Safely reconciles offline operations for Cart, Wishlist, Profile, and dynamic reference data.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string) || req.body.idempotencyKey;

    const result = await SyncService.synchronize(userId, req.body, idempotencyKey);

    ResponseUtil.success(res, result, 'Synchronization completed successfully');
  } catch (error) {
    next(error);
  }
});

export const syncRoutes = router;
