import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { MembershipEligibilityService } from './membership-eligibility.service';
import { MembershipCacheService } from './membership-cache.service';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

export class AdminMembershipController {
  /**
   * GET /api/v1/admin/membership/tiers
   * List all configured tiers with active customer counts.
   */
  public static async listTiers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tiers = await prisma.membershipTier.findMany({
        orderBy: [{ level: 'asc' }, { priority: 'asc' }],
        include: {
          _count: {
            select: { memberships: true },
          },
        },
      });

      const formatted = tiers.map((t) => {
        let rules = { logic: 'ALL', rules: [] };
        let benefits = { perks: [], perksAr: [] };
        let validity = { periodType: 'ROLLING_DAYS', days: 365, gracePeriodDays: 30 };
        try {
          rules = JSON.parse(t.qualificationRules);
        } catch (_) {}
        try {
          benefits = JSON.parse(t.benefitConfiguration);
        } catch (_) {}
        try {
          if (t.validityConfiguration) validity = JSON.parse(t.validityConfiguration);
        } catch (_) {}

        return {
          id: t.id,
          code: t.code,
          nameAr: t.nameAr,
          nameEn: t.nameEn,
          descriptionAr: t.descriptionAr,
          descriptionEn: t.descriptionEn,
          level: t.level,
          priority: t.priority,
          isActive: t.isActive,
          icon: t.icon,
          badgeAssetUrl: t.badgeAssetUrl,
          qualificationRules: rules,
          benefitConfiguration: benefits,
          validityConfiguration: validity,
          memberCount: t._count.memberships,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        };
      });

      ResponseUtil.success(res, formatted, 'Membership tiers retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/membership/tiers
   * Create a new tier (Admin can create future tiers without code changes).
   */
  public static async createTier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        code,
        nameAr,
        nameEn,
        descriptionAr,
        descriptionEn,
        level,
        priority,
        isActive,
        icon,
        badgeAssetUrl,
        qualificationRules,
        benefitConfiguration,
        validityConfiguration,
      } = req.body;

      if (!code || !nameAr || !nameEn || level === undefined) {
        throw new AppError('Code, nameAr, nameEn, and level are required', 400);
      }

      const existing = await prisma.membershipTier.findUnique({
        where: { code: String(code).toUpperCase().trim() },
      });
      if (existing) {
        throw new AppError(`A tier with code ${code} already exists`, 409);
      }

      const tier = await prisma.membershipTier.create({
        data: {
          code: String(code).toUpperCase().trim(),
          nameAr: String(nameAr).trim(),
          nameEn: String(nameEn).trim(),
          descriptionAr: descriptionAr ? String(descriptionAr).trim() : null,
          descriptionEn: descriptionEn ? String(descriptionEn).trim() : null,
          level: Number(level),
          priority: Number(priority || 0),
          isActive: isActive !== false,
          icon: icon || 'crown',
          badgeAssetUrl: badgeAssetUrl || null,
          qualificationRules: typeof qualificationRules === 'object' ? JSON.stringify(qualificationRules) : qualificationRules || '{"logic":"ALL","rules":[]}',
          benefitConfiguration: typeof benefitConfiguration === 'object' ? JSON.stringify(benefitConfiguration) : benefitConfiguration || '{"perks":[],"perksAr":[]}',
          validityConfiguration: typeof validityConfiguration === 'object' ? JSON.stringify(validityConfiguration) : validityConfiguration || null,
        },
      });

      await MembershipCacheService.invalidateTiers();
      ResponseUtil.success(res, tier, 'Tier created successfully', 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/v1/admin/membership/tiers/:id
   * Update an existing tier.
   */
  public static async updateTier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id);
      const {
        nameAr,
        nameEn,
        descriptionAr,
        descriptionEn,
        level,
        priority,
        isActive,
        icon,
        badgeAssetUrl,
        qualificationRules,
        benefitConfiguration,
        validityConfiguration,
      } = req.body;

