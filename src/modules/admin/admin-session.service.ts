import { redis } from '../../database/redis';
import { prisma } from '../../database/prisma';
import { PasswordPolicyUtil } from '../../utils/password-policy.util';
import { AppError } from '../../middleware/error.middleware';

export interface LockoutStatus {
  locked: boolean;
  lockTtlSeconds: number;
}

export interface FailedAttemptResult {
  locked: boolean;
  remainingAttempts: number;
  lockTtlSeconds?: number;
}

export class AdminSessionService {
  public static readonly MAX_FAILED_ATTEMPTS = 5;
  public static readonly LOCKOUT_DURATION_SECONDS = 900; // 15 minutes
  public static readonly ATTEMPT_WINDOW_SECONDS = 900; // 15 minutes

  /**
   * Checks whether an administrator account email is currently locked due to brute force attempts.
   */
  public static async isAccountLocked(email: string): Promise<LockoutStatus> {
    const cleanEmail = email.trim().toLowerCase();
    const lockKey = `admin:locked:${cleanEmail}`;
    const isLocked = await redis.get(lockKey);

    if (isLocked) {
      const ttl = await redis.ttl(lockKey);
      return {
        locked: true,
        lockTtlSeconds: Math.max(0, ttl),
      };
    }

    return { locked: false, lockTtlSeconds: 0 };
  }

  /**
   * Records a failed login attempt for an administrator email.
   * If threshold is reached, locks the account.
   */
  public static async recordFailedLogin(email: string): Promise<FailedAttemptResult> {
    const cleanEmail = email.trim().toLowerCase();
    const attemptsKey = `admin:failed_attempts:${cleanEmail}`;
    const lockKey = `admin:locked:${cleanEmail}`;

    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      await redis.expire(attemptsKey, this.ATTEMPT_WINDOW_SECONDS);
    }

    if (attempts >= this.MAX_FAILED_ATTEMPTS) {
      await redis.set(lockKey, '1', this.LOCKOUT_DURATION_SECONDS);
      await redis.del(attemptsKey);
      return {
        locked: true,
        remainingAttempts: 0,
        lockTtlSeconds: this.LOCKOUT_DURATION_SECONDS,
      };
    }

    const remaining = Math.max(0, this.MAX_FAILED_ATTEMPTS - attempts);
    return {
      locked: false,
      remainingAttempts: remaining,
    };
  }

  /**
   * Clears any failed login attempts and unlocks account upon successful authentication.
   */
  public static async recordSuccessfulLogin(email: string): Promise<void> {
    const cleanEmail = email.trim().toLowerCase();
    await redis.del(`admin:failed_attempts:${cleanEmail}`);
    await redis.del(`admin:locked:${cleanEmail}`);
  }

  /**
   * Revokes all active sessions for an administrator user:
   * - Deletes stored refresh tokens
   * - Stores a session revocation epoch timestamp
   */
  public static async revokeAllSessions(userId: string): Promise<void> {
    const epochNow = Math.floor(Date.now() / 1000);
    // Delete single/primary refresh token
    await redis.del(`refresh:${userId}`);
    // Record revocation timestamp
    await redis.set(`admin:session_revoked_at:${userId}`, String(epochNow), 30 * 24 * 3600); // 30 days retention
  }

  /**
   * Checks whether a session issued at tokenIat has been revoked for this user.
   */
  public static async isSessionRevoked(userId: string, tokenIat?: number): Promise<boolean> {
    const revokedAtStr = await redis.get(`admin:session_revoked_at:${userId}`);
    if (!revokedAtStr) return false;

    const revokedAt = parseInt(revokedAtStr, 10);
    if (isNaN(revokedAt)) return false;

    if (!tokenIat) {
      // If token has no issue timestamp, consider revoked if a revocation is active
      return true;
    }

    // Token was issued before revocation event
    return tokenIat < revokedAt;
  }

  /**
   * Re-authenticates the current administrator for sensitive account/permission mutations.
   */
  public static async reauthenticate(userId: string, candidatePassword?: string): Promise<void> {
    if (!candidatePassword) {
      throw new AppError(
        'إعادة التحقق مطلوبة: يرجى إدخال كلمة المرور الحالية لتأكيد هذا الإجراء الحساس.',
        403,
        'REAUTH_REQUIRED'
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new AppError('المستخدم غير موجود.', 404);
    }

    const isValid = await PasswordPolicyUtil.verifyPassword(candidatePassword, user.passwordHash);
    if (!isValid) {
      throw new AppError(
        'كلمة المرور التأكيدية غير صحيحة. تم رفض الإجراء الحساس.',
        403,
        'REAUTH_FAILED'
      );
    }
  }

  /**
   * Safely logs administrator audit events with sensitive details redacted.
   */
  public static async logAudit(params: {
    actorId?: string;
    action: string;
    resource: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    details?: Record<string, any>;
  }): Promise<void> {
    try {
      // Deep sanitize details: never log password, hash, or tokens
      let sanitizedDetails: Record<string, any> | null = null;
      if (params.details) {
        sanitizedDetails = { ...params.details };
        const secretKeys = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret'];
        for (const k of Object.keys(sanitizedDetails)) {
          if (secretKeys.some((sk) => k.toLowerCase().includes(sk.toLowerCase()))) {
            sanitizedDetails[k] = '[REDACTED]';
          }
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: params.actorId || null,
          action: params.action,
          resource: params.resource,
          ipAddress: params.ipAddress || null,
          userAgent: params.userAgent || null,
          details: sanitizedDetails ? JSON.stringify(sanitizedDetails) : null,
        },
      });
    } catch (e) {
      console.error('[AdminSessionService] Failed to write audit log:', e);
    }
  }
}
