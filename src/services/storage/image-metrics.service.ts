/**
 * SOUQNA Image Storage & Delivery Performance Metrics Tracker
 * Records CDN hits, variant conversions, bandwidth savings, and processing latencies.
 */

export interface ImagePerformanceSnapshot {
  uptimeSeconds: number;
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  notModified304: number;
  failures: number;
  cacheHitRatio: string;
  totalBytesTransferred: number;
  totalBytesTransferredFormatted: string;
  totalBytesSaved: number;
  totalBytesSavedFormatted: string;
  bandwidthReductionPercent: string;
  avgProcessingTimeMs: number;
  variantDistribution: Record<string, number>;
  lastResetAt: string;
}

class ImageMetricsService {
  private startTime = Date.now();
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private notModified304 = 0;
  private failures = 0;
  private totalBytesTransferred = 0;
  private totalBytesSaved = 0;
  private totalProcessingDurationMs = 0;
  private processingCount = 0;
  private variantDistribution: Record<string, number> = {
    thumbnail: 0,
    small: 0,
    medium: 0,
    large: 0,
    original: 0,
    custom: 0,
  };

  recordRequest(params: {
    variant?: string;
    isHit: boolean;
    is304?: boolean;
    bytesTransferred: number;
    originalBytes?: number;
    processingDurationMs?: number;
    isError?: boolean;
  }) {
    this.totalRequests++;

    if (params.isError) {
      this.failures++;
      return;
    }

    if (params.is304) {
      this.notModified304++;
      this.cacheHits++;
    } else if (params.isHit) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }

    this.totalBytesTransferred += Math.max(0, params.bytesTransferred);

    if (params.originalBytes && params.originalBytes > params.bytesTransferred) {
      this.totalBytesSaved += params.originalBytes - params.bytesTransferred;
    }

    if (params.processingDurationMs !== undefined && params.processingDurationMs > 0) {
      this.totalProcessingDurationMs += params.processingDurationMs;
      this.processingCount++;
    }

    const vKey = params.variant && this.variantDistribution[params.variant] !== undefined
      ? params.variant
      : 'original';
    this.variantDistribution[vKey] = (this.variantDistribution[vKey] || 0) + 1;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getSnapshot(): ImagePerformanceSnapshot {
    const uptimeSeconds = Math.round((Date.now() - this.startTime) / 1000);
    const hitTotal = this.cacheHits;
    const reqTotal = this.totalRequests || 1;
    const hitRatio = ((hitTotal / reqTotal) * 100).toFixed(1) + '%';

    const rawTotalPotential = this.totalBytesTransferred + this.totalBytesSaved;
    const bandwidthReduction = rawTotalPotential > 0
      ? ((this.totalBytesSaved / rawTotalPotential) * 100).toFixed(1) + '%'
      : '0.0%';

    const avgProcessingTimeMs = this.processingCount > 0
      ? Math.round(this.totalProcessingDurationMs / this.processingCount)
      : 0;

    return {
      uptimeSeconds,
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      notModified304: this.notModified304,
      failures: this.failures,
      cacheHitRatio: hitRatio,
      totalBytesTransferred: this.totalBytesTransferred,
      totalBytesTransferredFormatted: this.formatBytes(this.totalBytesTransferred),
      totalBytesSaved: this.totalBytesSaved,
      totalBytesSavedFormatted: this.formatBytes(this.totalBytesSaved),
      bandwidthReductionPercent: bandwidthReduction,
      avgProcessingTimeMs,
      variantDistribution: { ...this.variantDistribution },
      lastResetAt: new Date(this.startTime).toISOString(),
    };
  }

  reset() {
    this.startTime = Date.now();
    this.totalRequests = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.notModified304 = 0;
    this.failures = 0;
    this.totalBytesTransferred = 0;
    this.totalBytesSaved = 0;
    this.totalProcessingDurationMs = 0;
    this.processingCount = 0;
    Object.keys(this.variantDistribution).forEach((k) => (this.variantDistribution[k] = 0));
  }
}

export const imageMetricsService = new ImageMetricsService();

