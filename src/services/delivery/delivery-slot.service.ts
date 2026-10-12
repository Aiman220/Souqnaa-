/**
 * DeliverySlotService — manages delivery time-slot scheduling.
 *
 * §SCHED-1: Backend is authoritative for available dates and slot availability.
 * §SCHED-2: Slot capacity is enforced atomically; never trust client counts.
 * §SCHED-3: A cancelled order releases its slot booking. Idempotent.
 */

import { prisma } from '../../database/prisma';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface AvailableDate {
  date: string;        // ISO date string YYYY-MM-DD
  label: string;       // "اليوم" | "غداً" | "الثلاثاء 2 سبتمبر"
  dayOfWeek: number;   // 0=Sun … 6=Sat
  hasSlots: boolean;
}

export interface SlotAvailability {
  id: string;
  nameAr: string;
  nameEn: string;
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm
  slotFee: number;
  maxOrdersPerDay: number;
  booked: number;
  available: number;
  isFull: boolean;
  minAdvanceHours: number;
  isAvailableNow: boolean;
}

export interface SlotValidationResult {
  valid: boolean;
  isFull: boolean;
  booked: number;
  maxOrders: number;
  reason?: 'SLOT_FULL' | 'SLOT_NOT_FOUND' | 'SLOT_INACTIVE' | 'ADVANCE_TIME_NOT_MET' | 'DAY_NOT_ALLOWED';
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function toDateOnlyISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toStartOfDay(isoDateStr: string): Date {
  return new Date(`${isoDateStr}T00:00:00.000Z`);
}

const ARABIC_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const ARABIC_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

function formatDateLabel(date: Date, index: number): string {
  if (index === 0) return 'اليوم';
  if (index === 1) return 'غداً';
  const day = ARABIC_DAYS[date.getUTCDay()];
  const d = date.getUTCDate();
  const month = ARABIC_MONTHS[date.getUTCMonth()];
  return `${day} ${d} ${month}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

export class DeliverySlotService {
  /**
   * Returns an array of schedulable delivery dates.
   * §SCHED-1: Uses schedulingAdvanceDays from DeliverySettings.
   */
  async getAvailableDates(daysAhead?: number): Promise<AvailableDate[]> {
    const settings = await prisma.deliverySettings.findFirst();
    const advanceDays = daysAhead ?? settings?.schedulingAdvanceDays ?? 7;

    const slots = await prisma.deliveryTimeSlot.findMany({
      where: { isActive: true },
      include: { rules: { where: { isActive: true } } },
    });

    const today = new Date();
    const results: AvailableDate[] = [];

    for (let i = 0; i < advanceDays; i++) {
      const d = new Date(today);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(today.getUTCDate() + i);
      const dayOfWeek = d.getUTCDay();
      const dateStr = toDateOnlyISO(d);

      const hasSlots = slots.some((slot) => {
        const rule =
          slot.rules.find((r) => r.dayOfWeek === dayOfWeek) ??
          slot.rules.find((r) => r.dayOfWeek === null);
        if (!rule) return false;
        if (i === 0) {
          const [h, m] = slot.startTime.split(':').map(Number);
          const slotStart = new Date(d);
          slotStart.setUTCHours(h, m, 0, 0);
          const minAdvanceMs = (rule.minAdvanceHours ?? 1) * 60 * 60 * 1000;
          return Date.now() + minAdvanceMs <= slotStart.getTime();
        }
        return true;
      });

      results.push({ date: dateStr, label: formatDateLabel(d, i), dayOfWeek, hasSlots });
    }

    return results;
  }

  /**
   * Returns active slots for a given date with real-time booked counts.
   */
  async getSlotsForDate(dateStr: string): Promise<SlotAvailability[]> {
    const deliveryDate = toStartOfDay(dateStr);
    const dayOfWeek = deliveryDate.getUTCDay();
    const isToday = toDateOnlyISO(new Date()) === dateStr;
    const nextDay = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);

    const slots = await prisma.deliveryTimeSlot.findMany({
      where: { isActive: true },
      include: {
        rules: { where: { isActive: true } },
        bookings: { where: { deliveryDate: { gte: deliveryDate, lt: nextDay } } },
      },
      orderBy: { priority: 'asc' },
    });

    const result: SlotAvailability[] = [];

    for (const slot of slots) {
      const rule =
        slot.rules.find((r) => r.dayOfWeek === dayOfWeek) ??
        slot.rules.find((r) => r.dayOfWeek === null);
      if (!rule) continue;

      const minAdvanceHours = rule.minAdvanceHours ?? 1;
      let isAvailableNow = true;

      if (isToday) {
        const [h, m] = slot.startTime.split(':').map(Number);
        const slotStart = new Date(deliveryDate);
        slotStart.setUTCHours(h, m, 0, 0);
        const minAdvanceMs = minAdvanceHours * 60 * 60 * 1000;
        isAvailableNow = Date.now() + minAdvanceMs <= slotStart.getTime();
      }

      const booked = slot.bookings.length;
      const available = Math.max(0, slot.maxOrdersPerDay - booked);

      result.push({
        id: slot.id,
        nameAr: slot.nameAr,
        nameEn: slot.nameEn,
        startTime: slot.startTime,
        endTime: slot.endTime,
        slotFee: slot.slotFee,
        maxOrdersPerDay: slot.maxOrdersPerDay,
        booked,
        available,
        isFull: available === 0,
        minAdvanceHours,
        isAvailableNow,
      });
    }

    return result;
  }

  /**
   * Validate a slot without reserving it.
   */
  async validateSlot(timeSlotId: string, dateStr: string): Promise<SlotValidationResult> {
    const deliveryDate = toStartOfDay(dateStr);
    const dayOfWeek = deliveryDate.getUTCDay();
    const nextDay = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);

    const slot = await prisma.deliveryTimeSlot.findUnique({
      where: { id: timeSlotId },
      include: {
        rules: { where: { isActive: true } },
        bookings: { where: { deliveryDate: { gte: deliveryDate, lt: nextDay } } },
      },
    });

    if (!slot) return { valid: false, isFull: false, booked: 0, maxOrders: 0, reason: 'SLOT_NOT_FOUND' };
    if (!slot.isActive) return { valid: false, isFull: false, booked: slot.bookings.length, maxOrders: slot.maxOrdersPerDay, reason: 'SLOT_INACTIVE' };

    const rule =
      slot.rules.find((r) => r.dayOfWeek === dayOfWeek) ??
      slot.rules.find((r) => r.dayOfWeek === null);
    if (!rule) return { valid: false, isFull: false, booked: slot.bookings.length, maxOrders: slot.maxOrdersPerDay, reason: 'DAY_NOT_ALLOWED' };

    const isToday = toDateOnlyISO(new Date()) === dateStr;
    if (isToday) {
      const [h, m] = slot.startTime.split(':').map(Number);
      const slotStart = new Date(deliveryDate);
      slotStart.setUTCHours(h, m, 0, 0);
      const minAdvanceMs = (rule.minAdvanceHours ?? 1) * 60 * 60 * 1000;
      if (Date.now() + minAdvanceMs > slotStart.getTime()) {
        return { valid: false, isFull: false, booked: slot.bookings.length, maxOrders: slot.maxOrdersPerDay, reason: 'ADVANCE_TIME_NOT_MET' };
      }
    }

    const booked = slot.bookings.length;
    const isFull = booked >= slot.maxOrdersPerDay;
    return { valid: !isFull, isFull, booked, maxOrders: slot.maxOrdersPerDay, reason: isFull ? 'SLOT_FULL' : undefined };
  }

  /**
   * Reserve a slot for an order using Serializable transaction + FOR UPDATE lock.
   * §SCHED-2: Prevents overbooking under high concurrency.
   */
  async reserveSlot(orderId: string, timeSlotId: string, dateStr: string): Promise<void> {
    const deliveryDate = toStartOfDay(dateStr);
    const nextDay = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Lock the slot row to serialize concurrent bookings
      await tx.$queryRaw`
        SELECT id FROM "DeliveryTimeSlot"
        WHERE id = ${timeSlotId}
        FOR UPDATE
      `;

      const slot = await tx.deliveryTimeSlot.findUnique({
        where: { id: timeSlotId },
        select: { maxOrdersPerDay: true, isActive: true },
      });

      if (!slot || !slot.isActive) {
        const err: any = new Error('Time slot not found or inactive');
        err.statusCode = 400;
        err.code = 'SLOT_NOT_FOUND';
        throw err;
      }

      const bookedCount = await tx.deliverySlotBooking.count({
        where: { timeSlotId, deliveryDate: { gte: deliveryDate, lt: nextDay } },
      });

      if (bookedCount >= slot.maxOrdersPerDay) {
        const err: any = new Error('الموعد المحدد ممتلئ. يرجى اختيار موعد آخر.');
        err.statusCode = 409;
        err.code = 'SLOT_FULL';
        throw err;
      }

      await tx.deliverySlotBooking.create({
        data: { orderId, timeSlotId, deliveryDate },
      });
    }, { timeout: 10_000, isolationLevel: 'Serializable' });
  }

  /**
   * Release a slot booking on order cancellation.
   * §SCHED-3: Idempotent — safe to call multiple times.
   */
  async releaseSlot(orderId: string): Promise<void> {
    try {
      await prisma.deliverySlotBooking.delete({ where: { orderId } });
    } catch (err: any) {
      if (err?.code !== 'P2025') throw err; // P2025 = not found, already released
    }
  }

  /**
   * Admin capacity dashboard — today's booking counts per slot.
   */
  async getTodayCapacity() {
    const todayStr = toDateOnlyISO(new Date());
    const deliveryDate = toStartOfDay(todayStr);
    const nextDay = new Date(deliveryDate.getTime() + 24 * 60 * 60 * 1000);

    const slots = await prisma.deliveryTimeSlot.findMany({
      where: { isActive: true },
      include: {
        bookings: { where: { deliveryDate: { gte: deliveryDate, lt: nextDay } } },
      },
      orderBy: { priority: 'asc' },
    });

    return slots.map((s) => ({
      slot: { id: s.id, nameAr: s.nameAr, startTime: s.startTime, endTime: s.endTime, maxOrdersPerDay: s.maxOrdersPerDay },
      booked: s.bookings.length,
      available: Math.max(0, s.maxOrdersPerDay - s.bookings.length),
      isFull: s.bookings.length >= s.maxOrdersPerDay,
    }));
  }
}

export const deliverySlotService = new DeliverySlotService();
