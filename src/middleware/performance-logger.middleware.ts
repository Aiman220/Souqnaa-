import { Request, Response, NextFunction } from 'express';
import { backendTelemetry } from '../services/telemetry/backend-telemetry.service';

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'password',
  'secret',
  'authorization',
  'refreshtoken',
  'accesstoken',
  'key',
  'otp',
  'pin',
  'cvv',
  'card',
  'cardnumber',
  'signature',
]);

/**
 * Strips any sensitive query parameters from URLs before structured logging.
 */
function sanitizePath(rawUrl: string): string {
  try {
    const qIndex = rawUrl.indexOf('?');
    if (qIndex === -1) return rawUrl;

    const path = rawUrl.substring(0, qIndex);
    const queryString = rawUrl.substring(qIndex + 1);
    const params = new URLSearchParams(queryString);

    const safeParams = new URLSearchParams();
    params.forEach((value, key) => {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        safeParams.set(key, '[REDACTED]');
      } else {
        safeParams.set(key, value);
      }
    });

    const safeQuery = safeParams.toString();
    return safeQuery.length > 0 ? `${path}?${safeQuery}` : path;
  } catch {
    return rawUrl.split('?')[0];
  }
}

/**
 * Structured Performance Instrumentation Middleware.
 * Measures request duration, response size, endpoint, and status code.
 * Safe for production: never logs sensitive authorization, payment, or personal data.
 */
export const performanceLoggerMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startNano = process.hrtime.bigint();
  let responseBytes = 0;

  // Intercept write & end to track accurate byte size
  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function (chunk: any, ...args: any[]): boolean {
    if (chunk) {
      responseBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, (typeof args[0] === 'string' ? args[0] : 'utf8') as BufferEncoding);
    }
    return (originalWrite as any).apply(res, [chunk, ...args]);
  };

  res.end = function (chunk: any, ...args: any[]): Response {
    if (chunk) {
      responseBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, (typeof args[0] === 'string' ? args[0] : 'utf8') as BufferEncoding);
    }

    const endNano = process.hrtime.bigint();
    const durationMs = Number(endNano - startNano) / 1_000_000;
    const roundedDuration = Math.round(durationMs * 100) / 100;

    const sanitizedEndpoint = sanitizePath(req.originalUrl || req.url || req.path);

    // Record in memory telemetry
    backendTelemetry.recordRequest({
      method: req.method,
      endpoint: req.baseUrl + req.path,
      statusCode: res.statusCode,
      durationMs: roundedDuration,
      responseBytes,
    });

    // Structured JSON log for slow requests (> 300ms) or errors (>= 400)
    const isSlow = roundedDuration >= 300;
    const isError = res.statusCode >= 400;

    if (isSlow || isError || process.env.DEBUG_PERFORMANCE === 'true') {
      const logPayload = {
        type: 'api_performance',
        requestId: req.requestId || 'unknown',
        method: req.method,
        endpoint: sanitizedEndpoint,
        statusCode: res.statusCode,
        durationMs: roundedDuration,
        responseBytes,
        timestamp: new Date().toISOString(),
      };

      if (isError) {
        console.warn(`[HTTP Error] ${JSON.stringify(logPayload)}`);
      } else if (isSlow) {
        console.warn(`[HTTP Slow Request] ${JSON.stringify(logPayload)}`);
      }
    }

    return (originalEnd as any).apply(res, [chunk, ...args]);
  };

  next();
};
