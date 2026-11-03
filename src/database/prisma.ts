import { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { backendTelemetry } from '../services/telemetry/backend-telemetry.service';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Ensure connection pool limits appropriate for Render instance without crashing
function getNormalizedDatabaseUrl(): string {
  const url = process.env.DATABASE_URL || config.database?.url || '';
  if (!url) return url;

  // If connection_limit is not already configured in URI, append sane production defaults
  if (!url.includes('connection_limit=')) {
    const separator = url.includes('?') ? '&' : '?';
    // 15 connections with 20 second acquisition timeout avoids pool exhaustion while staying within Render PG limits
    return `${url}${separator}connection_limit=15&pool_timeout=20`;
  }
  return url;
}

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: getNormalizedDatabaseUrl(),
      },
    },
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'stdout', level: 'error' },
      { emit: 'stdout', level: 'warn' },
    ],
  });

// Structured timing logs for slow database queries without leaking parameter values
const slowQueryThreshold = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '250', 10);

(prisma as any).$on('query', (e: { query: string; duration: number; timestamp: Date; target: string }) => {
  const isSlow = e.duration >= slowQueryThreshold;
  backendTelemetry.recordDbQuery(e.duration, isSlow);

  if (isSlow) {
    const sanitizedQuery = (e.query || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    console.warn(
      `[DB Slow Query] duration=${e.duration}ms query="${sanitizedQuery}" target=${e.target || 'postgres'} timestamp=${e.timestamp.toISOString()}`
    );
  }
});

if (config.env !== 'production') globalForPrisma.prisma = prisma;
