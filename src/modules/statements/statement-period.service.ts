/**
 * SOUQNAA Marketplace — Statement Period Service
 * Handles period date calculation and validation (DAILY, WEEKLY, MONTHLY, CUSTOM).
 * Respects centralized single marketplace timezone (Asia/Aden).
 */

import { StatementPeriodType } from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';
import { config } from '../../config';

export class StatementPeriodService {
  public static readonly DEFAULT_TIMEZONE = config.marketplace.timezone || 'Asia/Aden';

  /**
   * Resolves exact start and end Date bounds for a requested statement period.
   */
  public static resolvePeriodBounds(params: {
    periodType?: StatementPeriodType;
    referenceDate?: Date;
    customStart?: Date;
    customEnd?: Date;
  }): { periodStart: Date; periodEnd: Date; periodType: StatementPeriodType; timezone: string } {
    const periodType = params.periodType || StatementPeriodType.MONTHLY;
    const ref = params.referenceDate || new Date();
    const timezone = this.DEFAULT_TIMEZONE;

    if (periodType === StatementPeriodType.CUSTOM) {
      if (!params.customStart || !params.customEnd) {
        throw new AppError('تاريخ البداية والنهاية مطلوبان للفترة المخصصة', 400);
      }
      if (params.customStart > params.customEnd) {
        throw new AppError('تاريخ البداية يجب أن يكون قبل أو يساوي تاريخ النهاية', 400);
      }
      return {
        periodStart: params.customStart,
        periodEnd: params.customEnd,
        periodType: StatementPeriodType.CUSTOM,
        timezone,
      };
    }

    if (periodType === StatementPeriodType.DAILY) {
      const start = new Date(ref);
      start.setHours(0, 0, 0, 0);
      const end = new Date(ref);
      end.setHours(23, 59, 59, 999);
      return { periodStart: start, periodEnd: end, periodType, timezone };
    }

    if (periodType === StatementPeriodType.WEEKLY) {
      const start = new Date(ref);
      // In Yemen/MENA standard, week starts on Saturday (day 6 in JS Date where Sun=0, Sat=6)
      const day = start.getDay();
      const diffToSaturday = (day + 1) % 7;
      start.setDate(start.getDate() - diffToSaturday);
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return { periodStart: start, periodEnd: end, periodType, timezone };
    }

    // MONTHLY default
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const start = new Date(year, month, 1, 0, 0, 0, 0);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

    return { periodStart: start, periodEnd: end, periodType: StatementPeriodType.MONTHLY, timezone };
  }

  /**
   * Formats period date range in Arabic and English for printable statements.
   */
  public static formatPeriodText(periodStart: Date, periodEnd: Date): { ar: string; en: string } {
    const startObj = new Date(periodStart);
    const endObj = new Date(periodEnd);

    const arFormatter = new Intl.DateTimeFormat('ar-YE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: this.DEFAULT_TIMEZONE,
    });

    const enFormatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: this.DEFAULT_TIMEZONE,
    });

    return {
      ar: `${arFormatter.format(startObj)} – ${arFormatter.format(endObj)}`,
      en: `${enFormatter.format(startObj)} – ${enFormatter.format(endObj)}`,
    };
  }
}
