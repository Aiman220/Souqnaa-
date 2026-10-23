/**
 * SOUQNA — AR-2.5: App Integrity Controller
 * 
 * Provides HTTP endpoints for challenge issuance and client evidence verification.
 * Enforces rate limiting, session binding, and non-sensitive response formatting.
 */

import { Request, Response } from 'express';
import { AppIntegrityService } from './app-integrity.service';
import { IntegrityProvider, IntegrityEvidenceInput } from './integrity.types';

export class IntegrityController {
  /**
   * POST /api/v1/integrity/challenge
   * Generates a cryptographically secure, single-use, time-bound challenge nonce.
   */
  public static async requestChallenge(req: Request, res: Response): Promise<void> {
    try {
      const { operation, appType: bodyAppType } = req.body || {};

      if (!operation || typeof operation !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_OPERATION',
            message: 'A valid operation identifier is required for integrity challenge issuance.',
          },
        });
        return;
      }

      // App type: header or body, defaulting safely to customer
      const headerAppType = req.headers['x-app-type'] as string | undefined;
      const appType = (headerAppType || bodyAppType || 'customer').toLowerCase();
      const userId = (req as any).user?.id;

      const challenge = await AppIntegrityService.createChallenge({
        appType,
        operation: operation.trim(),
        userId,
      });

      res.status(200).json({
        success: true,
        data: {
          challenge: challenge.nonce,
          expiresAt: challenge.expiresAt,
          ttlSeconds: Math.round((challenge.expiresAt - challenge.createdAt) / 1000),
        },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: {
          code: 'CHALLENGE_GENERATION_FAILED',
          message: 'Unable to generate integrity challenge at this time.',
        },
      });
    }
  }

  /**
   * POST /api/v1/integrity/verify
   * Verifies client integrity evidence and atomically consumes the challenge.
   */
  public static async verifyEvidence(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body || {};
      const { provider, challenge, operation, token, keyId, attestationObject, assertionObject, clientData } = body;

      if (!challenge || typeof challenge !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_CHALLENGE',
            message: 'Integrity challenge nonce is required.',
          },
        });
        return;
      }

      if (!operation || typeof operation !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_OPERATION',
            message: 'Operation context is required for verification.',
          },
        });
        return;
      }

      const headerAppType = req.headers['x-app-type'] as string | undefined;
      const appType = (headerAppType || body.appType || 'customer').toLowerCase();
      const userId = (req as any).user?.id;
      const clientOsVersion = (req.headers['x-client-os-version'] as string | undefined) || body.osVersion;

      const evidence: IntegrityEvidenceInput = {
        provider: provider as IntegrityProvider,
        challenge: challenge.trim(),
        token,
        keyId,
        attestationObject,
        assertionObject,
        clientData,
        appType,
        platform: req.headers['x-app-platform'] as string | undefined,
      };

      const result = await AppIntegrityService.verifyIntegrityEvidence({
        evidence,
        expectedAppType: appType,
        expectedOperation: operation.trim(),
        userId,
        clientOsVersion,
      });

      res.status(200).json({
        success: true,
        data: {
          status: result.status,
          provider: result.provider,
          riskScoreModifier: result.riskScoreModifier,
          reasons: result.reasons,
          verifiedAt: result.verifiedAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: {
          code: 'INTEGRITY_VERIFICATION_FAILED',
          message: 'Unable to complete integrity verification.',
        },
      });
    }
  }
}
