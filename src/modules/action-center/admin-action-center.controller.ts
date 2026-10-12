import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

export class AdminActionCenterController {
  public static async getAnnouncements(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string, 10) || 20));
      const skip = (page - 1) * limit;

      const [total, items] = await Promise.all([
        prisma.customerActionAnnouncement.count(),
        prisma.customerActionAnnouncement.findMany({
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
      ]);

      ResponseUtil.success(res, {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  public static async createAnnouncement(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const adminId = req.user?.userId;
      const {
        titleAr,
        titleEn,
        descriptionAr,
        descriptionEn,
        category,
        priority,
        ctaLabelAr,
        ctaLabelEn,
        deepLink,
        icon,
        imageUrl,
        targetTier,
        targetSegment,
        isActive,
        startsAt,
        expiresAt,
        dismissible,
        snoozable,
      } = req.body;

      if (!titleAr || !titleEn || !descriptionAr || !descriptionEn) {
        throw new AppError('Title and description in both Arabic and English are required', 400);
      }

      const announcement = await prisma.customerActionAnnouncement.create({
        data: {
          titleAr,
          titleEn,
          descriptionAr,
          descriptionEn,
          category: category || 'PLATFORM',
          priority: priority || 'MEDIUM',
          ctaLabelAr,
          ctaLabelEn,
          deepLink: deepLink || '/home',
          icon: icon || 'campaign',
          imageUrl,
          targetTier,
          targetSegment,
          isActive: isActive !== undefined ? Boolean(isActive) : true,
          startsAt: startsAt ? new Date(startsAt) : new Date(),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          dismissible: dismissible !== undefined ? Boolean(dismissible) : true,
          snoozable: snoozable !== undefined ? Boolean(snoozable) : true,
        },
      });

      // Audit log
      if (adminId) {
        await prisma.auditLog.create({
          data: {
            userId: adminId,
            action: 'ACTION_ANNOUNCEMENT_CREATED',
            resource: 'customer_action_announcements',
            details: JSON.stringify({ announcementId: announcement.id, titleAr }),
          },
        });
      }

      ResponseUtil.success(res, announcement, 'Announcement created successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async updateAnnouncement(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const adminId = req.user?.userId;
      const id = String(req.params.id);

      const existing = await prisma.customerActionAnnouncement.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new AppError('Announcement not found', 404);
      }

      const updated = await prisma.customerActionAnnouncement.update({
        where: { id },
        data: {
          ...req.body,
          startsAt: req.body.startsAt ? new Date(req.body.startsAt) : undefined,
          expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
        },
      });

      // Audit log
      if (adminId) {
        await prisma.auditLog.create({
          data: {
            userId: adminId,
            action: 'ACTION_ANNOUNCEMENT_UPDATED',
            resource: 'customer_action_announcements',
            details: JSON.stringify({
              announcementId: id,
              previous: { isActive: existing.isActive, priority: existing.priority },
              updated: { isActive: updated.isActive, priority: updated.priority },
            }),
          },
        });
      }

      ResponseUtil.success(res, updated, 'Announcement updated successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async deleteAnnouncement(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const adminId = req.user?.userId;
      const id = String(req.params.id);

      await prisma.customerActionAnnouncement.delete({ where: { id } });

      if (adminId) {
        await prisma.auditLog.create({
          data: {
            userId: adminId,
            action: 'ACTION_ANNOUNCEMENT_DELETED',
            resource: 'customer_action_announcements',
            details: JSON.stringify({ announcementId: id }),
          },
        });
      }

      ResponseUtil.success(res, { deleted: true }, 'Announcement deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  public static async getAnalytics(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const [totalAnnouncements, activeAnnouncements, totalDismissals, totalSnoozes] =
        await Promise.all([
          prisma.customerActionAnnouncement.count(),
          prisma.customerActionAnnouncement.count({ where: { isActive: true } }),
          prisma.customerActionDismissal.count({ where: { snoozedUntil: null } }),
          prisma.customerActionDismissal.count({ where: { snoozedUntil: { not: null } } }),
        ]);

      ResponseUtil.success(res, {
        totalAnnouncements,
        activeAnnouncements,
        totalDismissals,
        totalSnoozes,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
}
