/**
 * SOUQNA — AR-2.5: Unified App Integrity Service
 * 
 * Orchestrates challenge issuance, single-use nonce consumption, provider routing,
 * server-side evidence evaluation, risk-based scoring, and privacy-preserving audit telemetry.
 */

import {
  DeviceIntegrityStatus,
  IntegrityProvider,
  IntegrityChallenge,
  IntegrityEvidenceInput,
  DeviceIntegrityEvaluationResult,
} from './integrity.types';
import { IntegrityChallengeService } from './services/integrity-challenge.service';
import { PlayIntegrityProvider } from './providers/play-integrity.provider';
import { AppAttestProvider } from './providers/app-attest.provider';

export class AppIntegrityService {
  /**
   * Issues a short-lived, single-use cryptographic challenge for a requested operation.
   */
  public static async createChallenge(params: {
    appType: string;
    operation: string;
    userId?: string;
    ttlSeconds?: number;
  }): Promise<IntegrityChallenge> {
    return IntegrityChallengeService.createChallenge(params);
  }

  /**
   * Verifies submitted client integrity evidence server-side.
   * Atomically consumes the challenge to defeat replay attacks.
   */
  public static async verifyIntegrityEvidence(params: {
    evidence: IntegrityEvidenceInput;
    expectedAppType: string;
    expectedOperation: string;
    userId?: string;
    clientOsVersion?: string;
  }): Promise<DeviceIntegrityEvaluationResult> {
    const { evidence, expectedAppType, expectedOperation, userId, clientOsVersion } = params;

    const normalizedAppType = expectedAppType.toLowerCase();
    const platform = (evidence.platform || (evidence.provider === IntegrityProvider.GOOGLE_PLAY_INTEGRITY ? 'android' : 'ios')).toLowerCase();

    // 1. Validate and consume single-use challenge nonce
    const challengeResult = await IntegrityChallengeService.consumeChallenge({
      nonce: evidence.challenge,
      expectedAppType: normalizedAppType,
      expectedOperation,
      userId,
    });

    if (!challengeResult.valid) {
      const isExpired = challengeResult.reason === 'CHALLENGE_EXPIRED';
      return {
        status: isExpired ? DeviceIntegrityStatus.EXPIRED : DeviceIntegrityStatus.INVALID,
        provider: evidence.provider,
        riskScoreModifier: isExpired ? 20 : 35,
        reasons: [challengeResult.reason || 'CHALLENGE_VALIDATION_FAILED'],
        appType: normalizedAppType,
        platform,
      };
    }

    // 2. Route evidence to corresponding authoritative platform provider
    let evaluation: DeviceIntegrityEvaluationResult;

    if (evidence.provider === IntegrityProvider.GOOGLE_PLAY_INTEGRITY) {
      const expectedPackage = PlayIntegrityProvider.AUTHORIZED_PACKAGES[normalizedAppType] || 'com.souqnaa.app';
      const playResult = await PlayIntegrityProvider.verifyToken({
        token: evidence.token || '',
        expectedNonce: evidence.challenge,
        expectedPackageName: expectedPackage,
      });

      evaluation = {
        status: playResult.status,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        riskScoreModifier: playResult.riskScoreModifier,
        reasons: playResult.reasons,
        appType: normalizedAppType,
        platform: 'android',
        verifiedAt: playResult.status === DeviceIntegrityStatus.VERIFIED ? new Date() : undefined,
        details: playResult.details,
      };
    } else if (evidence.provider === IntegrityProvider.APPLE_APP_ATTEST) {
      const bundleId = AppAttestProvider.AUTHORIZED_BUNDLE_IDS[normalizedAppType] || 'com.souqnaa.app';
      const teamId = process.env.APPLE_TEAM_ID || 'TEAM_ID';
      const expectedAppId = `${teamId}.${bundleId}`;

      const attestResult = await AppAttestProvider.verifyEvidence({
        keyId: evidence.keyId || '',
        expectedNonce: evidence.challenge,
        expectedAppId,
        clientOsVersion,
        attestationObject: evidence.attestationObject,
        assertionObject: evidence.assertionObject,
        clientData: evidence.clientData,
      });

      evaluation = {
        status: attestResult.status,
        provider: IntegrityProvider.APPLE_APP_ATTEST,
        riskScoreModifier: attestResult.riskScoreModifier,
        reasons: attestResult.reasons,
        appType: normalizedAppType,
        platform: 'ios',
        verifiedAt: attestResult.status === DeviceIntegrityStatus.VERIFIED ? new Date() : undefined,
        details: attestResult.details,
      };
    } else {
      // Missing or unsupported provider evidence
      evaluation = {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.NONE,
        riskScoreModifier: 0,
        reasons: ['UNSUPPORTED_OR_MISSING_INTEGRITY_PROVIDER'],
        appType: normalizedAppType,
        platform,
      };
    }

    // 3. Privacy-preserving audit logging (never logs tokens, credentials, or private keys)
    this.logIntegrityOutcome(evaluation, userId, expectedOperation);

    return evaluation;
  }

  /**
   * Helper that evaluates integrity evidence or safely returns UNAVAILABLE when none provided.
   */
  public static async evaluateOrFallback(params: {
    evidence?: IntegrityEvidenceInput;
    appType: string;
    operation: string;
    userId?: string;
    clientOsVersion?: string;
  }): Promise<DeviceIntegrityEvaluationResult> {
    if (!params.evidence || !params.evidence.challenge) {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.NONE,
        riskScoreModifier: 0,
        reasons: ['NO_INTEGRITY_EVIDENCE_SUPPLIED'],
        appType: params.appType.toLowerCase(),
        platform: 'unknown',
      };
    }

    return this.verifyIntegrityEvidence({
      evidence: params.evidence,
      expectedAppType: params.appType,
      expectedOperation: params.operation,
      userId: params.userId,
      clientOsVersion: params.clientOsVersion,
    });
  }

  /**
   * Records sanitized, aggregate audit telemetry without logging credentials or raw tokens.
   */
  private static logIntegrityOutcome(
    evalResult: DeviceIntegrityEvaluationResult,
    userId?: string,
    operation?: string
  ): void {
    // Structured audit logging adhering strictly to privacy boundaries:
    // No tokens, no secrets, no intrusive device fingerprints.
    const auditRecord = {
      timestamp: new Date().toISOString(),
      event: 'APP_INTEGRITY_EVALUATION',
      status: evalResult.status,
      provider: evalResult.provider,
      appType: evalResult.appType,
      platform: evalResult.platform,
      operation: operation || 'UNKNOWN',
      userId: userId ? `usr_${userId.slice(-6)}` : 'anonymous',
      riskModifier: evalResult.riskScoreModifier,
      reasonsCount: evalResult.reasons.length,
    };

    if (evalResult.status === DeviceIntegrityStatus.REJECTED) {
      console.warn(`[AppIntegrity] Suspicious/Rejected evidence: ${JSON.stringify(auditRecord)}`);
    }
  }
}
