/**
 * SOUQNA — AR-2.5: Google Play Integrity Provider
 *
 * Verifies Android Play Integrity evidence server-side using the official
 * Google Play Integrity API (googleapis v1 decodeIntegrityToken).
 *
 * Safety rules (non-negotiable):
 * - Credentials live server-side only; never embedded in the Flutter app.
 * - A missing credential returns UNAVAILABLE, not VERIFIED.
 * - An API or network error returns INVALID/UNAVAILABLE, never VERIFIED.
 * - Tokens, credentials, and private key material are never logged.
 */

import { DeviceIntegrityStatus, IntegrityProvider } from '../integrity.types';

export interface PlayIntegrityVerificationParams {
  token: string;
  expectedNonce: string;
  expectedPackageName: string;
  cloudProjectNumber?: string;
}

export interface PlayIntegrityVerificationResult {
  status: DeviceIntegrityStatus;
  provider: IntegrityProvider;
  reasons: string[];
  riskScoreModifier: number;
  details?: {
    deviceRecognitionVerdict?: string[];
    appRecognitionVerdict?: string;
    appLicensingVerdict?: string;
    packageName?: string;
    timestampMillis?: number;
  };
}

export class PlayIntegrityProvider {
  /** Authoritative Android package names per app type. */
  public static readonly AUTHORIZED_PACKAGES: Record<string, string> = {
    customer: 'com.souqnaa.app',
    seller: 'com.souqnaa.seller',
    admin: 'com.souqnaa.admin',
  };

  /**
   * Verifies a Google Play Integrity token server-side.
   * Calls Google's decodeIntegrityToken API when credentials are configured.
   */
  public static async verifyToken(
    params: PlayIntegrityVerificationParams
  ): Promise<PlayIntegrityVerificationResult> {
    const { token, expectedNonce, expectedPackageName } = params;

    // 1. Reject missing or malformed token immediately
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      return {
        status: DeviceIntegrityStatus.INVALID,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['MISSING_OR_MALFORMED_PLAY_INTEGRITY_TOKEN'],
        riskScoreModifier: 20,
      };
    }

