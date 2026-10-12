import { TrendState } from '../types/analytics.types';

export interface TrendAnalysisResult {
  trendState: TrendState;
  slope: number;
  percentageChange: number;
  sampleSize: number;
  volatility: number; // coefficient of variation
  confidenceScore: number;
  descriptionAr: string;
  descriptionEn: string;
}

export class TrendAnalysisService {
  /**
   * Evaluates trend direction and stability across a sequence of chronological data points.
   */
  public static analyzeTrend(values: number[]): TrendAnalysisResult {
    const validValues = values.filter((v) => Number.isFinite(v));
    const n = validValues.length;

    if (n < 2) {
      return {
        trendState: 'STABLE',
        slope: 0,
        percentageChange: 0,
        sampleSize: n,
        volatility: 0,
        confidenceScore: 0.3,
        descriptionAr: 'بيانات غير كافية لتحديد الاتجاه الإحصائي',
        descriptionEn: 'Insufficient data points to determine statistical trend',
      };
    }

    // Mean
    const mean = validValues.reduce((sum, v) => sum + v, 0) / n;

    // Standard deviation
    const variance = validValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const volatility = mean > 0 ? stdDev / mean : 0;

    // Linear regression slope: y = mx + c
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += validValues[i];
      sumXY += i * validValues[i];
      sumXX += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);

    const firstVal = validValues[0];
    const lastVal = validValues[n - 1];
    let percentageChange = 0;
    if (firstVal > 0) {
      percentageChange = Number((((lastVal - firstVal) / firstVal) * 100).toFixed(2));
    }

    // Confidence: increases with sample size and lower volatility
    const sampleFactor = Math.min(1.0, n / 14);
    const volatilityFactor = Math.max(0.4, 1.0 - Math.min(1.0, volatility / 2));
    const confidenceScore = Number((sampleFactor * volatilityFactor).toFixed(2));

    let trendState: TrendState = 'STABLE';
    let descriptionAr = 'المؤشر مستقر ضمن الحدود الطبيعية';
    let descriptionEn = 'Metric is stable within expected boundaries';

    // If volatility is high, classify as VOLATILE
    if (volatility > 0.8 && n >= 5) {
      trendState = 'VOLATILE';
      descriptionAr = 'تذبذب وتقلب ملحوظ في الأداء';
      descriptionEn = 'High volatility and variance observed across period';
    } else if (slope > 0.05 && percentageChange >= 5) {
      trendState = 'RISING';
      descriptionAr = `مسار صاعد بنسبة +${percentageChange}%`;
      descriptionEn = `Upward rising trajectory of +${percentageChange}%`;
    } else if (slope < -0.05 && percentageChange <= -5) {
      trendState = 'DECLINING';
      descriptionAr = `مسار هابط بنسبة ${percentageChange}%`;
      descriptionEn = `Downward declining trajectory of ${percentageChange}%`;
    }

    return {
      trendState,
      slope: Number(slope.toFixed(4)),
      percentageChange,
      sampleSize: n,
      volatility: Number(volatility.toFixed(3)),
      confidenceScore,
      descriptionAr,
      descriptionEn,
    };
  }
}
