import { DateRange, AnomalyReport, AlertSeverity } from '../types/analytics.types';
import { ComparisonService } from './comparison.service';

export class AnomalyDetectionService {
  /**
   * Evaluates key business metrics for statistical spikes or drops beyond normal bounds.
   * Does NOT make fraud accusations; raises ANOMALY_DETECTED with factual metric comparisons.
   */
  public static detectAnomalies(
    currentMetrics: Record<string, number>,
    previousMetrics: Record<string, number>,
    range: DateRange
  ): AnomalyReport[] {
    const anomalies: AnomalyReport[] = [];

    // 1. Sales Drop Anomaly (> 40% drop with meaningful baseline)
    const curSales = currentMetrics.grossSales || 0;
    const prevSales = previousMetrics.grossSales || 0;
    if (prevSales > 5000) {
      const salesComparison = ComparisonService.compare(curSales, prevSales);
      if (salesComparison.percentageChange <= -40) {
        anomalies.push({
          id: `anomaly-sales-drop-${Date.now()}`,
          alertType: 'SALES_DROP',
          metric: 'grossSales',
          severity: salesComparison.percentageChange <= -60 ? 'HIGH' : 'MEDIUM',
          threshold: -40,
          observedValue: curSales,
          comparisonValue: prevSales,
          differencePercentage: salesComparison.percentageChange,
          titleAr: 'تراجع حاد غير معتاد في حجم المبيعات',
          titleEn: 'Sharp Unscheduled Drop in Gross Sales',
          explanationAr: `انخفضت المبيعات بنسبة ${salesComparison.percentageChange}% مقارنة بالفترة السابقة (${curSales} ر.ي مقابل ${prevSales} ر.ي).`,
          explanationEn: `Sales dropped by ${salesComparison.percentageChange}% compared to previous period (${curSales} YER vs ${prevSales} YER).`,
          detectedAt: new Date().toISOString(),
          status: 'NEW',
        });
      }
    }

    // 2. Cancellation Spike Anomaly (> 25% cancellation rate when orders >= 5)
    const curOrders = currentMetrics.totalOrders || 0;
    const curCancelled = currentMetrics.cancelledOrders || 0;
    if (curOrders >= 5) {
      const cancelRate = (curCancelled / curOrders) * 100;
      if (cancelRate >= 25) {
        anomalies.push({
          id: `anomaly-cancel-spike-${Date.now()}`,
          alertType: 'CANCELLATION_SPIKE',
          metric: 'cancellationRate',
          severity: cancelRate >= 40 ? 'CRITICAL' : 'HIGH',
          threshold: 25,
          observedValue: Number(cancelRate.toFixed(1)),
          comparisonValue: 10,
          differencePercentage: Number((cancelRate - 10).toFixed(1)),
          titleAr: 'ارتفاع استثنائي في نسبة إلغاء الطلبات',
          titleEn: 'Exceptional Spike in Order Cancellation Rate',
          explanationAr: `بلغت نسبة الإلغاء ${cancelRate.toFixed(1)}% (${curCancelled} من أصل ${curOrders} طلب). يرجى فحص أسباب الإلغاء أو المخزون.`,
          explanationEn: `Order cancellation rate reached ${cancelRate.toFixed(1)}% (${curCancelled} out of ${curOrders} orders).`,
          detectedAt: new Date().toISOString(),
          status: 'NEW',
        });
      }
    }

    // 3. Refund Spike Anomaly
    const curRefunded = currentMetrics.refundedOrders || 0;
    if (curOrders >= 5) {
      const refundRate = (curRefunded / curOrders) * 100;
      if (refundRate >= 15) {
        anomalies.push({
          id: `anomaly-refund-spike-${Date.now()}`,
          alertType: 'REFUND_SPIKE',
          metric: 'refundRate',
          severity: refundRate >= 30 ? 'CRITICAL' : 'HIGH',
          threshold: 15,
          observedValue: Number(refundRate.toFixed(1)),
          comparisonValue: 5,
          differencePercentage: Number((refundRate - 5).toFixed(1)),
          titleAr: 'ارتفاع غير طبيعي في معدل الاسترجاع والنزاعات',
          titleEn: 'Unusual Spike in Return and Refund Rate',
          explanationAr: `سجلت طلبات الاسترجاع ${refundRate.toFixed(1)}% من إجمالي الطلبات. يلزم فحص جودة الشحنات.`,
          explanationEn: `Refunded orders reached ${refundRate.toFixed(1)}% of total orders. Quality inspection recommended.`,
          detectedAt: new Date().toISOString(),
          status: 'NEW',
        });
      }
    }

    // 4. Sales Sudden Positive Spike (> 150% spike with baseline)
    if (prevSales > 3000 && curSales > prevSales * 2.5) {
      const spikePct = Number((((curSales - prevSales) / prevSales) * 100).toFixed(1));
      anomalies.push({
        id: `anomaly-sales-spike-${Date.now()}`,
        alertType: 'ANOMALY_DETECTED',
        metric: 'grossSales',
        severity: 'LOW',
        threshold: 150,
        observedValue: curSales,
        comparisonValue: prevSales,
        differencePercentage: spikePct,
        titleAr: 'قفزة مبيعات إيجابية سريعة (Spike)',
        titleEn: 'Rapid Positive Sales Spike Detected',
        explanationAr: `سجلت المبيعات ارتفاعاً سريعاً بنسبة +${spikePct}%. تأكد من توفر المخزون الكافي لتلبية الطلب.`,
        explanationEn: `Sales increased dramatically by +${spikePct}%. Ensure inventory sufficiency.`,
        detectedAt: new Date().toISOString(),
        status: 'NEW',
      });
    }

    return anomalies;
  }
}
