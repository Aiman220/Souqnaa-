import { Request, Response, NextFunction } from 'express';
import { UserRoleType } from '@prisma/client';
import { AppError } from './error.middleware';

export const authorize = (...allowedRoles: UserRoleType[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError('Authentication required.', 401);
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new AppError(
        'Access denied: You do not have permission to perform this action.',
        403
      );
    }

    next();
  };
};

export const requireAdmin = authorize(UserRoleType.ADMIN);
export const requireSeller = authorize(UserRoleType.SELLER, UserRoleType.ADMIN);
export const requireCustomer = authorize(UserRoleType.CUSTOMER, UserRoleType.SELLER, UserRoleType.ADMIN);

/**
 * Authorizes administrators with specific system roles (e.g. SUPER_ADMIN, FINANCE_ADMIN, etc.).
 * SUPER_ADMIN is always authorized regardless of required role.
 */
export const requireAdminRole = (...allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required.', 401);
      }
      if (req.user.role !== UserRoleType.ADMIN) {
        throw new AppError('Access denied: Administrator privileges required.', 403);
      }

      const { AdminRbacService } = await import('../modules/admin/admin-rbac.service');
      const userRoles = await AdminRbacService.getUserRoleNames(req.user.userId);

      // SUPER_ADMIN has master privileges
      if (userRoles.includes('SUPER_ADMIN')) {
        return next();
      }

      const hasRequiredRole = allowedRoles.some((r) => userRoles.includes(r));
      if (!hasRequiredRole) {
        throw new AppError(
          `صلاحيات غير كافية: يتطلب هذا الإجراء أحد الأدوار التالية [${allowedRoles.join(', ')}]`,
          403,
          'INSUFFICIENT_ROLE_PERMISSIONS'
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

/**
 * Authorizes administrators with specific granular permissions (e.g. 'finance:withdrawals', 'admins:manage').
 * SUPER_ADMIN is always authorized.
 */
export const requirePermission = (...requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required.', 401);
      }
      if (req.user.role !== UserRoleType.ADMIN) {
        throw new AppError('Access denied: Administrator privileges required.', 403);
      }

      const { AdminRbacService } = await import('../modules/admin/admin-rbac.service');
      const userPermissions = await AdminRbacService.getUserPermissions(req.user.userId);

      // Check if user has all required permissions or has SUPER_ADMIN
      const hasAll = requiredPermissions.every((perm) => userPermissions.has(perm));
      if (!hasAll) {
        throw new AppError(
          `غير مصرح: ينقصك أحد الصلاحيات المطلوبة لهذا الإجراء: [${requiredPermissions.join(', ')}]`,
          403,
          'FORBIDDEN_PERMISSION'
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

export const requireSuperAdmin = requireAdminRole('SUPER_ADMIN');
