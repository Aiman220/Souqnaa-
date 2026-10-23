import { Request, Response, NextFunction } from 'express';
import { JwtUtil, TokenPayload } from '../utils/jwt.util';
import { AppError } from './error.middleware';
import { prisma } from '../database/prisma';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      throw new AppError('يرجى تسجيل الدخول للمتابعة.', 401, 'UNAUTHORIZED');
    }

    const payload = JwtUtil.verifyAccessToken(token);

    // Verify user is still active in database
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, isActive: true, role: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User account is deactivated or not found.', 401);
    }

    if (user.role === 'ADMIN') {
      const { AdminSessionService } = await import('../modules/admin/admin-session.service');
      const isRevoked = await AdminSessionService.isSessionRevoked(payload.userId, payload.iat);
      if (isRevoked) {
        throw new AppError('الجلسة ملغاة أو منتهية الصلاحية. يرجى إعادة تسجيل الدخول.', 401, 'SESSION_REVOKED');
      }
    }

    req.user = payload;
    next();
  } catch (error) {
    next(error);
  }
};

export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (token) {
      const payload = JwtUtil.verifyAccessToken(token);
      req.user = payload;
    }
    next();
  } catch {
    next();
  }
};

export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('Unauthorized', 401));
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new AppError('Forbidden: Insufficient permissions', 403));
    }
    next();
  };
};
