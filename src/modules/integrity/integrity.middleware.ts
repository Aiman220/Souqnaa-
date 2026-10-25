/**
 * SOUQNA — AR-2.5: Integrity Enforcement Middleware
 *
 * requireIntegrity(operation) — Express middleware factory.
 *
 * Usage on a route:
 *   router.post('/withdraw', financialLimiter, requireIntegrity('WALLET_WITHDRAWAL'), handler);
 *
 * Behaviour per status:
 *   VERIFIED    → always allowed; integrity result attached to req.integrityResult
 *   UNAVAILABLE → allowed if policy mode is 'soft' or 'observe'; blocked if 'enforce'
 *   REJECTED    → always blocked (REJECTED means cryptographically invalid or compromised)
 *   INVALID     → always blocked
 *   EXPIRED     → blocked; client must re-request a challenge
 *
 * The middleware never:
 *   - Trusts a client-supplied PASS verdict
 *   - Converts REJECTED into VERIFIED due to an outage
 *   - Logs raw tokens, assertions, or attestation objects
 */

import { Request, Response, NextFunction } from 'express';
import { AppIntegrityService } from './app-integrity.service';
import {
  DeviceIntegrityStatus,
  IntegrityEvidenceInput,
  IntegrityProvider,
  DeviceIntegrityEvaluationResult,
} from './integrity.types';
import { getOperationPolicy } from './integrity.policy';

// Augment Express Request to carry the integrity result downstream
declare global {
  namespace Express {
    interface Request {
      integrityResult?: DeviceIntegrityEvaluationResult;
    }
  }
}

/**
 * Extracts integrity evidence from the request body or headers.
 * Fields: provider, challenge, token, keyId, attestationObject,
 *         assertionObject, clientData, appType, platform
 */
function _extractEvidence(req: Request): IntegrityEvidenceInput | null {
  const body = req.body ?? {};
  const integrityPayload = body.integrity ?? body;

  const provider = integrityPayload.provider as IntegrityProvider | undefined;
  const challenge = integrityPayload.challenge as string | undefined;

  if (!challenge || !provider) return null;

  return {
    provider,
    challenge: challenge.trim(),
    token: integrityPayload.token,
    keyId: integrityPayload.keyId,
    attestationObject: integrityPayload.attestationObject,
    assertionObject: integrityPayload.assertionObject,
    clientData: integrityPayload.clientData,
    appType: (req.headers['x-app-type'] as string | undefined) ?? integrityPayload.appType ?? 'customer',
    platform: req.headers['x-app-platform'] as string | undefined,
  };
}

/**
 * Creates Express middleware that enforces integrity for the specified operation.
 *
 * @param operation - Must match a key in INTEGRITY_OPERATION_POLICY or 'DEFAULT' is used.
 */
export function requireIntegrity(operation: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const policy = getOperationPolicy(operation);
    const userId = (req as any).user?.id ?? (req as any).user?.userId;
    const appType =
      (req.headers['x-app-type'] as string | undefined) ??
      req.body?.appType ??
      'customer';
    const clientOsVersion =
      (req.headers['x-client-os-version'] as string | undefined) ??
      req.body?.osVersion;

    // Observe-only mode: evaluate but never block
    if (policy.mode === 'observe') {
      const evidence = _extractEvidence(req);
      if (evidence) {
        try {
          const result = await AppIntegrityService.evaluateOrFallback({
            evidence,
            appType,
            operation,
            userId,
            clientOsVersion,
          });
          req.integrityResult = result;
        } catch {
          // Observe mode: evaluation errors must never block the request
        }
      }
      return next();
    }

    // Enforce / soft mode: evidence is required
    const evidence = _extractEvidence(req);

    if (!evidence) {
      if (policy.mode === 'soft') {
        // No evidence supplied — soft mode allows through but sets UNAVAILABLE
        req.integrityResult = {
          status: DeviceIntegrityStatus.UNAVAILABLE,
          provider: IntegrityProvider.NONE,
          riskScoreModifier: 0,
          reasons: ['NO_INTEGRITY_EVIDENCE_IN_REQUEST'],
          appType: appType.toLowerCase(),
          platform: 'unknown',
        };
        return next();
      }

      // 'enforce' mode — evidence is mandatory
      res.status(428).json({
        success: false,
        error: {
          code: 'INTEGRITY_EVIDENCE_REQUIRED',
          message: 'هذه العملية تتطلب التحقق من سلامة الجهاز. يرجى إرفاق بيانات التحقق.',
          operation,
        },
      });
      return;
    }

    // Verify the supplied evidence
    let result: DeviceIntegrityEvaluationResult;
    try {
      result = await AppIntegrityService.verifyIntegrityEvidence({
        evidence,
        expectedAppType: appType,
        expectedOperation: operation,
        userId,
        clientOsVersion,
      });
    } catch (err: any) {
      // Internal error during verification → treat as UNAVAILABLE
      result = {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: evidence.provider,
        riskScoreModifier: 0,
        reasons: ['INTEGRITY_SERVICE_INTERNAL_ERROR'],
        appType: appType.toLowerCase(),
        platform: 'unknown',
      };
    }

    req.integrityResult = result;

    // ── Policy decisions ────────────────────────────────────────────────────

    // VERIFIED → always allow
    if (result.status === DeviceIntegrityStatus.VERIFIED) {
      return next();
    }

    // REJECTED / INVALID → always block regardless of mode
    if (
      result.status === DeviceIntegrityStatus.REJECTED ||
      result.status === DeviceIntegrityStatus.INVALID
    ) {
      res.status(403).json({
        success: false,
        error: {
          code: 'INTEGRITY_CHECK_FAILED',
          message: 'تعذر التحقق من سلامة التطبيق. يرجى التحديث والمحاولة مجدداً.',
          status: result.status,
        },
      });
      return;
    }

    // EXPIRED → block; client must get a new challenge
    if (result.status === DeviceIntegrityStatus.EXPIRED) {
      res.status(401).json({
        success: false,
        error: {
          code: 'INTEGRITY_CHALLENGE_EXPIRED',
          message: 'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد والمحاولة مجدداً.',
          retryable: true,
        },
      });
      return;
    }

    // UNAVAILABLE:
    //   enforce → block with a retryable error
    //   soft    → allow (with elevated risk score already in integrityResult)
    if (result.status === DeviceIntegrityStatus.UNAVAILABLE) {
      if (policy.mode === 'enforce') {
        res.status(503).json({
          success: false,
          error: {
            code: 'INTEGRITY_SERVICE_UNAVAILABLE',
            message: 'خدمة التحقق من الجهاز غير متاحة مؤقتاً. يرجى المحاولة لاحقاً.',
            retryable: true,
          },
        });
        return;
      }
      // soft mode: allow through
      return next();
    }

    // Unexpected status — fail safe: block
    res.status(403).json({
      success: false,
      error: { code: 'INTEGRITY_UNKNOWN_STATUS', message: 'حالة تحقق غير معروفة.' },
    });
  };
}