      const existing = await prisma.membershipTier.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError('Membership tier not found', 404);
      }

      const dataToUpdate: any = {};
      if (nameAr !== undefined) dataToUpdate.nameAr = String(nameAr).trim();
      if (nameEn !== undefined) dataToUpdate.nameEn = String(nameEn).trim();
      if (descriptionAr !== undefined) dataToUpdate.descriptionAr = descriptionAr;
      if (descriptionEn !== undefined) dataToUpdate.descriptionEn = descriptionEn;
      if (level !== undefined) dataToUpdate.level = Number(level);
      if (priority !== undefined) dataToUpdate.priority = Number(priority);
      if (isActive !== undefined) dataToUpdate.isActive = Boolean(isActive);
      if (icon !== undefined) dataToUpdate.icon = icon;
      if (badgeAssetUrl !== undefined) dataToUpdate.badgeAssetUrl = badgeAssetUrl;
      if (qualificationRules !== undefined) {
        dataToUpdate.qualificationRules = typeof qualificationRules === 'object' ? JSON.stringify(qualificationRules) : qualificationRules;
      }
      if (benefitConfiguration !== undefined) {
        dataToUpdate.benefitConfiguration = typeof benefitConfiguration === 'object' ? JSON.stringify(benefitConfiguration) : benefitConfiguration;
      }
      if (validityConfiguration !== undefined) {
        dataToUpdate.validityConfiguration = typeof validityConfiguration === 'object' ? JSON.stringify(validityConfiguration) : validityConfiguration;
      }

      const updated = await prisma.membershipTier.update({
        where: { id },
        data: dataToUpdate,
      });

      await MembershipCacheService.invalidateTiers();
      ResponseUtil.success(res, updated, 'Tier updated successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/membership/tiers/:id
   * Deactivate or delete tier if no active members.
   */
  public static async deleteTier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id);
      const existing = await prisma.membershipTier.findUnique({
        where: { id },
        include: { memberships: { select: { id: true }, take: 1 } },
      });

      if (!existing) {
        throw new AppError('Membership tier not found', 404);
      }

      if (existing.memberships.length > 0) {
        // Soft delete / deactivate
        await prisma.membershipTier.update({
          where: { id },
          data: { isActive: false },
        });
        await MembershipCacheService.invalidateTiers();
        ResponseUtil.success(res, { deactivated: true }, 'Tier contains active members, so it was marked inactive.');
        return;
      }

      await prisma.membershipTier.delete({ where: { id } });
      await MembershipCacheService.invalidateTiers();
      ResponseUtil.success(res, { deleted: true }, 'Tier deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/membership/customers
   * Search customers with membership tier, metrics, spend, completed orders, and override status.
   */
  public static async listCustomers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page = '1', limit = '20', tierId, search, status } = req.query;
      const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
      const take = Math.min(100, Math.max(1, Number(limit)));

      const where: any = {};
      if (tierId) where.tierId = String(tierId);
      if (status) where.status = String(status);

      if (search) {
        const s = String(search).trim();
        where.user = {
          OR: [
            { firstName: { contains: s, mode: 'insensitive' } },
            { lastName: { contains: s, mode: 'insensitive' } },
            { email: { contains: s, mode: 'insensitive' } },
            { phone: { contains: s } },
          ],
        };
      }

      // Automatically ensure customers have memberships if any unassigned customers exist
      const unassigned = await prisma.user.findMany({
        where: {
          role: 'CUSTOMER',
          membership: null,
        },
        select: { id: true },
        take: 50,
      });

      if (unassigned.length > 0) {
        for (const u of unassigned) {
          try {
            await MembershipEligibilityService.getOrCreateMembership(u.id);
          } catch (_) {}
        }
      }

      const [memberships, total] = await Promise.all([
        prisma.customerMembership.findMany({
          where,
          skip,
          take,
          orderBy: { lifetimeSpend: 'desc' },
          include: {
            tier: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                avatar: true,
                createdAt: true,
              },
            },
            overrides: {
              where: { isActive: true },
              include: { overrideTier: true },
              take: 1,
            },
          },
        }),
        prisma.customerMembership.count({ where }),
      ]);

      const formatted = memberships.map((m) => {
        const customerName = `${m.user.firstName || ''} ${m.user.lastName || ''}`.trim() || m.user.email || m.user.phone || m.userId;
        const activeOverride = m.overrides[0]
          ? {
              id: m.overrides[0].id,
              overrideTierId: m.overrides[0].overrideTierId,
              overrideTierCode: m.overrides[0].overrideTier?.code || '',
              overrideTierNameAr: m.overrides[0].overrideTier?.nameAr || '',
              overrideTierNameEn: m.overrides[0].overrideTier?.nameEn || '',
              reason: m.overrides[0].reason,
              endAt: m.overrides[0].endAt ? m.overrides[0].endAt.toISOString() : null,
              createdAt: m.overrides[0].createdAt ? m.overrides[0].createdAt.toISOString() : null,
            }
          : null;

        return {
          id: m.id,
          userId: m.userId,
          customerId: m.userId,
          customerName,
          email: m.user.email,
          phone: m.user.phone,
          avatar: m.user.avatar,
          registeredAt: m.user.createdAt.toISOString(),
          tierCode: m.tier.code,
          tierNameAr: m.tier.nameAr,
          tierNameEn: m.tier.nameEn,
          tierLevel: m.tier.level,
          status: m.status,
          lifetimeSpend: Number(m.lifetimeSpend || 0),
          periodSpend: Number(m.periodSpend || 0),
          completedOrders: Number(m.completedOrders || 0),
          periodCompletedOrders: Number(m.periodCompletedOrders || 0),
          pointsBalance: Number(m.pointsBalance || 0),
          lastEvaluatedAt: m.lastEvaluatedAt ? m.lastEvaluatedAt.toISOString() : null,
          customer: {
            id: m.user.id,
            firstName: m.user.firstName,
            lastName: m.user.lastName,
            email: m.user.email,
            phone: m.user.phone,
            avatar: m.user.avatar,
          },
          tier: {
            id: m.tier.id,
            code: m.tier.code,
            nameAr: m.tier.nameAr,
            nameEn: m.tier.nameEn,
            level: m.tier.level,
            priority: m.tier.priority,
            isActive: m.tier.isActive,
          },
          override: activeOverride,
          activeOverride,
        };
      });

      ResponseUtil.paginated(res, formatted, total, Number(page), take);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/membership/customers/:userId/override
   * Apply explicit manual override for a customer with mandatory reason and audit log.
   */
  public static async applyOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = String(req.params.userId);
      const { reason, endAt } = req.body;
      const overrideTierId = req.body.overrideTierId || req.body.tierId;
      const adminId = req.user?.userId || 'SYSTEM_ADMIN';

      if (!overrideTierId || !reason || String(reason).trim().length < 3) {
        throw new AppError('overrideTierId and a descriptive reason (at least 3 characters) are required', 400);
      }

      const override = await MembershipEligibilityService.applyOverride({
        userId,
        overrideTierId,
        reason: String(reason).trim(),
        endAt: endAt ? new Date(endAt) : null,
        adminId,
      });

      ResponseUtil.success(res, override, 'Manual membership override applied successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/membership/customers/:userId/override
   * Remove manual override and return customer to automatic rule evaluation.
   */
  public static async removeOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = String(req.params.userId);
      const adminId = req.user?.userId || 'SYSTEM_ADMIN';

      await MembershipEligibilityService.removeOverride({ userId, adminId });
      ResponseUtil.success(res, { removed: true }, 'Manual override removed; customer returned to automatic evaluation');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/membership/customers/:userId/evaluate
   * Force server-side re-evaluation of customer tier.
   */
  public static async evaluateCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = String(req.params.userId);
      const adminId = req.user?.userId || 'SYSTEM_ADMIN';

      const result = await MembershipEligibilityService.evaluateCustomerTier(userId, {
        forceAuthoritativeRecalculation: true,
        actorId: adminId,
        correlationId: `admin_force_eval_${Date.now()}`,
      });

      ResponseUtil.success(res, result, 'Customer membership evaluated successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/membership/customers/:userId/suspend
   */
  public static async suspendCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = String(req.params.userId);
      const { reason } = req.body;
      const adminId = req.user?.userId || 'SYSTEM_ADMIN';

      if (!reason || String(reason).trim().length < 3) {
        throw new AppError('Suspension reason is required', 400);
      }

      const updated = await MembershipEligibilityService.suspendMembership({
        userId,
        reason: String(reason).trim(),
        adminId,
      });

      ResponseUtil.success(res, updated, 'Customer membership suspended successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/membership/customers/:userId/restore
   */
  public static async restoreCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = String(req.params.userId);
      const adminId = req.user?.userId || 'SYSTEM_ADMIN';

      const updated = await MembershipEligibilityService.restoreMembership({
        userId,
        adminId,
      });

      ResponseUtil.success(res, updated, 'Customer membership restored successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/membership/analytics
   * Aggregated membership dashboard analytics:
   * Total members, distribution by tier, revenue by tier, average order value, upgrade counts.
   */
  public static async getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tiers = await prisma.membershipTier.findMany({
        orderBy: { level: 'asc' },
        include: {
          memberships: {
            select: {
              status: true,
              lifetimeSpend: true,
              completedOrders: true,
              pointsBalance: true,
            },
          },
        },
      });

      let totalMembers = 0;
      let activeMembers = 0;
      let vipMembers = 0;
      let vipPlusMembers = 0;
      let totalPlatformMembershipSpend = 0;
      let totalPlatformOrders = 0;
      let activeSuspensions = 0;
      const tierDistribution: Record<string, number> = {};

      const tierBreakdown = tiers.map((t) => {
        const count = t.memberships.length;
        const activeCount = t.memberships.filter((m) => m.status === 'ACTIVE').length;
        const totalSpend = t.memberships.reduce((acc, m) => acc + (m.lifetimeSpend || 0), 0);
        const totalOrders = t.memberships.reduce((acc, m) => acc + (m.completedOrders || 0), 0);
        const averageOrderValue = totalOrders > 0 ? Math.round(totalSpend / totalOrders) : 0;
        const suspendedCount = t.memberships.filter((m) => m.status === 'SUSPENDED').length;

        totalMembers += count;
        activeMembers += activeCount;
        activeSuspensions += suspendedCount;
        totalPlatformMembershipSpend += totalSpend;
        totalPlatformOrders += totalOrders;
        tierDistribution[t.code] = count;

        if (t.level === 3) vipMembers += count;
        if (t.level >= 4) vipPlusMembers += count;

        return {
          tierId: t.id,
          tierCode: t.code,
          nameAr: t.nameAr,
          nameEn: t.nameEn,
          level: t.level,
          memberCount: count,
          activeCount,
          totalSpend: Math.round(totalSpend * 100) / 100,
          totalOrders,
          averageOrderValue,
        };
      });

      // Recent Upgrades & Changes
      const recentUpgradesCount = await prisma.membershipAuditLog.count({
        where: { changeType: 'UPGRADE' },
      });
      const recentDowngradesCount = await prisma.membershipAuditLog.count({
        where: { changeType: 'DOWNGRADE' },
      });

      const averageSpend = totalMembers > 0 ? Math.round((totalPlatformMembershipSpend / totalMembers) * 100) / 100 : 0;

      const analytics = {
        totalMembers,
        activeMembers,
        vipMembers,
        vipPlusMembers,
        totalSpend: Math.round(totalPlatformMembershipSpend * 100) / 100,
        averageSpend,
        totalOrders: totalPlatformOrders,
        recentUpgrades: recentUpgradesCount,
        recentDowngrades: recentDowngradesCount,
        activeSuspensions,
        tierDistribution,
        summary: {
          totalMembers,
          activeMembers,
          totalRevenueFromMembers: Math.round(totalPlatformMembershipSpend * 100) / 100,
          totalUpgrades: recentUpgradesCount,
          totalDowngrades: recentDowngradesCount,
        },
        tierBreakdown,
      };

      ResponseUtil.success(res, analytics, 'Membership analytics retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/membership/audit-logs
   * View paginated audit logs.
   */
  public static async listAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page = '1', limit = '25', userId, changeType } = req.query;
      const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
      const take = Math.min(100, Math.max(1, Number(limit)));

      const where: any = {};
      if (userId) where.userId = String(userId);
      if (changeType) where.changeType = changeType as any;

      const [logs, total] = await Promise.all([
        prisma.membershipAuditLog.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                email: true,
              },
            },
            previousTier: { select: { code: true, nameEn: true } },
            newTier: { select: { code: true, nameEn: true } },
          },
        }),
        prisma.membershipAuditLog.count({ where }),
      ]);

      const formatted = logs.map((l) => ({
        id: l.id,
        userId: l.userId,
        customerId: l.userId,
        customerName: `${l.user.firstName || ''} ${l.user.lastName || ''}`.trim() || l.user.email || l.userId,
        customerEmail: l.user.email,
        actorId: l.actorId,
        actorRole: l.actorRole,
        changeType: l.changeType,
        previousTier: l.previousTier?.code || null,
        oldTierCode: l.previousTier?.code || null,
        newTier: l.newTier.code,
        newTierCode: l.newTier.code,
        reason: l.reason,
        correlationId: l.correlationId,
        createdAt: l.createdAt.toISOString(),
      }));

      ResponseUtil.paginated(res, formatted, total, Number(page), take);
    } catch (err) {
      next(err);
    }
  }
}
