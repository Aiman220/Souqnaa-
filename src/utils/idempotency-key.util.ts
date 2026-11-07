import crypto from 'crypto';

export function buildScopedIdempotencyKey(userId: string, method: string, path: string, key: string): string {
  return crypto.createHash('sha256').update(`${userId}\n${method.toUpperCase()}\n${path}\n${key.trim()}`).digest('hex');
}
