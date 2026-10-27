/**
 * SOUQNAA Marketplace — Admin Seller Financial Risk & Reconciliation Routes
 * Authoritative financial risk control, reserve adjustment, debt reconciliation,
 * and restriction governance for authorized finance administrators.
 * Version: 2.1.0
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { SellerReserveService } from '../commission/seller-reserve.service';
import { SellerReconciliationService } from '../commission/seller-reconciliation.service';

const router = Router();

// Protect all routes with authentication and ADMIN role
router.use(authenticate);
router.use(requireAdmin);

// ── GET /dashboard ─────────────────────────────────────────────────────────────
router.get(
  '/dashboard',
  requirePermission('seller_financial_risk:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kpis = await SellerFinancialRiskService.getRiskDashboardKpis();
      res.json({
        success: true,
        data: kpis,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /sellers ───────────────────────────────────────────────────────────────
router.get(
  '/sellers',
  requirePermission('seller_financial_risk:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const tier = typeof req.query.tier === 'string' ? req.query.tier : undefined;
      const restrictedOnly = req.query.restricted === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

      const where: any = {};
      if (restrictedOnly) {
        where.isFinanciallyRestricted = true;
      }
      if (search) {
        where.OR = [
          { stores: { some: { name: { contains: search, mode: 'insensitive' } } } },
          { user: { firstName: { contains: search, mode: 'insensitive' } } },
          { user: { lastName: { contains: search, mode: 'insensitive' } } },
          { user: { phone: { contains: search } } },
        ];
      }

      const [total, sellers] = await Promise.all([
        prisma.seller.count({ where }),
        prisma.seller.findMany({
          where,
          include: {
            stores: { select: { id: true, name: true, logo: true } },
            user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
            balance: true,
            riskProfile: true,
            financialRestrictions: { where: { status: 'ACTIVE' } },
            _count: {
              select: {
                outstandings: { where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } } },
                reserveAllocations: { where: { status: 'RESERVED' } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      const mapped = sellers.map((s) => {
        const availableBalance = s.balance?.availableBalance ?? 0;
        const reservedBalance = s.riskProfile?.totalReservedBalance ?? 0;
        const withdrawableBalance = Math.max(0, availableBalance - reservedBalance);
        const outstandingCommission = s.balance?.outstandingCommission ?? 0;

        return {
          id: s.id,
          sellerId: s.id,
          storeName: s.stores[0]?.name || `${s.user?.firstName || ''} ${s.user?.lastName || ''}`.trim(),
          storeLogo: s.stores[0]?.logo || null,
          ownerName: `${s.user?.firstName || ''} ${s.user?.lastName || ''}`.trim(),
          phone: s.user?.phone,
          email: s.user?.email,
          status: s.status,
          isFinanciallyRestricted: s.isFinanciallyRestricted,
          financialRestrictionLevel: s.financialRestrictionLevel || 'NORMAL',
          financialRestrictionReason: s.financialRestrictionReason,
          riskTier: s.riskProfile?.riskTier || 'NORMAL',
          riskScore: s.riskProfile?.riskScore ?? 0,
          reservePercentage: s.riskProfile?.reservePercentage ?? 0.10,
          reserveHoldingDays: s.riskProfile?.reserveHoldingDays ?? 30,
          availableBalance,
          withdrawableBalance,
          reservedBalance,
          outstandingCommission,
          unsecuredExposure: s.riskProfile?.totalUnsecuredExposure ?? outstandingCommission,
          newOrdersPaused: s.riskProfile?.newOrdersPaused ?? false,
          withdrawalsRestricted: s.riskProfile?.withdrawalsRestricted ?? false,
          activeRestrictionsCount: s.financialRestrictions.length,
          openOutstandingsCount: s._count.outstandings,
          activeReservesCount: s._count.reserveAllocations,
          currency: s.balance?.currency || 'YER',
        };
      });

      // Filter by tier if specified in query
      const filtered = tier && tier !== 'ALL' ? mapped.filter((m) => m.riskTier === tier) : mapped;

      res.json({
        success: true,
        data: {
          items: filtered,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /sellers/:sellerId ─────────────────────────────────────────────────────
router.get(
  '/sellers/:sellerId',
  requirePermission('seller_financial_risk:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const standing = await SellerFinancialRiskService.getSellerFinancialStanding(sellerId);
      res.json({
        success: true,
        data: standing,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /sellers/:sellerId/adjust-reserve ──────────────────────────────────────
router.post(
  '/sellers/:sellerId/adjust-reserve',
  requirePermission('seller_reserve:adjust'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const { allocationId, action, extendDays, reservePercentage, reason } = req.body;
      const adminUserId = req.user!.userId;

      if (!reason || !reason.trim()) {
        throw new AppError('سبب تعديل الاحتياطي مطلوب إجبارياً للتدقيق المحاسبي', 400);
      }

      if (allocationId && action) {
        // Adjust existing allocation
        const result = await SellerReserveService.manualAdjustReserve(adminUserId, {
          allocationId,
          action,
          extendDays,
          reason,
        });
        return res.json({ success: true, data: result });
      }

      // Update baseline reserve percentage for seller risk profile
      if (reservePercentage !== undefined && reservePercentage >= 0 && reservePercentage <= 0.50) {
        const updatedProfile = await prisma.sellerRiskProfile.upsert({
          where: { sellerId },
          create: {
            sellerId,
            reservePercentage,
            evaluationNotes: `تعديل يدوي لنسبة الاحتياطي من قبل الإدارة: ${reason.trim()}`,
          },
          update: {
            reservePercentage,
            evaluationNotes: `تعديل يدوي لنسبة الاحتياطي من قبل الإدارة: ${reason.trim()}`,
            lastEvaluatedAt: new Date(),
          },
        });

        await prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'SELLER_RESERVE_PERCENTAGE_ADJUSTED',
            resource: 'sellers',
            details: JSON.stringify({
              sellerId,
              reservePercentage,
              reason: reason.trim(),
              adminUserId,
              timestamp: new Date().toISOString(),
            }),
          },
        });

        return res.json({ success: true, data: updatedProfile });
      }

      throw new AppError('معاملات تعديل الاحتياطي غير مكتملة', 400);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /sellers/:sellerId/restrictions ───────────────────────────────────────
router.post(
  '/sellers/:sellerId/restrictions',
  requirePermission('seller_financial_risk:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sellerId = String(req.params.sellerId);
      const { action, restrictionType = 'WITHDRAWAL_PAUSED', reason } = req.body;
      const adminUserId = req.user!.userId;

      if (!reason || !reason.trim()) {
        throw new AppError('سبب تعديل التقييد المالي مطلوب إجبارياً', 400);
      }

      if (action === 'LIFT') {
        const result = await SellerFinancialRiskService.manualAdminUnblock(adminUserId, sellerId, reason);
        return res.json({ success: true, data: result, message: 'تم رفع التقييد المالي بنجاح' });
      } else if (action === 'IMPOSE') {
        const result = await prisma.$transaction(async (tx) => {
          const seller = await tx.seller.update({
            where: { id: sellerId },
            data: {
              isFinanciallyRestricted: true,
              financialRestrictionReason: reason.trim(),
              financialRestrictedAt: new Date(),
              financialRestrictionLevel: 'RESTRICTED',
            },
          });

          await tx.financialRestriction.create({
            data: {
              sellerId,
              restrictionType: restrictionType as any,
              reasonCode: 'MANUAL_FINANCE_REVIEW',
              status: 'ACTIVE',
              metadata: JSON.stringify({ reason: reason.trim(), imposedByAdminId: adminUserId }),
            },
          });

          await tx.sellerRiskProfile.upsert({
            where: { sellerId },
            create: {
              sellerId,
              newOrdersPaused: restrictionType === 'NEW_ORDERS_PAUSED',
              withdrawalsRestricted: restrictionType === 'WITHDRAWAL_PAUSED',
            },
            update: {
              newOrdersPaused: restrictionType === 'NEW_ORDERS_PAUSED' ? true : undefined,
              withdrawalsRestricted: restrictionType === 'WITHDRAWAL_PAUSED' ? true : undefined,
            },
          });

          await tx.auditLog.create({
            data: {
              userId: adminUserId,
              action: 'SELLER_RESTRICTION_IMPOSED_MANUAL',
              resource: 'sellers',
              details: JSON.stringify({
                sellerId,
                restrictionType,
                reason: reason.trim(),
                adminUserId,
                timestamp: new Date().toISOString(),
              }),
            },
          });

          return seller;
        });

        return res.json({ success: true, data: result, message: 'تم فرض التقييد بنجاح' });
      }

      throw new AppError('نوع العملية غير صالح (مطلوب IMPOSE أو LIFT)', 400);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /reconciliation/run ───────────────────────────────────────────────────
router.post(
  '/reconciliation/run',
  requirePermission('seller_debt:reconcile'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminUserId = req.user!.userId;
      const summary = await SellerReconciliationService.runReconciliation(adminUserId);
      res.json({
        success: true,
        data: summary,
        message: `تم الانتهاء من فحص المطابقة المالية (${summary.totalSellersChecked} تاجر تم فحصهم)`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /reconciliation/runs ───────────────────────────────────────────────────
router.get(
  '/reconciliation/runs',
  requirePermission('seller_debt:reconcile'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;

      const [total, runs] = await Promise.all([
        prisma.reconciliationRun.count(),
        prisma.reconciliationRun.findMany({
          include: {
            _count: { select: { exceptions: true } },
          },
          orderBy: { startedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      res.json({
        success: true,
        data: {
          items: runs,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /reconciliation/runs/:runId/exceptions ─────────────────────────────────
router.get(
  '/reconciliation/runs/:runId/exceptions',
  requirePermission('seller_debt:reconcile'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runId = String(req.params.runId);
      const exceptions = await prisma.reconciliationException.findMany({
        where: { runId },
        orderBy: { severity: 'desc' },
      });
      res.json({
        success: true,
        data: exceptions,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /reconciliation/exceptions/:id/resolve ────────────────────────────────
router.post(
  '/reconciliation/exceptions/:id/resolve',
  requirePermission('seller_debt:reconcile'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const { resolutionNotes } = req.body;
      const adminUserId = req.user!.userId;

      const updated = await SellerReconciliationService.resolveException(
        adminUserId,
        id,
        resolutionNotes
      );
      res.json({
        success: true,
        data: updated,
        message: 'تم تسوية وتوثيق معالجة الفارق المالي بنجاح',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /reserves/process-releases ────────────────────────────────────────────
router.post(
  '/reserves/process-releases',
  requirePermission('seller_reserve:adjust'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminUserId = req.user!.userId;
      const result = await SellerReserveService.processEligibleReserveReleases(adminUserId);
      res.json({
        success: true,
        data: result,
        message: `تمت معالجة ${result.processedCount} احتياطيات منتهية فترة الحجز`,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
