import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ResponseUtil } from '../utils/response.util';

export class AppError extends Error {
  constructor(
    public override message: string,
    public statusCode = 500,
    public code?: string,
    public fieldErrors?: Record<string, string[]>,
    public localizedMessage?: { ar: string; en: string }
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const requestId = (req as any).requestId || (req.headers['x-request-id'] as string) || undefined;

  // 1. Zod Validation Error (HTTP 422)
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    err.errors.forEach((e) => {
      const field = e.path.join('.');
      if (!fieldErrors[field]) fieldErrors[field] = [];
      fieldErrors[field].push(e.message);
    });

    ResponseUtil.error(
      res,
      'Validation failed for one or more fields',
      422,
      fieldErrors,
      {
        code: 'VALIDATION_ERROR',
        requestId,
        localizedMessage: {
          ar: 'يرجى التحقق من صحة البيانات المدخلة.',
          en: 'Validation failed for one or more fields.',
        },
      }
    );
    return;
  }

  // 2. Custom AppError or any error with explicit statusCode
  if (err instanceof AppError || (err && typeof err.statusCode === 'number')) {
    const statusCode = err.statusCode || 400;
    const msg = err.messageAr || err.message || 'Error';
    ResponseUtil.error(res, msg, statusCode, err.fieldErrors, {
      code: err.code || ResponseUtil.defaultErrorCodeForStatus(statusCode),
      requestId,
      localizedMessage: err.localizedMessage,
    });
    return;
  }

  // 3. Prisma Known Errors (Sanitize database and SQL internals)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[])?.join(', ') || 'الحقل';
      ResponseUtil.error(res, `السجل موجود مسبقاً (${target})`, 409, undefined, {
        code: 'CONFLICT',
        requestId,
        localizedMessage: {
          ar: `السجل موجود مسبقاً (${target})`,
          en: `Resource already exists (${target}).`,
        },
      });
      return;
    }
    if (err.code === 'P2025') {
      ResponseUtil.error(res, 'العنصر المطلوب غير موجود', 404, undefined, {
        code: 'NOT_FOUND',
        requestId,
        localizedMessage: {
          ar: 'العنصر المطلوب غير موجود',
          en: 'Requested resource could not be found.',
        },
      });
      return;
    }
  }

  // 4. JWT Authentication Errors
  if (err.name === 'JsonWebTokenError') {
    ResponseUtil.error(res, 'رمز المصادقة غير صالح.', 401, undefined, {
      code: 'UNAUTHORIZED',
      requestId,
      localizedMessage: {
        ar: 'رمز المصادقة غير صالح أو منتهي.',
        en: 'Invalid or expired authentication token.',
      },
    });
    return;
  }
  if (err.name === 'TokenExpiredError') {
    ResponseUtil.error(res, 'انتهت صلاحية جلسة الدخول. يرجى إعادة تسجيل الدخول.', 401, undefined, {
      code: 'UNAUTHORIZED',
      requestId,
      localizedMessage: {
        ar: 'انتهت صلاحية جلسة الدخول. يرجى إعادة تسجيل الدخول.',
        en: 'Your session has expired. Please sign in again.',
      },
    });
    return;
  }

  // Log full internal error on server without leaking to client
  console.error('[Unhandled Server Error]:', {
    requestId,
    message: err?.message,
    name: err?.name,
    code: err?.code,
    stack: err?.stack,
    path: req.originalUrl || req.path,
    method: req.method,
  });

  // 5. Generic 500 Server Error — Never return raw stack traces or internal SQL errors
  ResponseUtil.error(
    res,
    'حدث خطأ غير متوقع في الخادم',
    500,
    undefined,
    {
      code: 'SERVER_ERROR',
      requestId,
      localizedMessage: {
        ar: 'حدث خطأ غير متوقع في الخادم. حاول مرة أخرى لاحقاً.',
        en: 'Something went wrong on the server. Please try again later.',
      },
    }
  );
};
