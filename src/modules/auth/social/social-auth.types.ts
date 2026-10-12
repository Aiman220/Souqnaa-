import { SocialProvider, SocialAccountType, UserRoleType } from '@prisma/client';

export { SocialProvider, SocialAccountType };

export interface VerifiedSocialProfile {
  provider: SocialProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SocialAuthLoginInput {
  provider: SocialProvider;
  credential: string;
  applicationType: SocialAccountType;
  platform?: 'android' | 'ios' | 'web' | 'windows' | string;
}

export interface SocialAuthLinkInput {
  provider: SocialProvider;
  credential: string;
  applicationType: SocialAccountType;
  platform?: string;
}

export interface SocialAuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    phone: string;
    firstName: string;
    lastName: string;
    role: string;
    isVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    createdAt: string;
  };
  isNewAccount: boolean;
  requiresOnboarding?: boolean;
}

export interface LinkedSocialIdentityDto {
  id: string;
  provider: SocialProvider;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date;
}
