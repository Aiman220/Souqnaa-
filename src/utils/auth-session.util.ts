import crypto from 'crypto';

export function createOAuthSessionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hasActiveSession(tokenSessionId: unknown, activeSessionId: unknown): boolean {
  return typeof tokenSessionId === 'string' && tokenSessionId.length > 0 &&
    typeof activeSessionId === 'string' && tokenSessionId === activeSessionId;
}
