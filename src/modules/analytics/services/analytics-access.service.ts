import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { UserRoleType } from '@prisma/client';

export class AnalyticsAccessService {
  /**
   * Resolves the authenticated user's authoritative seller ID.
   * Throws 403 / 404 if the user is not a verified registered seller.
   */
  public static async resolveAuthorizedSellerId(userId: string): Promise<string> {
    const seller = await prisma.seller.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });

    if (!seller) {
      throw new AppError('حساب البائع غير موجود أو غير مفعل.', 404, 'SELLER_NOT_FOUND');
    }

    return seller.id;
  }

  /**
   * Verifies that the actor has permission to access the requested seller's analytical data.
   */
  public static assertSellerAccess(
    actorRole: string,
    authorizedSellerId: string,
    targetSellerId: string
  ): void {
    if (actorRole === UserRoleType.ADMIN) {
      return; // Admin can inspect any seller's authorized analytics
    }

    if (authorizedSellerId !== targetSellerId) {
      throw new AppError(
        'غير مصرح لك بالوصول إلى بيانات متجر آخر.',
        403,
        'ANALYTICS_ACCESS_DENIED'
      );
    }
  }
}
