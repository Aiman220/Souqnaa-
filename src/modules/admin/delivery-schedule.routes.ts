/**
 * Admin delivery schedule routes.
 * Manages DeliveryTimeSlot + DeliveryScheduleRule CRUD and capacity dashboard.
 * All routes are protected by authenticate + requireAdmin (applied at parent router).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { deliverySlotService } from '../../services/delivery/delivery-slot.service';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/admin/delivery/schedule — List all time slots with their rules
// ──────────────────────────────────────────────────────────────────────────────

router.get('/schedule', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const slots = await prisma.deliveryTimeSlot.findMany({
      include: {
        rules: { orderBy: [{ dayOfWeek: 'asc' }] },
        _count: { select: { bookings: true } },
      },
      orderBy: { priority: 'asc' },
    });
    ResponseUtil.success(res, slots);
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/v1/admin/delivery/schedule — Create a new time slot + optional rules
// ──────────────────────────────────────────────────────────────────────────────

router.post('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      nameAr, nameEn, startTime, endTime, slotFee = 0,
      maxOrdersPerDay = 50, isActive = true, priority = 0,
      rules = [], // [{ dayOfWeek, minAdvanceHours, isActive }]
    } = req.body;

    if (!nameAr || !nameEn || !startTime || !endTime) {
      throw new AppError('nameAr, nameEn, startTime, and endTime are required', 400);
    }

    const slot = await prisma.deliveryTimeSlot.create({
      data: {
        nameAr, nameEn, startTime, endTime,
        slotFee: parseFloat(String(slotFee)),
        maxOrdersPerDay: parseInt(String(maxOrdersPerDay), 10),
        isActive,
        priority: parseInt(String(priority), 10),
        rules: {
          create: rules.map((r: any) => ({
            dayOfWeek: r.dayOfWeek ?? null,
            minAdvanceHours: parseFloat(String(r.minAdvanceHours ?? 1)),
            isActive: r.isActive ?? true,
          })),
        },
      },
      include: { rules: true },
    });

    ResponseUtil.success(res, slot, 'Time slot created');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/admin/delivery/schedule/:id — Update a time slot + replace rules
// ──────────────────────────────────────────────────────────────────────────────

router.put('/schedule/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const {
      nameAr, nameEn, startTime, endTime, slotFee,
      maxOrdersPerDay, isActive, priority, rules,
    } = req.body;

    const existing = await prisma.deliveryTimeSlot.findUnique({ where: { id } });
    if (!existing) throw new AppError('Time slot not found', 404);

    const updateData: any = {};
    if (nameAr !== undefined) updateData.nameAr = nameAr;
    if (nameEn !== undefined) updateData.nameEn = nameEn;
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (slotFee !== undefined) updateData.slotFee = parseFloat(String(slotFee));
    if (maxOrdersPerDay !== undefined) updateData.maxOrdersPerDay = parseInt(String(maxOrdersPerDay), 10);
    if (isActive !== undefined) updateData.isActive = isActive;
    if (priority !== undefined) updateData.priority = parseInt(String(priority), 10);

    // If rules array provided, replace all rules
    if (Array.isArray(rules)) {
      await prisma.deliveryScheduleRule.deleteMany({ where: { timeSlotId: id } });
      updateData.rules = {
        create: rules.map((r: any) => ({
          dayOfWeek: r.dayOfWeek ?? null,
          minAdvanceHours: parseFloat(String(r.minAdvanceHours ?? 1)),
          isActive: r.isActive ?? true,
        })),
      };
    }

    const slot = await prisma.deliveryTimeSlot.update({
      where: { id },
      data: updateData,
      include: { rules: true },
    });

    ResponseUtil.success(res, slot, 'Time slot updated');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/admin/delivery/schedule/:id — Soft deactivate a time slot
// ──────────────────────────────────────────────────────────────────────────────

router.delete('/schedule/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const slot = await prisma.deliveryTimeSlot.findUnique({ where: { id } });
    if (!slot) throw new AppError('Time slot not found', 404);

    await prisma.deliveryTimeSlot.update({
      where: { id },
      data: { isActive: false },
    });

    ResponseUtil.success(res, { id }, 'Time slot deactivated');
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/admin/delivery/capacity — Today's slot capacity dashboard
// ──────────────────────────────────────────────────────────────────────────────

router.get('/capacity', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const capacity = await deliverySlotService.getTodayCapacity();
    ResponseUtil.success(res, capacity);
  } catch (error) {
    next(error);
  }
});

export const adminDeliveryScheduleRoutes = router;
