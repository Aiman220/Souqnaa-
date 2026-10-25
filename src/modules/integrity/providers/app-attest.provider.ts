/**
 * SOUQNA — AR-2.5: Apple App Attest Provider
 *
 * Full server-side verification of Apple App Attest attestations and assertions.
 *
 * Attestation flow (registration):
 *   1. Decode CBOR attestation object
 *   2. Verify certificate chain against Apple App Attest Root CA
 *   3. Verify nonce in leaf certificate OID 1.2.840.113635.100.8.2
 *   4. Verify rpIdHash = SHA256(teamId.bundleId)
 *   5. Verify AAGUID (appattestdevelop / appattest)
 *   6. Verify credentialId = SHA256(credentialPublicKey)
 *   7. Verify initial counter = 0
 *   8. Store public key in Redis bound to keyId
 *
 * Assertion flow (ongoing operations):
 *   1. Decode CBOR assertion object
 *   2. Retrieve stored public key for keyId
 *   3. Verify ECDSA signature over SHA256(authData || SHA256(clientData))
 *   4. Verify counter strictly advances (replay prevention)
 *   5. Update stored counter atomically
 *
 * Safety rules:
 * - Never accept a client-provided public key or app identity without attestation binding.
 * - Missing configuration returns UNAVAILABLE, not VERIFIED.
 * - Certificate parsing errors return INVALID, not VERIFIED.
 * - Tokens and raw attestation objects are never logged.
 */

import crypto, { X509Certificate } from 'crypto';
import { DeviceIntegrityStatus, IntegrityProvider } from '../integrity.types';
import { redisService } from '../../../database/redis';

export interface AppAttestVerificationParams {
  keyId: string;
  expectedNonce: string;
  expectedAppId: string; // TeamID.BundleID (e.g. ABCDE12345.com.souqnaa.app)
  clientOsVersion?: string;
  /** Base64-encoded CBOR attestation object (first-time registration) */
  attestationObject?: string;
  /** Base64-encoded CBOR assertion object (subsequent operations) */
  assertionObject?: string;
  /** Raw challenge string used as clientData for assertion signature */
  clientData?: string;
}

export interface AppAttestVerificationResult {
  status: DeviceIntegrityStatus;
  provider: IntegrityProvider;
  reasons: string[];
  riskScoreModifier: number;
  details?: {
    counter?: number;
    keyId?: string;
    appId?: string;
  };
}

// ─── Apple App Attest Root CA (embedded — publicly distributed by Apple) ─────
const APPLE_APP_ATTEST_ROOT_CA_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw\n' +
  'JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK\n' +
  'QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa\n' +
  'Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv\n' +
  'biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y\n' +
  'bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTbQlEE7cI4\n' +
  'z1jInDWEfk7VhBU6MMY90dYguB3WGFdNk3M2IHDaEpvAFaFMdHF/B29gAMOgMm/9\n' +
  'gujDiQmEIECe7mRMIslYhA6RHp7gCtAJo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0G\n' +
  'A1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYI\n' +
  'KoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5\n' +
  '+FRXgeLhpJ06yzC3gLAuAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ\n' +
  '5TfcLLeABLE4BNJnY5YkHwEX\n' +
  '-----END CERTIFICATE-----';

// AAGUID bytes: "appattestdevelop" and "appattest" + 7 zeros
const AAGUID_DEVELOPMENT = Buffer.from('61707061747465737464657665' + '6c6f70', 'hex'); // appattestdevelop
const AAGUID_PRODUCTION = Buffer.from('617070617474657374' + '00000000000000', 'hex');  // appattest\x00*7

const REDIS_KEY_PUBKEY = 'integrity:appattest:pubkey:';
const REDIS_KEY_COUNTER = 'integrity:appattest:counter:';
const PUBKEY_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

export class AppAttestProvider {
  public static readonly AUTHORIZED_BUNDLE_IDS: Record<string, string> = {
    customer: 'com.souqnaa.app',
    seller: 'com.souqnaa.seller',
    admin: 'com.souqnaa.admin',
  };

  // ─── Public entry point ─────────────────────────────────────────────────────

