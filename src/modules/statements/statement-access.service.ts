/**
 * SOUQNAA Marketplace — Statement Access & Authorization Service
 * Strict server-side access control:
 * - Sellers can ONLY access their own authorized statements.
 * - Admins can access statements per RBAC role.
 * - Customers are completely BLOCKED with 403 Forbidden.
 */

import { AppError } from '../../middleware/error.middleware';
import { prisma } from '../../database/prisma';
import { UserRoleType } from '@prisma/client';

export interface AuthContext {
  userId: string;
  role: UserRoleType | string;
  sellerId?: string;
}

export class StatementAccessService {
  /**
   * Asserts that the authenticated user is allowed to access the given statement.
   * Throws structured error if unauthorized.
   */
  public static async assertCanAccessStatement(
    auth: AuthContext,
    statementIdOrStatement: string | { id: string; sellerId: string; statementType: string }
  ) {
    // 1. Strictly block customers from any access
    if (auth.role === UserRoleType.CUSTOMER || auth.role === 'CUSTOMER') {
      throw new AppError('غير مصرح لك بالوصول إلى الكشوفات المالية للمنصة', 403);
    }

    const statement = typeof statementIdOrStatement === 'string'
      ? await prisma.financialStatement.findUnique({
          where: { id: statementIdOrStatement },
          select: { id: true, sellerId: true, statementType: true },
        })
      : statementIdOrStatement;

    if (!statement) {
      throw new AppError('الكشف المالي غير موجود', 404);
    }

    // 2. Admins have access
    if (auth.role === UserRoleType.ADMIN || auth.role === 'ADMIN') {
      return statement;
    }

    // 3. For sellers, resolve their seller ID if not attached to context
    let sellerId = auth.sellerId;
    if (!sellerId) {
      const seller = await prisma.seller.findUnique({
        where: { userId: auth.userId },
        select: { id: true },
      });
      if (!seller) {
        throw new AppError('حساب التاجر غير موجود', 403);
      }
      sellerId = seller.id;
    }

    // 4. Validate seller ownership
    if (statement.sellerId !== sellerId) {
      throw new AppError('غير مصرح لك بالوصول إلى كشف مالي يخص تاجراً آخر', 403);
    }

    return statement;
  }

  /**
   * Asserts that a seller is accessing their own sellerId filter.
   */
  public static resolveAuthorizedSellerId(auth: AuthContext, requestedSellerId?: string): string {
    if (auth.role === UserRoleType.CUSTOMER || auth.role === 'CUSTOMER') {
      throw new AppError('غير مصرح لك بالوصول إلى الكشوفات المالية للمنصة', 403);
    }

    if (auth.role === UserRoleType.ADMIN || auth.role === 'ADMIN') {
      if (!requestedSellerId) {
        throw new AppError('معرف التاجر مطلوب للبحث في كشوفات البائعين', 400);
      }
      return requestedSellerId;
    }

    // For sellers, force their own sellerId, discarding any client-provided sellerId
    if (!auth.sellerId) {
      throw new AppError('معرف التاجر غير متوفر في جلسة الدخول', 403);
    }
    return auth.sellerId;
  }
}
