import { Request, Response, NextFunction } from 'express';
import { prisma } from '../database/prisma';

export const auditLog = (action: string, resource: string) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const originalSend = res.send;

    res.send = function (body): Response {
      res.send = originalSend;
      const response = res.send(body);

      // Async write audit log after successful modifying request
      if (res.statusCode >= 200 && res.statusCode < 300) {
        prisma.auditLog
          .create({
            data: {
              userId: req.user?.userId || null,
              action,
              resource,
              ipAddress: req.ip || req.socket.remoteAddress || null,
              userAgent: req.headers['user-agent'] || null,
              details: JSON.stringify({
                method: req.method,
                path: req.originalUrl,
                params: req.params,
                body: sanitizeAuditBody(req.body),
              }),
            },
          })
          .catch((err) => console.error('[Audit Log Failed]', err));
      }

      return response;
    };

    next();
  };
};

function sanitizeAuditBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  const sensitiveKeys = ['password', 'token', 'refreshToken', 'code', 'cvv', 'cardNumber'];
  for (const key of sensitiveKeys) {
    if (key in sanitized) sanitized[key] = '***REDACTED***';
  }
  return sanitized;
}
