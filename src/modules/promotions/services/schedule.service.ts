import { CampaignSchedule, CampaignStatus } from '@prisma/client';

export interface ScheduleEvaluationResult {
  isActive: boolean;
  computedStatus: CampaignStatus;
  reason?: string;
}

class ScheduleService {
  /**
   * Evaluates if a given time is within a time-of-day window (HH:mm)
   * in the specified timezone.
   */
  isWithinTimeOfDay(
    referenceDate: Date,
    startTimeOfDay?: string | null,
    endTimeOfDay?: string | null,
    timezone = 'Asia/Aden'
  ): boolean {
    if (!startTimeOfDay && !endTimeOfDay) return true;

    try {
      // Format reference time in the target timezone as HH:mm
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = formatter.format(referenceDate); // e.g. "19:30"

      const start = startTimeOfDay || '00:00';
      const end = endTimeOfDay || '23:59';

      if (start <= end) {
        return parts >= start && parts <= end;
      } else {
        // Over-midnight window, e.g. 22:00 to 04:00
        return parts >= start || parts <= end;
      }
    } catch {
      // Fallback: UTC comparison
      const hours = referenceDate.getUTCHours().toString().padStart(2, '0');
      const minutes = referenceDate.getUTCMinutes().toString().padStart(2, '0');
      const current = `${hours}:${minutes}`;
      const start = startTimeOfDay || '00:00';
      const end = endTimeOfDay || '23:59';
      return current >= start && current <= end;
    }
  }

  /**
   * Evaluates if a given date falls on one of the active days of the week.
   * Days: 0 (Sun) .. 6 (Sat)
   */
  isWithinDaysOfWeek(referenceDate: Date, daysOfWeekJson?: string | null, timezone = 'Asia/Aden'): boolean {
    if (!daysOfWeekJson || daysOfWeekJson === '[]') return true;

    try {
      const days: number[] = typeof daysOfWeekJson === 'string'
        ? JSON.parse(daysOfWeekJson.replace(/'/g, '"'))
        : daysOfWeekJson;
      if (!Array.isArray(days) || days.length === 0) return true;
      if (days.length >= 7) return true;

      const dayOfWeek = referenceDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      return days.includes(dayOfWeek) || days.includes(dayOfWeek === 0 ? 7 : dayOfWeek);
    } catch {
      return true;
    }
  }

  /**
   * Evaluates if a specific campaign and its schedules are active right now.
   * Uses authoritative server UTC timestamp.
   */
  evaluateSchedule(
    startAt: Date,
    endAt: Date,
    currentStatus: CampaignStatus,
    schedules: CampaignSchedule[] = [],
    timezone = 'Asia/Aden',
    referenceDate = new Date()
  ): ScheduleEvaluationResult {
    // If explicitly paused, cancelled, archived, or draft, preserve that status
    if (['DRAFT', 'PENDING_APPROVAL', 'PAUSED', 'CANCELLED', 'ARCHIVED'].includes(currentStatus)) {
      return {
        isActive: false,
        computedStatus: currentStatus,
        reason: `Campaign is currently ${currentStatus}`,
      };
    }

    const now = referenceDate.getTime();
    const startMs = new Date(startAt).getTime();
    const endMs = new Date(endAt).getTime();

    if (now < startMs) {
      return {
        isActive: false,
        computedStatus: 'SCHEDULED',
        reason: 'Campaign has not started yet',
      };
    }

    if (now > endMs) {
      return {
        isActive: false,
        computedStatus: 'ENDED',
        reason: 'Campaign has already expired',
      };
    }

    // Check optional sub-schedules
    if (schedules && schedules.length > 0) {
      let anyScheduleMatches = false;
      for (const s of schedules) {
        const schedStartMs = new Date(s.startDate).getTime();
        const schedEndMs = new Date(s.endDate).getTime();

        if (now >= schedStartMs && now <= schedEndMs) {
          // Time-of-day restriction only applies if explicitly configured as FLASH_HOURS
          const isHourlyFlash = s.scheduleType === 'FLASH_HOURS' || s.scheduleType === 'TIME_WINDOW';
          const inTimeOfDay = isHourlyFlash
            ? this.isWithinTimeOfDay(
                referenceDate,
                s.startTimeOfDay,
                s.endTimeOfDay,
                s.timezone || timezone
              )
            : true;

          const inDaysOfWeek = this.isWithinDaysOfWeek(
            referenceDate,
            s.daysOfWeek,
            s.timezone || timezone
          );

          if (inTimeOfDay && inDaysOfWeek) {
            anyScheduleMatches = true;
            break;
          }
        }
      }

      if (!anyScheduleMatches) {
        return {
          isActive: false,
          computedStatus: 'SCHEDULED',
          reason: 'Outside recurring schedule window',
        };
      }
    }

    return {
      isActive: true,
      computedStatus: 'ACTIVE',
    };
  }
}

export const scheduleService = new ScheduleService();
