import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Request ID & Correlation ID Middleware.
 * Ensures every incoming HTTP request carries a unique X-Request-ID
 * for end-to-end tracing and error logging without exposing sensitive internals.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const incomingId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const requestId = (typeof incomingId === 'string' && incomingId.trim().length > 0)
    ? incomingId.trim()
    : randomUUID();

  req.requestId = requestId;
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);

  next();
};