  public static async verifyEvidence(
    params: AppAttestVerificationParams
  ): Promise<AppAttestVerificationResult> {
    const { keyId, expectedNonce, expectedAppId, clientOsVersion, attestationObject, assertionObject, clientData } = params;

    // 1. iOS 14+ requirement (App Attest not available on older OS)
    if (clientOsVersion) {
      const major = parseInt(clientOsVersion.split('.')[0], 10);
      if (!isNaN(major) && major < 14) {
        return _unavailable([
          `APP_ATTEST_NOT_SUPPORTED_ON_IOS_${major}`,
          `APP_ATTEST_NOT_SUPPORTED_IOS_${major}_REQUIRES_14_PLUS`,
        ]);
      }
    }

    // 2. keyId required for all paths
    if (!keyId || typeof keyId !== 'string' || keyId.trim().length === 0) {
      return _invalid(['MISSING_APP_ATTEST_KEY_ID'], 20);
    }

    // 3. Server-side configuration check
    if (!process.env.APP_ATTEST_ENABLED || process.env.APP_ATTEST_ENABLED !== 'true') {
      return _unavailable([
        'APP_ATTEST_BACKEND_CREDENTIALS_NOT_CONFIGURED',
        'APP_ATTEST_BACKEND_NOT_ENABLED',
      ]);
    }
    if (!process.env.APPLE_TEAM_ID) {
      return _unavailable([
        'APP_ATTEST_BACKEND_CREDENTIALS_NOT_CONFIGURED',
        'APP_ATTEST_APPLE_TEAM_ID_NOT_CONFIGURED',
      ]);
    }

    // 4. Route: attestation (first-time registration) vs assertion (ongoing)
    if (attestationObject) {
      return this._verifyAttestation(keyId, expectedNonce, expectedAppId, attestationObject);
    }
    if (assertionObject) {
      return this._verifyAssertion(keyId, expectedNonce, expectedAppId, assertionObject, clientData ?? expectedNonce);
    }

    return _unavailable(['APP_ATTEST_NO_ATTESTATION_OR_ASSERTION_SUPPLIED']);
  }

  // ─── Attestation verification ───────────────────────────────────────────────

