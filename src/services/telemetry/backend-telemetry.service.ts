/**
 * SOUQNA Backend Telemetry & Performance Instrumentation Service
 * Tracks API request duration (p50, p95, p99), error rates, database query duration,
 * response payload sizes, cold-start duration, and socket lifecycle events.
 * 
 * Strict Privacy Guarantees:
 * - Never stores or logs authentication tokens, passwords, payment info, OTPs, or signed URLs.
 * - Bounded memory usage via a fixed-size rolling reservoir (max 1000 items).
 */

export interface PerformanceSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  coldStartDurationMs: number;
  requests: {
    total: number;
    success: number;
    errors: number;
    errorRatePercent: number;
    statusCodes: Record<string, number>;
  };
  latencyMs: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  database: {
    totalQueries: number;
    slowQueries: number;
    avgQueryDurationMs: number;
  };
  payloadBytes: {
    totalResponseBytes: number;
    avgResponseBytes: number;
  };
  realtime: {
    activeSocketConnections: number;
    reconnectCount: number;
    duplicateInitPrevented: number;
  };
}

export class BackendTelemetryService {
  private static instance: BackendTelemetryService;

  private readonly processStartTime = Date.now();
  private coldStartDurationMs = 0;
  private isFirstRequestRecorded = false;

  // Request & Latency metrics
  private totalRequests = 0;
  private successfulRequests = 0;
  private errorRequests = 0;
  private readonly statusCodes: Record<string, number> = {};
  private readonly latencies: number[] = [];
  private readonly MAX_LATENCY_SAMPLES = 1000;

  // Database metrics
  private totalDbQueries = 0;
  private slowDbQueries = 0;
  private totalDbDurationMs = 0;

  // Bandwidth & Payload
  private totalResponseBytes = 0;

  // Realtime Socket metrics
  private activeSockets = 0;
  private socketReconnects = 0;
  private duplicateSocketInitsPrevented = 0;

  private constructor() {}

  public static get(): BackendTelemetryService {
    if (!BackendTelemetryService.instance) {
      BackendTelemetryService.instance = new BackendTelemetryService();
    }
    return BackendTelemetryService.instance;
  }

  /**
   * Records completed HTTP request duration and response size.
   */
  public recordRequest(params: {
    method: string;
    endpoint: string;
    statusCode: number;
    durationMs: number;
    responseBytes: number;
    dbDurationMs?: number;
  }): void {
    if (!this.isFirstRequestRecorded) {
      this.isFirstRequestRecorded = true;
      this.coldStartDurationMs = Date.now() - this.processStartTime;
    }

    this.totalRequests++;
    if (params.statusCode >= 400) {
      this.errorRequests++;
    } else {
      this.successfulRequests++;
    }

    const codeKey = String(params.statusCode);
    this.statusCodes[codeKey] = (this.statusCodes[codeKey] || 0) + 1;

    this.totalResponseBytes += params.responseBytes;

    if (this.latencies.length >= this.MAX_LATENCY_SAMPLES) {
      this.latencies.shift();
    }
    this.latencies.push(params.durationMs);
  }

  /**
   * Records a database query executed by Prisma.
   */
  public recordDbQuery(durationMs: number, isSlow = false): void {
    this.totalDbQueries++;
    this.totalDbDurationMs += durationMs;
    if (isSlow) {
      this.slowDbQueries++;
    }
  }

  /**
   * Tracks active WebSocket connection count and reconnected clients.
   */
  public recordSocketConnection(isReconnect = false): void {
    this.activeSockets++;
    if (isReconnect) {
      this.socketReconnects++;
    }
  }

  public recordSocketDisconnection(): void {
    if (this.activeSockets > 0) {
      this.activeSockets--;
    }
  }

  public recordDuplicateSocketInitPrevented(): void {
    this.duplicateSocketInitsPrevented++;
  }

  /**
   * Generates a point-in-time performance and latency snapshot.
   */
  public getSnapshot(): PerformanceSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const count = sorted.length;

    let min = 0;
    let max = 0;
    let avg = 0;
    let p50 = 0;
    let p95 = 0;
    let p99 = 0;

    if (count > 0) {
      min = sorted[0];
      max = sorted[count - 1];
      avg = Math.round((sorted.reduce((a, b) => a + b, 0) / count) * 100) / 100;
      p50 = sorted[Math.floor(count * 0.5)];
      p95 = sorted[Math.min(count - 1, Math.floor(count * 0.95))];
      p99 = sorted[Math.min(count - 1, Math.floor(count * 0.99))];
    }

    const errorRate = this.totalRequests > 0
      ? Math.round((this.errorRequests / this.totalRequests) * 10000) / 100
      : 0;

    const avgDbDuration = this.totalDbQueries > 0
      ? Math.round((this.totalDbDurationMs / this.totalDbQueries) * 100) / 100
      : 0;

    const avgResponseBytes = this.totalRequests > 0
      ? Math.round(this.totalResponseBytes / this.totalRequests)
      : 0;

    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      coldStartDurationMs: this.coldStartDurationMs,
      requests: {
        total: this.totalRequests,
        success: this.successfulRequests,
        errors: this.errorRequests,
        errorRatePercent: errorRate,
        statusCodes: { ...this.statusCodes },
      },
      latencyMs: {
        min,
        max,
        avg,
        p50,
        p95,
        p99,
      },
      database: {
        totalQueries: this.totalDbQueries,
        slowQueries: this.slowDbQueries,
        avgQueryDurationMs: avgDbDuration,
      },
      payloadBytes: {
        totalResponseBytes: this.totalResponseBytes,
        avgResponseBytes,
      },
      realtime: {
        activeSocketConnections: this.activeSockets,
        reconnectCount: this.socketReconnects,
        duplicateInitPrevented: this.duplicateSocketInitsPrevented,
      },
    };
  }

  public reset(): void {
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.errorRequests = 0;
    this.totalResponseBytes = 0;
    this.latencies.length = 0;
    this.totalDbQueries = 0;
    this.slowDbQueries = 0;
    this.totalDbDurationMs = 0;
    this.socketReconnects = 0;
    this.duplicateSocketInitsPrevented = 0;
  }
}

export const backendTelemetry = BackendTelemetryService.get();

