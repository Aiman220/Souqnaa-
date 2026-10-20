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

// Structured timing logs for slow database queries (> 250ms) without leaking parameter values
(prisma as any).$on('query', (e: { query: string; duration: number; timestamp: Date; target: string }) => {
  if (e.duration >= 250) {
    console.warn(
      `[DB Slow Query] duration=${e.duration}ms target=${e.target || 'postgres'} timestamp=${e.timestamp.toISOString()}`
    );
  }
});

if (config.env !== 'production') globalForPrisma.prisma = prisma;