  private static async _verifyAttestation(
    keyId: string,
    expectedNonce: string,
    expectedAppId: string,
    attestationObjectB64: string
  ): Promise<AppAttestVerificationResult> {
    try {
      // ── 1. Decode CBOR ────────────────────────────────────────────────────
      const { decode } = await _cborImport();
      const attestationBuf = Buffer.from(attestationObjectB64, 'base64');
      const attestationObj: any = decode(attestationBuf);

      if (!attestationObj || attestationObj.fmt !== 'apple-appattest') {
        return _invalid(['APP_ATTEST_INVALID_FORMAT:expected_apple-appattest'], 30);
      }

      const authData: Buffer = Buffer.isBuffer(attestationObj.authData)
        ? attestationObj.authData
        : Buffer.from(attestationObj.authData);

      const x5c: Buffer[] = (attestationObj.attStmt?.x5c ?? []).map((c: any) =>
        Buffer.isBuffer(c) ? c : Buffer.from(c)
      );

      if (x5c.length < 2) {
        return _invalid(['APP_ATTEST_CERT_CHAIN_INCOMPLETE:need_leaf_and_intermediate'], 30);
      }

      // ── 2. Certificate chain trust ────────────────────────────────────────
      const chainResult = _verifyCertChain(x5c[0], x5c[1]);
      if (!chainResult.valid) {
        return _invalid([`APP_ATTEST_CERT_CHAIN_INVALID:${chainResult.reason}`], 40);
      }
      const leafCert = chainResult.leafCert!;

      // ── 3. Nonce binding ──────────────────────────────────────────────────
      // nonce = SHA256(authData || SHA256(challenge))
      const clientDataHash = crypto.createHash('sha256').update(expectedNonce).digest();
      const composite = Buffer.concat([authData, clientDataHash]);
      const expectedNonceBytes = crypto.createHash('sha256').update(composite).digest();

      const certNonce = _extractAppAttestNonce(Buffer.from(leafCert.raw));
      if (!certNonce) {
        return _invalid(['APP_ATTEST_NONCE_EXTENSION_NOT_FOUND_IN_CERT'], 40);
      }
      if (!certNonce.equals(expectedNonceBytes)) {
        return _invalid(['APP_ATTEST_NONCE_MISMATCH'], 45);
      }

      // ── 4. Parse authenticatorData ────────────────────────────────────────
      const authDataParsed = _parseAuthData(authData);
      if (!authDataParsed) {
        return _invalid(['APP_ATTEST_AUTHDATA_PARSE_FAILED'], 30);
      }

      // ── 5. rpIdHash = SHA256(teamId.bundleId) ─────────────────────────────
      const expectedRpId = crypto.createHash('sha256').update(expectedAppId).digest();
      if (!authDataParsed.rpIdHash.equals(expectedRpId)) {
        return _invalid([`APP_ATTEST_RPID_HASH_MISMATCH:expected=${expectedAppId}`], 50);
      }

      // ── 6. AAGUID check (dev vs prod environment) ─────────────────────────
      if (authDataParsed.aaguid) {
        const isDevAaguid = authDataParsed.aaguid.equals(AAGUID_DEVELOPMENT);
        const isProdAaguid = authDataParsed.aaguid.equals(AAGUID_PRODUCTION);
        const isProdEnv = process.env.NODE_ENV === 'production';

        if (!isDevAaguid && !isProdAaguid) {
          return _invalid(['APP_ATTEST_AAGUID_UNRECOGNIZED'], 45);
        }
        if (isProdEnv && isDevAaguid) {
          return _invalid(['APP_ATTEST_DEV_AAGUID_IN_PRODUCTION_ENV'], 45);
        }
      }

      // ── 7. Credential ID = SHA256(public key) ─────────────────────────────
      if (authDataParsed.credentialId && authDataParsed.credentialPublicKey) {
        const pubKeyHash = crypto
          .createHash('sha256')
          .update(authDataParsed.credentialPublicKey)
          .digest('base64');
        const credIdB64 = authDataParsed.credentialId.toString('base64');
        if (pubKeyHash !== credIdB64) {
          return _invalid(['APP_ATTEST_CREDENTIAL_ID_PUBKEY_HASH_MISMATCH'], 45);
        }
      }

      // ── 8. Initial counter must be 0 ──────────────────────────────────────
      if (authDataParsed.counter !== 0) {
        return _invalid([`APP_ATTEST_INITIAL_COUNTER_NONZERO:${authDataParsed.counter}`], 35);
      }

      // ── 9. Duplicate registration protection ──────────────────────────────
      const existingKey = await redisService.get(`${REDIS_KEY_PUBKEY}${keyId}`);
      if (existingKey) {
        return _invalid(['APP_ATTEST_KEY_ALREADY_REGISTERED_DUPLICATE_ATTESTATION'], 30);
      }

      // ── 10. Store public key from leaf cert ────────────────────────────────
      const publicKeyDer = leafCert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      await redisService.set(
        `${REDIS_KEY_PUBKEY}${keyId}`,
        publicKeyDer.toString('base64'),
        PUBKEY_TTL_SECONDS
      );
      // Initialize counter to 0
      await redisService.setCounter(`${REDIS_KEY_COUNTER}${keyId}`, 0);

      return {
        status: DeviceIntegrityStatus.VERIFIED,
        provider: IntegrityProvider.APPLE_APP_ATTEST,
        reasons: [],
        riskScoreModifier: -15,
        details: { counter: 0, keyId, appId: expectedAppId },
      };
    } catch (err: any) {
      // Sanitize: never include the raw attestation bytes in error reasons
      return _invalid([`APP_ATTEST_ATTESTATION_EXCEPTION:${err?.constructor?.name ?? 'Error'}`], 30);
    }
  }

  // ─── Assertion verification ─────────────────────────────────────────────────

