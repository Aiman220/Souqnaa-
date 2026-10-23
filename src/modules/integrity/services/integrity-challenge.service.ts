/**
 * SOUQNA — AR-2.5: App Integrity Challenge & Replay Protection Service
 * 
 * Generates cryptographically secure, single-use, time-bound challenges (nonces)
 * bound to specific user sessions, application types, and high-risk operations.
 * Enforces atomic consumption to prevent challenge replay attacks.
 */

import crypto from 'crypto';
import { redisService } from '../../../database/redis';
import { IntegrityChallenge } from '../integrity.types';

export interface ChallengeValidationResult {
  valid: boolean;
  reason?: 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED' | 'CHALLENGE_EXPIRED' | 'CHALLENGE_APP_TYPE_MISMATCH' | 'CHALLENGE_OPERATION_MISMATCH' | 'CHALLENGE_USER_MISMATCH';
  challenge?: IntegrityChallenge;
}

export class IntegrityChallengeService {
  private static readonly KEY_PREFIX = 'integrity:challenge:';
  private static readonly DEFAULT_TTL_SECONDS = 300; // 5 minutes

  /**
   * Generates a single-use cryptographically random challenge bound to request context.
   */
  public static async createChallenge(params: {
    appType: string;
    operation: string;
    userId?: string;
    ttlSeconds?: number;
  }): Promise<IntegrityChallenge> {
    const ttl = params.ttlSeconds || this.DEFAULT_TTL_SECONDS;
    const now = Date.now();
    const nonce = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();

    const challenge: IntegrityChallenge = {
      id,
      nonce,
      userId: params.userId,
      appType: params.appType.toLowerCase(),
      operation: params.operation,
      createdAt: now,
      expiresAt: now + ttl * 1000,
    };

    const key = `${this.KEY_PREFIX}${nonce}`;
    await redisService.setJson(key, challenge, ttl);

    return challenge;
  }

  /**
   * Atomically validates and consumes a challenge nonce.
   * A challenge can only ever be consumed once. Subsequent or concurrent
   * consumption attempts will immediately fail (CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED).
   */
  public static async consumeChallenge(params: {
    nonce: string;
    expectedAppType: string;
    expectedOperation: string;
    userId?: string;
  }): Promise<ChallengeValidationResult> {
    const { nonce, expectedAppType, expectedOperation, userId } = params;

    if (!nonce || typeof nonce !== 'string' || nonce.trim().length === 0) {
      return { valid: false, reason: 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED' };
    }

    const key = `${this.KEY_PREFIX}${nonce.trim()}`;
    const lockKey = `consume:${nonce.trim()}`;

    // Acquire lock to guarantee mutual exclusion across concurrent attempts
    const lock = await redisService.acquireLock(lockKey, 5);
    if (!lock.acquired) {
      return { valid: false, reason: 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED' };
    }

    let challenge: IntegrityChallenge | null = null;
    try {
      // 1. Retrieve challenge payload
      challenge = await redisService.getJson<IntegrityChallenge>(key);

      if (!challenge) {
        return {
          valid: false,
          reason: 'CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED',
        };
      }

      // 2. Delete immediately upon retrieval to eliminate race windows & replay
      await redisService.del(key);
    } finally {
      await redisService.releaseLock(lockKey, lock.token);
    }

    // 3. Expiration verification
    if (Date.now() > challenge.expiresAt) {
      return {
        valid: false,
        reason: 'CHALLENGE_EXPIRED',
        challenge,
      };
    }

    // 4. App Type binding check
    if (challenge.appType.toLowerCase() !== expectedAppType.toLowerCase()) {
      return {
        valid: false,
        reason: 'CHALLENGE_APP_TYPE_MISMATCH',
        challenge,
      };
    }

    // 5. Operation binding check
    if (challenge.operation !== expectedOperation) {
      return {
        valid: false,
        reason: 'CHALLENGE_OPERATION_MISMATCH',
        challenge,
      };
    }

    // 6. User identity binding check (if issued to an authenticated session)
    if (challenge.userId && userId && challenge.userId !== userId) {
      return {
        valid: false,
        reason: 'CHALLENGE_USER_MISMATCH',
        challenge,
      };
    }

    return {
      valid: true,
      challenge,
    };
  }
}
