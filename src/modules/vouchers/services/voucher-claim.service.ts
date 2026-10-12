import { prisma } from '../../../database/prisma';
import { VoucherErrorCode } from '../voucher.types';
import { VoucherValidationError } from './voucher-validation.service';

export class VoucherClaimService {
  /**
   * Concurrency-safe voucher claim operation.
   * Atomically checks global claim limit and per-customer claim limit.
   */
  public static async claimVoucher(params: {
    voucherId: string;
    customerId: string;
    claimSource?: string;
  }): Promise<any> {
    const { voucherId, customerId, claimSource = 'VOUCHER_CENTER' } = params;

    return await prisma.$transaction(async (tx) => {
      // 1. Fetch voucher safely inside transaction
      let voucher = await tx.voucher.findUnique({ where: { id: voucherId } });
      if (!voucher) {
        voucher = await tx.voucher.findFirst({
          where: { OR: [{ id: voucherId }, { normalizedCode: voucherId.toUpperCase() }, { code: voucherId }] },
        });
      }

      if (!voucher) {
        throw new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_FOUND);
      }

      const now = new Date();

      // Status check
      if (voucher.status !== 'ACTIVE') {
        throw new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_ACTIVE);
      }
      if (new Date(voucher.startAt) > now) {
        throw new VoucherValidationError(VoucherErrorCode.VOUCHER_NOT_STARTED);
      }
      if (new Date(voucher.endAt) < now) {
        throw new VoucherValidationError(VoucherErrorCode.VOUCHER_EXPIRED);
      }

      // Check customer claim count first
      const existingClaim = await tx.customerVoucher.findFirst({
        where: {
          voucherId,
          customerId,
        },
        include: {
          voucher: true,
        },
      });

      const perCustomerLimit = voucher.perCustomerClaimLimit || 1;
      if (existingClaim) {
        const existingClaimsCount = await tx.customerVoucher.count({
          where: {
            voucherId,
            customerId,
          },
        });
        if (existingClaimsCount >= perCustomerLimit) {
          // Graceful idempotent return: user already owns this voucher
          return existingClaim;
        }
      }

      // Check global claim limit
      if (voucher.claimLimit !== null && voucher.claimLimit !== undefined) {
        if (voucher.claimCount >= voucher.claimLimit) {
          // Mark as depleted if reached
          await tx.voucher.update({
            where: { id: voucherId },
            data: { status: 'DEPLETED' },
          });
          throw new VoucherValidationError(VoucherErrorCode.VOUCHER_CLAIM_LIMIT_REACHED);
        }
      }

      // Increment claimCount atomically
      await tx.voucher.update({
        where: { id: voucherId },
        data: {
          claimCount: { increment: 1 },
        },
      });

      // Create CustomerVoucher record
      const customerVoucher = await tx.customerVoucher.create({
        data: {
          customerId,
          voucherId,
          status: 'CLAIMED',
          claimedAt: now,
          expiresAt: voucher.endAt,
          claimSource,
        },
        include: {
          voucher: true,
        },
      });

      return customerVoucher;
    });
  }

  /**
   * Get all vouchers claimed by customer with tabs
   */
  public static async getCustomerVouchers(customerId: string, tab?: string) {
    const now = new Date();
    const whereClause: any = { customerId };

    if (tab === 'COLLECTED' || tab === 'AVAILABLE') {
      whereClause.status = 'CLAIMED';
      whereClause.expiresAt = { gt: now };
    } else if (tab === 'EXPIRING_SOON') {
      const soon = new Date(now.getTime() + 48 * 3600 * 1000); // within 48 hours
      whereClause.status = 'CLAIMED';
      whereClause.expiresAt = { gt: now, lte: soon };
    } else if (tab === 'USED') {
      whereClause.status = 'USED';
    } else if (tab === 'EXPIRED') {
      whereClause.OR = [{ status: 'EXPIRED' }, { expiresAt: { lte: now } }];
    }

    return await prisma.customerVoucher.findMany({
      where: whereClause,
      include: {
        voucher: {
          include: {
            products: true,
            categories: true,
            seller: { include: { stores: true } },
          },
        },
      },
      orderBy: { claimedAt: 'desc' },
    });
  }
}
