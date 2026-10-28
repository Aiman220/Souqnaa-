import { Request, Response, NextFunction } from 'express';
import { MembershipEligibilityService } from './membership-eligibility.service';
import { MembershipCacheService } from './membership-cache.service';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

export class CustomerMembershipController {
  /**
   * GET /api/v1/customers/me/membership
   * Returns authoritative customer membership summary with tier, badge, perks, metrics, and next-tier progress.
   */
  public static async getMyMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Authentication required', 401);
      }

      if (req.query.refresh === 'true') {
        await MembershipCacheService.invalidateCustomer(userId);
      }

      const summary = await MembershipEligibilityService.getCustomerSummary(userId);
      ResponseUtil.success(res, summary, 'Customer membership retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/membership/progress
   * Returns next-tier progress calculations only (lightweight).
   */
  public static async getMyProgress(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Authentication required', 401);
      }

      const summary = await MembershipEligibilityService.getCustomerSummary(userId);
      ResponseUtil.success(res, summary.progress, 'Membership progress retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/membership/benefits
   * Returns current tier perks & benefits.
   */
  public static async getMyBenefits(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Authentication required', 401);
      }

      const summary = await MembershipEligibilityService.getCustomerSummary(userId);
      ResponseUtil.success(
        res,
        {
          tierCode: summary.tierCode,
          tierNameAr: summary.tierNameAr,
          tierNameEn: summary.tierNameEn,
          level: summary.level,
          benefits: summary.benefits,
        },
        'Membership benefits retrieved successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/membership/tiers
   * Returns all active tiers catalogue so customers can view what tiers and perks exist in the program.
   */
  public static async getTiersCatalogue(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tiers = await MembershipEligibilityService.getActiveTiersDescending();
      const sanitized = tiers
        .slice()
        .reverse() // Sort from level 0 upwards
        .map((t) => {
          let benefits = { perks: [], perksAr: [] };
          let rules = { logic: 'ALL', rules: [] };
          try {
            benefits = JSON.parse(t.benefitConfiguration);
          } catch (_) {}
          try {
            rules = JSON.parse(t.qualificationRules);
          } catch (_) {}

          return {
            id: t.id,
            code: t.code,
            nameAr: t.nameAr,
            nameEn: t.nameEn,
            descriptionAr: t.descriptionAr,
            descriptionEn: t.descriptionEn,
            level: t.level,
            icon: t.icon,
            badgeAssetUrl: t.badgeAssetUrl,
            benefits,
            qualificationRules: rules,
          };
        });

      ResponseUtil.success(res, sanitized, 'Tiers catalogue retrieved successfully');
    } catch (err) {
      next(err);
    }
  }
}
