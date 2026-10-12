import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
    nextCursor?: string | null;
    [key: string]: any;
  };
  errors?: Record<string, string[]>;
  error?: {
    code?: string;
    message?: string;
    localizedMessage?: {
      ar: string;
      en: string;
    };
    requestId?: string;
    details?: any;
  };
  requestId?: string;
}

export class ResponseUtil {
  static success<T>(
    res: Response,
    data: T,
    message?: string,
    statusCode = 200,
    meta?: ApiResponse['meta']
  ): Response {
    const req = (res as any).req;
    const requestId = req?.requestId || req?.headers?.['x-request-id'];
    const payload: ApiResponse<T> = {
      success: true,
      message,
      data,
      meta,
      requestId,
    };
    return res.status(statusCode).json(payload);
  }

  static created<T>(res: Response, data: T, message = 'Resource created successfully'): Response {
    return this.success(res, data, message, 201);
  }

  static error(
    res: Response,
    message = 'An unexpected error occurred',
    statusCode = 500,
    errors?: Record<string, string[]>,
    options?: {
      code?: string;
      requestId?: string;
      localizedMessage?: { ar: string; en: string };
      details?: any;
    }
  ): Response {
    const req = (res as any).req;
    const reqId = options?.requestId || req?.requestId || req?.headers?.['x-request-id'] || undefined;
    const code = options?.code || this.defaultErrorCodeForStatus(statusCode);

    const payload: ApiResponse = {
      success: false,
      message,
      errors,
      error: {
        code,
        message,
        localizedMessage: options?.localizedMessage || {
          ar: message,
          en: message,
        },
        requestId: reqId,
        details: options?.details,
      },
      requestId: reqId,
    };
    return res.status(statusCode).json(payload);
  }

  static defaultErrorCodeForStatus(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return 'VALIDATION_ERROR';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 408:
        return 'REQUEST_TIMEOUT';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'VALIDATION_ERROR';
      case 429:
        return 'RATE_LIMITED';
      case 500:
        return 'SERVER_ERROR';
      case 502:
        return 'BAD_GATEWAY';
      case 503:
        return 'SERVICE_UNAVAILABLE';
      case 504:
        return 'GATEWAY_TIMEOUT';
      default:
        return 'UNKNOWN_ERROR';
    }
  }

  static badRequest(
    res: Response,
    message = 'Bad Request',
    errors?: Record<string, string[]>
  ): Response {
    return this.error(res, message, 400, errors, { code: 'BAD_REQUEST' });
  }

  static notFound(res: Response, message = 'Resource not found'): Response {
    return this.error(res, message, 404, undefined, { code: 'NOT_FOUND' });
  }

  static unauthorized(res: Response, message = 'Unauthorized'): Response {
    return this.error(res, message, 401, undefined, { code: 'UNAUTHORIZED' });
  }

  static forbidden(res: Response, message = 'Forbidden'): Response {
    return this.error(res, message, 403, undefined, { code: 'FORBIDDEN' });
  }

  static paginated<T>(
    res: Response,
    data: T[],
    total: number,
    page: number,
    limit: number,
    message?: string,
    nextCursor?: string | null,
    extraMeta?: Record<string, any>
  ): Response {
    const totalPages = Math.ceil(total / limit);
    return this.success(res, data, message, 200, {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
      nextCursor: nextCursor !== undefined ? nextCursor : (data.length > 0 ? (data[data.length - 1] as any)?.id : null),
      ...(extraMeta || {}),
    });
  }
}
