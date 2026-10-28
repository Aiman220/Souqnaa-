import { ISocialAuthProvider } from './social-provider.interface';
import { VerifiedSocialProfile, SocialProvider } from '../social-auth.types';
import { AppError } from '../../../../middleware/error.middleware';
import { config } from '../../../../config';

export class GoogleAuthenticationProvider implements ISocialAuthProvider {
  async verifyToken(credential: string, platform?: string): Promise<VerifiedSocialProfile> {
    if (!credential || typeof credential !== 'string' || credential.trim().length === 0) {
      throw new AppError('Google authentication credential is required.', 400, 'SOCIAL_INVALID_CREDENTIAL');
    }

    const trimmedToken = credential.trim();

    try {
      // 1. Query Google's token verification endpoint
      const response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(trimmedToken)}`,
        {
          headers: { Accept: 'application/json' },
        }
      );

      if (!response.ok) {
        // Fallback: in case the client passed an OAuth2 access_token rather than id_token
        const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: {
            Authorization: `Bearer ${trimmedToken}`,
            Accept: 'application/json',
          },
        });

        if (!userinfoRes.ok) {
          console.warn(
            `[GoogleAuthDiagnostic] stage=TOKEN_VERIFICATION status=FAILED tokeninfoHttpStatus=${response.status} userinfoHttpStatus=${userinfoRes.status} errorCategory=INVALID_OR_EXPIRED_TOKEN`
          );
          throw new AppError(
            'فشل التحقق من صحة بيانات الدخول عبر Google. قد تكون الجلسة منتهية الصلاحية.',
            401,
            'SOCIAL_INVALID_CREDENTIAL'
          );
        }

        const userInfo = (await userinfoRes.json()) as any;
        console.info('[GoogleAuthDiagnostic] stage=USERINFO_VERIFIED status=SUCCESS authType=access_token');
        return this.normalizeProfile(userInfo);
      }

      const payload = (await response.json()) as any;

      // 2. Validate token claims
      // A. Validate Subject
      if (!payload.sub || typeof payload.sub !== 'string') {
        console.warn('[GoogleAuthDiagnostic] stage=CLAIMS_VALIDATION status=FAILED errorCategory=MISSING_OR_INVALID_SUB');
        throw new AppError('Google token is missing a valid subject identifier.', 401, 'SOCIAL_INVALID_CREDENTIAL');
      }

      // B. Validate Issuer
      const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
      if (payload.iss && !validIssuers.includes(payload.iss)) {
        console.warn('[GoogleAuthDiagnostic] stage=CLAIMS_VALIDATION status=FAILED errorCategory=INVALID_ISSUER');
        throw new AppError('Google token issuer is not recognized or invalid.', 401, 'SOCIAL_INVALID_CREDENTIAL');
      }

      // C. Validate Expiration
      if (payload.exp) {
        const expTime = parseInt(payload.exp, 10);
        const now = Math.floor(Date.now() / 1000);
        if (expTime < now) {
          console.warn(
            `[GoogleAuthDiagnostic] stage=CLAIMS_VALIDATION status=FAILED errorCategory=EXPIRED_TOKEN expiredSecondsAgo=${now - expTime}`
          );
          throw new AppError('انتهت صلاحية رمز دخول Google، يرجى إعادة المحاولة.', 401, 'SOCIAL_EXPIRED_CREDENTIAL');
        }
      }

      // D. Validate Audience if configured
      const allowedAudiences = [
        config.oauth.google.clientId,
        config.oauth.google.androidClientId,
        config.oauth.google.androidCustomerClientId,
        config.oauth.google.androidSellerClientId,
        config.oauth.google.iosClientId,
        config.oauth.google.iosCustomerClientId,
        config.oauth.google.iosSellerClientId,
        config.oauth.google.serverClientId,
      ].filter((id): id is string =>
        typeof id === 'string' &&
        id.trim().length > 0 &&
        !id.includes('iuuiofake') &&
        !id.startsWith('your-') &&
        !id.includes('example')
      );

      if (allowedAudiences.length > 0 && (payload.aud || payload.azp)) {
        const isAudValid = allowedAudiences.some((aud) => {
          if (!aud) return false;
          if (aud === payload.aud || aud === payload.azp) return true;
          const projectNum = aud.split('-')[0];
          if (projectNum && projectNum.length >= 8) {
            if (typeof payload.aud === 'string' && payload.aud.startsWith(projectNum)) return true;
            if (typeof payload.azp === 'string' && payload.azp.startsWith(projectNum)) return true;
          }
          return false;
        });
        if (!isAudValid && config.env === 'production') {
          console.warn(
            `[GoogleAuthDiagnostic] stage=AUDIENCE_VALIDATION status=FAILED errorCategory=AUDIENCE_MISMATCH allowedAudiencesCount=${allowedAudiences.length}`
          );
          throw new AppError('Google token audience does not match configured application clients.', 401, 'SOCIAL_INVALID_CREDENTIAL');
        }
      }

      console.info('[GoogleAuthDiagnostic] stage=ID_TOKEN_VERIFIED status=SUCCESS authType=id_token');
      return this.normalizeProfile(payload);
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      console.error(`[GoogleAuthDiagnostic] stage=UNEXPECTED_ERROR status=FAILED errorType=${error?.name || typeof error}`);
      throw new AppError(
        'تعذر التحقق من مزود الهوية Google، يرجى المحاولة لاحقاً.',
        502,
        'SOCIAL_PROVIDER_ERROR'
      );
    }
  }

  private normalizeProfile(payload: any): VerifiedSocialProfile {
    const providerUserId = String(payload.sub || payload.id);
    const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
    const emailVerified =
      payload.email_verified === true ||
      payload.email_verified === 'true' ||
      payload.verified_email === true;

    const firstName = (payload.given_name || payload.name?.split(' ')[0] || 'مستخدم').trim();
    const lastName = (
      payload.family_name ||
      payload.name?.split(' ').slice(1).join(' ') ||
      'Google'
    ).trim();

    const displayName = (payload.name || `${firstName} ${lastName}`).trim();
    const avatarUrl = payload.picture ? String(payload.picture).trim() : null;

    return {
      provider: SocialProvider.GOOGLE,
      providerUserId,
      email,
      emailVerified,
      firstName,
      lastName,
      displayName,
      avatarUrl,
    };
  }
}
