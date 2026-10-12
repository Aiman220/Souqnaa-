import { VerifiedSocialProfile } from '../social-auth.types';

export interface ISocialAuthProvider {
  verifyToken(credential: string, platform?: string): Promise<VerifiedSocialProfile>;
}