  private static async _verifyAssertion(
    keyId: string,
    expectedNonce: string,
    expectedAppId: string,
    assertionObjectB64: string,
    clientData: string
  ): Promise<AppAttestVerificationResult> {
    try {
      // ── 1. Retrieve stored public key ──────────────────────────────────────
      const storedPubKeyB64 = await redisService.get(`${REDIS_KEY_PUBKEY}${keyId}`);
      if (!storedPubKeyB64) {
        return _invalid(['APP_ATTEST_KEY_NOT_REGISTERED:attest_first'], 35);
      }

      const publicKey = crypto.createPublicKey({
        key: Buffer.from(storedPubKeyB64, 'base64'),
        format: 'der',
        type: 'spki',
      });

      // ── 2. Decode CBOR assertion ───────────────────────────────────────────
      const { decode } = await _cborImport();
      const assertionBuf = Buffer.from(assertionObjectB64, 'base64');
      const assertionObj: any = decode(assertionBuf);

      if (!assertionObj?.signature || !assertionObj?.authenticatorData) {
        return _invalid(['APP_ATTEST_ASSERTION_MISSING_SIGNATURE_OR_AUTHDATA'], 30);
      }

      const signature: Buffer = Buffer.isBuffer(assertionObj.signature)
        ? assertionObj.signature
        : Buffer.from(assertionObj.signature);

      const authData: Buffer = Buffer.isBuffer(assertionObj.authenticatorData)
        ? assertionObj.authenticatorData
        : Buffer.from(assertionObj.authenticatorData);

      // ── 3. Parse authenticatorData ────────────────────────────────────────
      const authDataParsed = _parseAuthData(authData);
      if (!authDataParsed) {
        return _invalid(['APP_ATTEST_ASSERTION_AUTHDATA_PARSE_FAILED'], 30);
      }

      // ── 4. rpIdHash check ─────────────────────────────────────────────────
      const expectedRpId = crypto.createHash('sha256').update(expectedAppId).digest();
      if (!authDataParsed.rpIdHash.equals(expectedRpId)) {
        return _invalid(['APP_ATTEST_ASSERTION_RPID_HASH_MISMATCH'], 45);
      }

      // ── 5. Verify ECDSA signature ─────────────────────────────────────────
      // nonce = SHA256(authData || SHA256(clientData))
      const clientDataHash = crypto.createHash('sha256').update(clientData).digest();
      const nonce = crypto
        .createHash('sha256')
        .update(Buffer.concat([authData, clientDataHash]))
        .digest();

      const signatureValid = crypto.verify(null, nonce, publicKey, signature);
      if (!signatureValid) {
        return _invalid(['APP_ATTEST_ASSERTION_SIGNATURE_INVALID'], 50);
      }

      // ── 6. Counter strictly advances (replay prevention) ──────────────────
      return await this.verifyAssertionCounter(keyId, authDataParsed, expectedAppId);
    } catch (err: any) {
      return _invalid([`APP_ATTEST_ASSERTION_EXCEPTION:${err?.constructor?.name ?? 'Error'}`], 30);
    }
  }

