/**
 * SOUQNA — AR-2.5: App Integrity & Fraud Resistance
 * Authoritative Type Definitions & Evaluation Models
 */

export enum DeviceIntegrityStatus {
  /** Attestation signature, challenge binding, and device claims verified by server. */
  VERIFIED = 'VERIFIED',
  /** Device compromised, rooted, jailbroken, emulator, or forged signature detected. */
  REJECTED = 'REJECTED',
  /** Provider API unavailable on client (e.g. no Play Services, iOS < 14) or not configured on server. */
  UNAVAILABLE = 'UNAVAILABLE',
  /** Challenge expired before verification or token timestamp exceeds tolerance. */
  EXPIRED = 'EXPIRED',
  /** Malformed token, signature mismatch, wrong app ID, or mismatched challenge binding. */
  INVALID = 'INVALID',
}

export enum IntegrityProvider {
  GOOGLE_PLAY_INTEGRITY = 'GOOGLE_PLAY_INTEGRITY',
  APPLE_APP_ATTEST = 'APPLE_APP_ATTEST',
  NONE = 'NONE',
}

export interface IntegrityChallenge {
  id: string;
  nonce: string;
  userId?: string;
  appType: string;
  operation: string;
  createdAt: number;
  expiresAt: number;
}

export interface IntegrityEvidenceInput {
  provider: IntegrityProvider;
  challenge: string;
  token?: string; // Google Play Integrity token
  attestationObject?: string; // Apple App Attest attestation CBOR/base64
  keyId?: string; // Apple App Attest key ID
  assertionObject?: string; // Apple App Attest assertion CBOR/base64
  clientData?: string; // Apple App Attest clientData hash or JSON
  appType?: string;
  platform?: string;
}

export interface DeviceIntegrityEvaluationResult {
  status: DeviceIntegrityStatus;
  provider: IntegrityProvider;
  riskScoreModifier: number; // e.g. -15 for VERIFIED, +40 for REJECTED, 0 for UNAVAILABLE
  reasons: string[];
  appType: string;
  platform: string;
  verifiedAt?: Date;
  details?: {
    deviceRecognitionVerdict?: string[];
    appLicensingVerdict?: string;
    appRecognitionVerdict?: string;
    counter?: number;
    packageName?: string;
  };
}

export interface AppIntegrityConfig {
  enabled: boolean;
  enforcementMode: 'observe' | 'enforce';
  challengeTtlSeconds: number;
  googlePlay: {
    enabled: boolean;
    packageNames: string[];
    cloudProjectNumber?: string;
    serviceAccountKey?: string;
  };
  appleAppAttest: {
    enabled: boolean;
    appIds: string[]; // TeamID.BundleID
    production: boolean;
  };
}
