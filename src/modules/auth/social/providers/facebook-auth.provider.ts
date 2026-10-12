import { ISocialAuthProvider } from './social-provider.interface';
import { VerifiedSocialProfile, SocialProvider } from '../social-auth.types';
import { AppError } from '../../../../middleware/error.middleware';
import { config } from '../../../../config';

export class FacebookAuthenticationProvider implements ISocialAuthProvider {
  async verifyToken(credential: string, platform?: string): Promise<VerifiedSocialProfile> {
    if (!credential || typeof credential !== 'string' || credential.trim().length === 0) {
      throw new AppError('Facebook authentication credential is required.', 400, 'SOCIAL_INVALID_CREDENTIAL');
    }

    const accessToken = credential.trim();

    try {
      // 1. Optional server-to-server debug token validation if App Secret is configured
      if (config.oauth.facebook.appId && config.oauth.facebook.appSecret) {
        const appAccessToken = `${config.oauth.facebook.appId}|${config.oauth.facebook.appSecret}`;
        const debugRes = await fetch(
          `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appAccessToken)}`,
          { headers: { Accept: 'application/json' } }
        );

        if (debugRes.ok) {
          const debugData = (await debugRes.json()) as any;
          const tokenInfo = debugData?.data;

          if (tokenInfo) {
            if (tokenInfo.is_valid === false) {
              throw new AppError('رمز الدخول من Facebook غير صالح أو تم إلغاؤه.', 401, 'SOCIAL_INVALID_CREDENTIAL');
            }

            if (tokenInfo.expires_at && tokenInfo.expires_at > 0) {
              const now = Math.floor(Date.now() / 1000);
              if (tokenInfo.expires_at < now) {
                throw new AppError('انتهت صلاحية رمز دخول Facebook، يرجى إعادة المحاولة.', 401, 'SOCIAL_EXPIRED_CREDENTIAL');
              }
            }

            if (tokenInfo.app_id && tokenInfo.app_id !== config.oauth.facebook.appId) {
              throw new AppError('Facebook token application ID mismatch.', 401, 'SOCIAL_INVALID_CREDENTIAL');
            }
          }
        }
      }

      // 2. Fetch authenticated user profile directly from Facebook Graph API
      const graphRes = await fetch(
        `https://graph.facebook.com/v20.0/me?fields=id,name,first_name,last_name,email,picture.type(large)&access_token=${encodeURIComponent(accessToken)}`,
        { headers: { Accept: 'application/json' } }
      );

      if (!graphRes.ok) {
        const errJson = (await graphRes.json().catch(() => ({}))) as any;
        const errMsg = errJson?.error?.message || 'Facebook token verification failed';
        throw new AppError(`فشل التحقق من هوية Facebook: ${errMsg}`, 401, 'SOCIAL_INVALID_CREDENTIAL');
      }

      const fbData = (await graphRes.json()) as any;

      if (!fbData.id || typeof fbData.id !== 'string') {
        throw new AppError('Facebook profile is missing a valid user identifier.', 401, 'SOCIAL_INVALID_CREDENTIAL');
      }

      return this.normalizeProfile(fbData);
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'تعذر التحقق من مزود الهوية Facebook، يرجى المحاولة لاحقاً.',
        502,
        'SOCIAL_PROVIDER_ERROR'
      );
    }
  }

  private normalizeProfile(fbData: any): VerifiedSocialProfile {
    const providerUserId = String(fbData.id);
    const email = fbData.email ? String(fbData.email).trim().toLowerCase() : null;
    const emailVerified = Boolean(email); // Facebook accounts verify email upon registration

    const firstName = (fbData.first_name || fbData.name?.split(' ')[0] || 'مستخدم').trim();
    const lastName = (
      fbData.last_name ||
      fbData.name?.split(' ').slice(1).join(' ') ||
      'Facebook'
    ).trim();

    const displayName = (fbData.name || `${firstName} ${lastName}`).trim();
    const avatarUrl = fbData.picture?.data?.url ? String(fbData.picture.data.url).trim() : null;

    return {
      provider: SocialProvider.FACEBOOK,
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
