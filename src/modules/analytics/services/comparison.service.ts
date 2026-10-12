import {
  AnalyticsPeriod,
  DateRange,
  MetricComparison,
  FreshnessType,
  TrendDirection,
} from '../types/analytics.types';

export class ComparisonService {
  /**
   * Resolves current period and preceding equivalent period for fair comparison.
   */
  public static resolveDateRange(
    period: AnalyticsPeriod = '30d',
    customStart?: string | Date,
    customEnd?: string | Date
  ): DateRange {
    const now = new Date();
    let startDate: Date;
    let endDate: Date = new Date(now);
    let previousStartDate: Date;
    let previousEndDate: Date;
    let periodLabel = '30 يوماً الأخيرة';

    if (customStart && customEnd) {
      startDate = new Date(customStart);
      endDate = new Date(customEnd);
      endDate.setHours(23, 59, 59, 999);
      const durationMs = endDate.getTime() - startDate.getTime();
      previousEndDate = new Date(startDate.getTime() - 1);
      previousStartDate = new Date(previousEndDate.getTime() - durationMs);
      periodLabel = 'فترة مخصصة';
      return { startDate, endDate, previousStartDate, previousEndDate, periodLabel };
    }

    switch (period) {
      case 'today': {
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        const elapsedTodayMs = now.getTime() - startDate.getTime();

        previousStartDate = new Date(startDate);
        previousStartDate.setDate(previousStartDate.getDate() - 1);

        previousEndDate = new Date(previousStartDate.getTime() + elapsedTodayMs);
        periodLabel = 'اليوم';
        break;
      }
      case 'yesterday': {
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 1);
        startDate.setHours(0, 0, 0, 0);

        endDate = new Date(startDate);
        endDate.setHours(23, 59, 59, 999);

        previousStartDate = new Date(startDate);
        previousStartDate.setDate(previousStartDate.getDate() - 1);

        previousEndDate = new Date(previousStartDate);
        previousEndDate.setHours(23, 59, 59, 999);
        periodLabel = 'الأمس';
        break;
      }
      case '7d': {
        startDate = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        previousEndDate = new Date(startDate.getTime() - 1);
        previousStartDate = new Date(previousEndDate.getTime() - 7 * 24 * 3600 * 1000);
        periodLabel = 'آخر 7 أيام';
        break;
      }
      case '90d': {
        startDate = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
        previousEndDate = new Date(startDate.getTime() - 1);
        previousStartDate = new Date(previousEndDate.getTime() - 90 * 24 * 3600 * 1000);
        periodLabel = 'آخر 90 يوماً';
        break;
      }
      case 'this_month': {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        const dayOfMonth = now.getDate();
        previousStartDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        previousEndDate = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(dayOfMonth, 28), now.getHours(), now.getMinutes());
        periodLabel = 'هذا الشهر';
        break;
      }
      case 'last_month': {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        previousStartDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        previousEndDate = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59, 999);
        periodLabel = 'الشهر الماضي';
        break;
      }
      case 'this_year': {
        startDate = new Date(now.getFullYear(), 0, 1);
        previousStartDate = new Date(now.getFullYear() - 1, 0, 1);
        previousEndDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
        periodLabel = 'هذا العام';
        break;
      }
      case '30d':
      default: {
        startDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
        previousEndDate = new Date(startDate.getTime() - 1);
        previousStartDate = new Date(previousEndDate.getTime() - 30 * 24 * 3600 * 1000);
        periodLabel = 'آخر 30 يوماً';
        break;
      }
    }

    return {
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      periodLabel,
    };
  }

  /**
   * Safely calculates absolute and percentage change between current and previous values.
   * Handles division by zero safely without NaN or Infinity.
   */
  public static compare(
    current: number,
    previous: number,
    freshness: FreshnessType = 'REAL_TIME',
    sampleSize?: number
  ): MetricComparison {
    const cur = Number.isFinite(current) ? current : 0;
    const prev = Number.isFinite(previous) ? previous : 0;
    const absoluteChange = Number((cur - prev).toFixed(2));

    let percentageChange = 0;
    if (prev === 0) {
      if (cur > 0) percentageChange = 100.0;
      else if (cur < 0) percentageChange = -100.0;
      else percentageChange = 0.0;
    } else {
      percentageChange = Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(2));
    }

    let trend: TrendDirection = 'STABLE';
    if (percentageChange > 0.5) trend = 'UP';
    else if (percentageChange < -0.5) trend = 'DOWN';

    return {
      currentValue: Number(cur.toFixed(2)),
      previousValue: Number(prev.toFixed(2)),
      absoluteChange,
      percentageChange,
      trend,
      sampleSize,
      confidence: sampleSize !== undefined ? Math.min(1.0, Math.max(0.5, sampleSize / 20)) : 1.0,
      freshness,
    };
  }
}
