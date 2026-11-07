import { Request, Response, NextFunction } from 'express';
import { redis } from '../database/redis';
import { buildScopedIdempotencyKey } from '../utils/idempotency-key.util';

/**
 * Production Idempotency Guard Middleware (§1, §3).
 * Intercepts POST/PUT/PATCH requests carrying `X-Idempotency-Key` or `Idempotency-Key`.
 * Guarantees exactly-once execution for financial, order, and critical state-changing mutations.
 * Returns cached responses on duplicate submissions without re-executing backend business logic.
 */
export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    return next();
  }

  const rawKey =
    (req.headers['x-idempotency-key'] as string) ||
    (req.headers['idempotency-key'] as string) ||
    (req.body && typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined);

  if (!req.user?.userId || !rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    return next();
  }

  const idempotencyKey = buildScopedIdempotencyKey(req.user.userId, method, `${req.baseUrl}${req.path}`, rawKey);

  try {
    const acquireResult = await redis.acquireIdempotency(idempotencyKey, 86400);

    if (!acquireResult.isFirstAttempt) {
      if (acquireResult.status === 'COMPLETED' && acquireResult.result !== undefined) {
        res.setHeader('X-Idempotency-Status', 'HIT');
        res.setHeader('X-Idempotency-Key', idempotencyKey);
        res.status(200).json(acquireResult.result);
        return;
      }

      if (acquireResult.status === 'PENDING') {
        res.setHeader('Retry-After', '2');
        res.status(409).json({
          success: false,
          code: 'IDEMPOTENCY_IN_FLIGHT',
          message: 'عملية مطابقة قيد المعالجة حالياً. يرجى الانتظار لحظة.',
        });
        return;
      }
    }

    res.setHeader('X-Idempotency-Status', 'ACQUIRED');
    res.setHeader('X-Idempotency-Key', idempotencyKey);

    // Intercept response to record result once completed successfully
    const originalJson = res.json.bind(res);
    res.json = (body: any): Response => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.completeIdempotency(idempotencyKey, body, 86400).catch((err) => {
          console.warn('[Idempotency] Failed to cache completion result:', err?.message);
        });
      }
      return originalJson(body);
    };

    next();
  } catch (error) {
    console.warn('[Idempotency] Error checking idempotency key:', error);
    next(error);
  }
}