    // 2. Require server-side credentials — never fabricate success without them
    const credentialJson =
      process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    if (!credentialJson) {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_BACKEND_CREDENTIALS_NOT_CONFIGURED'],
        riskScoreModifier: 0,
      };
    }

    try {
      const payload = await this._callGoogleApi(token, expectedPackageName, credentialJson);

      if (!payload) {
        return {
          status: DeviceIntegrityStatus.INVALID,
          provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
          reasons: ['PLAY_INTEGRITY_DECODE_RETURNED_EMPTY_PAYLOAD'],
          riskScoreModifier: 30,
        };
      }

      return this.evaluateDecodedPayload(payload, expectedNonce, expectedPackageName);
    } catch (error: any) {
      return this._mapApiError(error);
    }
  }

  /**
   * Calls the Google Play Integrity v1 decodeIntegrityToken API.
   * Authenticates with a service account JSON key from env.
   * Returns the tokenPayloadExternal object or null.
   */
  private static async _callGoogleApi(
    token: string,
    packageName: string,
    credentialJson: string
  ): Promise<any | null> {
    // Dynamic import to avoid load-time crash if googleapis is absent in dev
    let googleapis: any;
    try {
      googleapis = await import('googleapis');
    } catch {
      throw new Error('GOOGLEAPIS_PACKAGE_NOT_INSTALLED');
    }

    const { google } = googleapis;

    let credentials: any;
    try {
      credentials = JSON.parse(credentialJson);
    } catch {
      throw new Error('PLAY_INTEGRITY_CREDENTIALS_INVALID_JSON');
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/playintegrity'],
    });

    const playintegrity = google.playintegrity({ version: 'v1', auth });

    // packageName used as the resource name in the API path
    const response = await playintegrity.v1.decodeIntegrityToken({
      packageName,
      requestBody: { integrityToken: token },
    });

    return response?.data?.tokenPayloadExternal ?? null;
  }

  /**
   * Maps Google API errors to typed verdicts without logging tokens.
   */
  private static _mapApiError(error: any): PlayIntegrityVerificationResult {
    const code = error?.code ?? 0;
    const msg: string = error?.message ?? 'UNKNOWN';

    // 429 / quota / rate limit → UNAVAILABLE (retryable)
    if (
      code === 429 ||
      msg.includes('QUOTA_EXCEEDED') ||
      msg.includes('RATE_LIMIT') ||
      msg.includes('rateLimitExceeded')
    ) {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_QUOTA_EXCEEDED_OR_RATE_LIMITED'],
        riskScoreModifier: 0,
      };
    }

    // 503 / network errors → UNAVAILABLE
    if (code === 503 || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_SERVICE_TEMPORARILY_UNAVAILABLE'],
        riskScoreModifier: 0,
      };
    }

    // 403 permission / project misconfiguration → blocker, not retryable
    if (code === 403 || msg.includes('PERMISSION_DENIED')) {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_PERMISSION_DENIED_CHECK_GCP_IAM'],
        riskScoreModifier: 0,
      };
    }

    // Missing googleapis package (dev environment)
    if (msg === 'GOOGLEAPIS_PACKAGE_NOT_INSTALLED') {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_GOOGLEAPIS_PACKAGE_NOT_INSTALLED'],
        riskScoreModifier: 0,
      };
    }

    // Credential JSON malformed
    if (msg === 'PLAY_INTEGRITY_CREDENTIALS_INVALID_JSON') {
      return {
        status: DeviceIntegrityStatus.UNAVAILABLE,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['PLAY_INTEGRITY_CREDENTIALS_INVALID_JSON'],
        riskScoreModifier: 0,
      };
    }

    // All other errors → INVALID (cryptographic or protocol failure)
    // Sanitize message: never expose raw API error text that may contain token data
    return {
      status: DeviceIntegrityStatus.INVALID,
      provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
      reasons: [`PLAY_INTEGRITY_API_ERROR:code=${code}`],
      riskScoreModifier: 25,
    };
  }

  /**
   * Evaluates the decoded tokenPayloadExternal against security criteria.
   * Checks: nonce binding, package identity, freshness, device verdicts, app recognition.
   */
  public static evaluateDecodedPayload(
    payload: any,
    expectedNonce: string,
    expectedPackageName: string
  ): PlayIntegrityVerificationResult {
    const reasons: string[] = [];

    const requestDetails = payload.requestDetails ?? {};
    const appIntegrity = payload.appIntegrity ?? {};
    const deviceIntegrity = payload.deviceIntegrity ?? {};
    const accountDetails = payload.accountDetails ?? {};

    // Play Integrity API can return nonce in requestDetails.nonce (classic) or
    // requestDetails.requestHash (request hash mode). Accept either.
    const receivedNonce: string | undefined =
      requestDetails.nonce ?? requestDetails.requestHash;
    const receivedPackage: string | undefined = appIntegrity.packageName;
    const timestampMillis = parseInt(requestDetails.timestampMillis ?? '0', 10);
    const deviceVerdicts: string[] = deviceIntegrity.deviceRecognitionVerdict ?? [];
    const appRecognition: string = appIntegrity.appRecognitionVerdict ?? 'UNKNOWN';
    const licensing: string = accountDetails.appLicensingVerdict ?? 'UNKNOWN';

    // ── 1. Challenge / nonce binding ──────────────────────────────────────────
    if (!receivedNonce || receivedNonce !== expectedNonce) {
      return {
        status: DeviceIntegrityStatus.INVALID,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['CHALLENGE_NONCE_MISMATCH'],
        riskScoreModifier: 35,
      };
    }

    // ── 2. Package identity ───────────────────────────────────────────────────
    if (
      !receivedPackage ||
      receivedPackage.toLowerCase() !== expectedPackageName.toLowerCase()
    ) {
      return {
        status: DeviceIntegrityStatus.REJECTED,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: [
          `PACKAGE_NAME_MISMATCH:expected=${expectedPackageName},received=${receivedPackage ?? 'MISSING'}`,
        ],
        riskScoreModifier: 50,
      };
    }

    // ── 3. Freshness (token age ≤ 10 minutes) ─────────────────────────────────
    const now = Date.now();
    if (timestampMillis > 0 && Math.abs(now - timestampMillis) > 10 * 60 * 1000) {
      return {
        status: DeviceIntegrityStatus.EXPIRED,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons: ['INTEGRITY_TOKEN_EXPIRED', 'INTEGRITY_TOKEN_STALE_EXCEEDS_10_MINUTE_TOLERANCE'],
        riskScoreModifier: 20,
      };
    }

    // ── 4. Device recognition verdicts ───────────────────────────────────────
    const meetsBasic = deviceVerdicts.includes('MEETS_BASIC_INTEGRITY');
    const meetsDevice = deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY');
    const meetsStrong = deviceVerdicts.includes('MEETS_STRONG_INTEGRITY');

    if (!meetsBasic && !meetsDevice && !meetsStrong) {
      reasons.push('DEVICE_FAILED_ALL_INTEGRITY_CRITERIA');
      return {
        status: DeviceIntegrityStatus.REJECTED,
        provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
        reasons,
        riskScoreModifier: 40,
        details: { deviceRecognitionVerdict: deviceVerdicts, appRecognitionVerdict: appRecognition, appLicensingVerdict: licensing, packageName: receivedPackage, timestampMillis },
      };
    }

    // ── 5. App binary recognition (detect side-loaded / tampered) ─────────────
    if (appRecognition === 'UNAPPROVED_VERSION' || appRecognition === 'UNRECOGNIZED_VERSION') {
      reasons.push('UNRECOGNIZED_OR_TAMPERED_APP_BINARY');
    }

    const isVerified =
      (meetsDevice || meetsStrong || meetsBasic) &&
      appRecognition !== 'UNAPPROVED_VERSION' &&
      appRecognition !== 'UNRECOGNIZED_VERSION';

    return {
      status: isVerified ? DeviceIntegrityStatus.VERIFIED : DeviceIntegrityStatus.REJECTED,
      provider: IntegrityProvider.GOOGLE_PLAY_INTEGRITY,
      reasons,
      riskScoreModifier: isVerified ? -15 : 30,
      details: {
        deviceRecognitionVerdict: deviceVerdicts,
        appRecognitionVerdict: appRecognition,
        appLicensingVerdict: licensing,
        packageName: receivedPackage,
        timestampMillis,
      },
    };
  }
}
