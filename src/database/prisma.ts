import { PrismaClient } from '@prisma/client';
import { config } from '../config';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'stdout', level: 'error' },
      { emit: 'stdout', level: 'warn' },
    ],
  });

// Structured timing logs for slow database queries without leaking parameter values
const slowQueryThreshold = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '250', 10);

(prisma as any).$on('query', (e: { query: string; duration: number; timestamp: Date; target: string }) => {
  if (e.duration >= slowQueryThreshold) {
    const sanitizedQuery = (e.query || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    console.warn(
      `[DB Slow Query] duration=${e.duration}ms query="${sanitizedQuery}" target=${e.target || 'postgres'} timestamp=${e.timestamp.toISOString()}`
    );
  }
});

if (config.env !== 'production') globalForPrisma.prisma = prisma;
