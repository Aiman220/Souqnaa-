import crypto from 'crypto';
import { SocialAccountType } from '../modules/auth/social/social-auth.types';

export interface OAuthStatePayload {
  sessionKey: string;
  role: SocialAccountType;
  platform: string;
  provider: string;
}

export function signSingleUseOAuthState(payload: OAuthStatePayload, secret: string): string {
  const data = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export async function consumeSingleUseOAuthState(
  state: string,
  secret: string,
  consume: (state: string) => Promise<string | null>
): Promise<OAuthStatePayload | null> {
  try {
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    const [data, signature] = parts;
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
    const signedPayload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof signedPayload.iat !== 'number' || Date.now() - signedPayload.iat >= 25 * 60 * 1000) return null;
    const cached = await consume(state);
    if (!cached) return null;
    const payload = JSON.parse(cached) as OAuthStatePayload;
    if (payload.sessionKey !== signedPayload.sessionKey || payload.role !== signedPayload.role ||
        payload.platform !== signedPayload.platform || payload.provider !== signedPayload.provider) return null;
    return payload;
  } catch {
    return null;
  }
}