  /**
   * Validates assertion counter strictly advances in Redis (replay prevention).
   */
  public static async verifyAssertionCounter(
    keyId: string,
    authData: { counter: number },
    expectedAppId: string
  ): Promise<AppAttestVerificationResult> {
    const counterKey = `${REDIS_KEY_COUNTER}${keyId}`;
    const lock = await redisService.acquireLock(`lock:${counterKey}`, 5);

    if (!lock.acquired) {
      return _invalid(['APP_ATTEST_COUNTER_LOCK_CONTENTION_POSSIBLE_REPLAY'], 35);
    }

    try {
      const storedCounter = await redisService.getCounter(counterKey);
      const incomingCounter = authData.counter;

      if (incomingCounter <= storedCounter) {
        return {
          status: DeviceIntegrityStatus.REJECTED,
          provider: IntegrityProvider.APPLE_APP_ATTEST,
          reasons: [
            'APP_ATTEST_COUNTER_REPLAY_DETECTED',
            `APP_ATTEST_COUNTER_REPLAY:incoming=${incomingCounter}<=stored=${storedCounter}`,
          ],
          riskScoreModifier: 45,
          details: { counter: incomingCounter, keyId, appId: expectedAppId },
        };
      }

      await redisService.setCounter(counterKey, incomingCounter);

      return {
        status: DeviceIntegrityStatus.VERIFIED,
        provider: IntegrityProvider.APPLE_APP_ATTEST,
        reasons: [],
        riskScoreModifier: -15,
        details: { counter: incomingCounter, keyId, appId: expectedAppId },
      };
    } finally {
      await redisService.releaseLock(`lock:${counterKey}`, lock.token);
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Dynamically imports cbor-x to avoid hard crash when package is absent. */
async function _cborImport(): Promise<{ decode: (buf: Buffer) => any }> {
  try {
    const mod = await import('cbor-x');
    return { decode: mod.decode ?? (mod as any).default?.decode };
  } catch {
    throw new Error('CBOR_X_PACKAGE_NOT_INSTALLED');
  }
}

/** Verifies leaf and intermediate against the embedded Apple App Attest Root CA. */
function _verifyCertChain(
  leafDer: Buffer,
  intermediateDer: Buffer
): { valid: boolean; reason?: string; leafCert?: X509Certificate } {
  try {
    const rootCa = new X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM);
    const intermediate = new X509Certificate(intermediateDer);
    const leaf = new X509Certificate(leafDer);

    if (!intermediate.verify(rootCa.publicKey)) {
      return { valid: false, reason: 'INTERMEDIATE_NOT_SIGNED_BY_APPLE_ROOT_CA' };
    }
    if (!leaf.verify(intermediate.publicKey)) {
      return { valid: false, reason: 'LEAF_NOT_SIGNED_BY_INTERMEDIATE' };
    }
    return { valid: true, leafCert: leaf };
  } catch (err: any) {
    return { valid: false, reason: `CERT_PARSE_ERROR:${err?.constructor?.name}` };
  }
}

/**
 * Extracts the 32-byte nonce from leaf cert OID 1.2.840.113635.100.8.2.
 * Extension structure: OCTET STRING wrapping SEQUENCE { OCTET STRING { <32 bytes> } }.
 */
function _extractAppAttestNonce(certDer: Buffer): Buffer | null {
  // OID tag (06) + length (09) + OID value for 1.2.840.113635.100.8.2
  const oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

  for (let i = 0; i <= certDer.length - oid.length; i++) {
    if (!certDer.slice(i, i + oid.length).equals(oid)) continue;

    let pos = i + oid.length;

    // Skip optional BOOLEAN (critical flag: 01 01 ff)
    if (pos < certDer.length && certDer[pos] === 0x01) {
      const { bytesRead, length } = _derLen(certDer, pos + 1);
      pos += 1 + bytesRead + length;
    }

    // Outer OCTET STRING (extnValue)
    if (pos >= certDer.length || certDer[pos] !== 0x04) continue;
    pos++;
    const { bytesRead: lbr, length: evLen } = _derLen(certDer, pos);
    pos += lbr;
    const extnValue = certDer.slice(pos, pos + evLen);

    // Inner: SEQUENCE { OCTET STRING { <32 bytes> } }
    if (extnValue.length < 4 || extnValue[0] !== 0x30) continue;
    let ip = 1;
    const { bytesRead: sbr } = _derLen(extnValue, ip);
    ip += sbr;

    if (ip >= extnValue.length || extnValue[ip] !== 0x04) continue;
    ip++;
    const { bytesRead: nbr, length: nonceLen } = _derLen(extnValue, ip);
    ip += nbr;

    if (nonceLen !== 32) continue;
    return extnValue.slice(ip, ip + 32);
  }
  return null;
}

/** Minimal DER length reader (handles short and long form). */
function _derLen(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  if (offset >= buf.length) return { length: 0, bytesRead: 1 };
  const first = buf[offset];
  if ((first & 0x80) === 0) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length * 256) + (buf[offset + 1 + i] ?? 0);
  }
  return { length, bytesRead: 1 + numBytes };
}

/**
 * Parses the Apple authenticatorData structure.
 * Layout: rpIdHash(32) | flags(1) | counter(4) | [attestedCredentialData...]
 */
function _parseAuthData(authData: Buffer): {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  credentialPublicKey?: Buffer;
} | null {
  if (authData.length < 37) return null;

  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const counter = authData.readUInt32BE(33);

  let aaguid: Buffer | undefined;
  let credentialId: Buffer | undefined;
  let credentialPublicKey: Buffer | undefined;

  // Bit 6 (0x40) = attested credential data present
  if (flags & 0x40 && authData.length > 37) {
    let pos = 37;
    if (authData.length >= pos + 16) {
      aaguid = authData.slice(pos, pos + 16);
      pos += 16;
    }
    if (authData.length >= pos + 2) {
      const credIdLen = authData.readUInt16BE(pos);
      pos += 2;
      if (authData.length >= pos + credIdLen) {
        credentialId = authData.slice(pos, pos + credIdLen);
        pos += credIdLen;
        if (pos < authData.length) {
          credentialPublicKey = authData.slice(pos);
        }
      }
    }
  }

  return { rpIdHash, flags, counter, aaguid, credentialId, credentialPublicKey };
}

/** Returns a typed UNAVAILABLE result. */
function _unavailable(reasons: string[]): AppAttestVerificationResult {
  return { status: DeviceIntegrityStatus.UNAVAILABLE, provider: IntegrityProvider.APPLE_APP_ATTEST, reasons, riskScoreModifier: 0 };
}

/** Returns a typed INVALID result. */
function _invalid(reasons: string[], riskScoreModifier: number): AppAttestVerificationResult {
  return { status: DeviceIntegrityStatus.INVALID, provider: IntegrityProvider.APPLE_APP_ATTEST, reasons, riskScoreModifier };
}
