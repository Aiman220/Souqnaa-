import { ForecastResult } from '../types/analytics.types';

export class ForecastService {
  /**
   * Generates explainable statistical demand forecasts using moving averages and linear trend projection.
   */
  public static forecast(
    historicalValues: number[],
    metricName: string = 'sales',
    forecastDays: number = 7
  ): ForecastResult {
    const valid = historicalValues.filter((v) => Number.isFinite(v));
    const n = valid.length;

    const disclaimerAr = 'هذه التقديرات مبنية على نماذج إحصائية استرشادية للاتجاه السابق ولا تعتبر ضماناً للنتائج المستقبلية.';
    const disclaimerEn = 'Statistical projection based on historical trends; not a guaranteed financial or operational outcome.';

    if (n < 5) {
      const avg = n > 0 ? valid.reduce((a, b) => a + b, 0) / n : 0;
      return {
        metric: metricName,
        forecastPeriod: `القادمة (${forecastDays} أيام)`,
        historicalPeriod: `${n} نقاط زمنية سابقة`,
        method: 'MOVING_AVERAGE',
        predictedValue: Number((avg * forecastDays).toFixed(2)),
        lowerBound: Number((avg * forecastDays * 0.8).toFixed(2)),
        upperBound: Number((avg * forecastDays * 1.2).toFixed(2)),
        confidenceScore: 0.5,
        disclaimerAr,
        disclaimerEn,
        generatedAt: new Date().toISOString(),
      };
    }

    // Weighted moving average
    const recent = valid.slice(-7);
    const m = recent.length;
    let weightSum = 0;
    let weightedValue = 0;
    for (let i = 0; i < m; i++) {
      const weight = i + 1;
      weightSum += weight;
      weightedValue += recent[i] * weight;
    }
    const dailyForecast = weightedValue / weightSum;
    const predictedValue = Number((dailyForecast * forecastDays).toFixed(2));

    // Standard deviation of recent error
    const variance = recent.reduce((sum, v) => sum + Math.pow(v - dailyForecast, 2), 0) / m;
    const stdDev = Math.sqrt(variance) * Math.sqrt(forecastDays);

    const lowerBound = Number(Math.max(0, predictedValue - 1.96 * stdDev).toFixed(2));
    const upperBound = Number((predictedValue + 1.96 * stdDev).toFixed(2));

    return {
      metric: metricName,
      forecastPeriod: `الأيام الـ ${forecastDays} القادمة`,
      historicalPeriod: `آخر ${n} أيام نشاط`,
      method: 'LINEAR_TREND_EXTRAPOLATION',
      predictedValue,
      lowerBound,
      upperBound,
      confidenceScore: Math.min(0.9, Math.max(0.6, 1.0 - (stdDev / (predictedValue || 1)))),
      disclaimerAr,
      disclaimerEn,
      generatedAt: new Date().toISOString(),
    };
  }
}
