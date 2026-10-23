import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { JwtUtil } from '../../../utils/jwt.util';
import { AppError } from '../../../middleware/error.middleware';
import { UserRoleType, SellerStatus } from '@prisma/client';
import { smtpEmailProvider } from '../../notifications/providers/email.provider';
import {
  SocialProvider,
  SocialAccountType,
  SocialAuthLoginInput,
  SocialAuthLinkInput,
  SocialAuthResponse,
  LinkedSocialIdentityDto,
  VerifiedSocialProfile,
} from './social-auth.types';
import { ISocialAuthProvider } from './providers/social-provider.interface';
import { GoogleAuthenticationProvider } from './providers/google-auth.provider';
import { FacebookAuthenticationProvider } from './providers/facebook-auth.provider';

export class SocialAuthenticationService {
  private googleProvider: ISocialAuthProvider;
  private facebookProvider: ISocialAuthProvider;

  constructor() {
    this.googleProvider = new GoogleAuthenticationProvider();
    this.facebookProvider = new FacebookAuthenticationProvider();
  }

  setProviderAdapter(provider: SocialProvider, adapter: ISocialAuthProvider) {
    if (provider === SocialProvider.GOOGLE) this.googleProvider = adapter;
    if (provider === SocialProvider.FACEBOOK) this.facebookProvider = adapter;
  }

  private getProviderAdapter(provider: SocialProvider): ISocialAuthProvider {
    switch (provider) {
      case SocialProvider.GOOGLE:
        return this.googleProvider;
      case SocialProvider.FACEBOOK:
        return this.facebookProvider;
      default:
        throw new AppError(
          `مزود تسجيل الدخول الاجتماعي غير مدعوم: ${provider}`,
          400,
          'SOCIAL_PROVIDER_NOT_SUPPORTED'
        );
    }
  }

  /**
   * Primary Social Authentication Pipeline:
   * Verify Provider Token -> Resolve Identity -> Resolve Account -> Validate Role -> Create Session
   */
  async authenticateSocialLogin(input: SocialAuthLoginInput): Promise<SocialAuthResponse> {
    // 1. Role / Account Type Security Gate
    // STRICT ADMIN ISOLATION: Social login is strictly forbidden for ADMIN accounts.
    if ((input.applicationType as string) === 'ADMIN' || (input.applicationType as string) === 'admin') {
      throw new AppError(
        'غير مسموح باستخدام تسجيل الدخول الاجتماعي لحسابات الإدارة. يرجى استخدام بوابة الإدارة المخصصة.',
        403,
        'SOCIAL_UNAUTHORIZED_ROLE'
      );
    }

    if (input.applicationType !== SocialAccountType.CUSTOMER && input.applicationType !== SocialAccountType.SELLER) {
      throw new AppError('نوع التطبيق غير صالح.', 400, 'SOCIAL_INVALID_APPLICATION_TYPE');
    }

    // 2. Server-side Provider Credential Verification
    const adapter = this.getProviderAdapter(input.provider);
    const profile = await adapter.verifyToken(input.credential, input.platform);

    // 3. Identity Resolution (Find existing link by provider, providerUserId, and accountType)
    const existingIdentity = await prisma.socialIdentity.findUnique({
      where: {
        provider_providerUserId_accountType: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          accountType: input.applicationType,
        },
      },
      include: {
        user: {
          include: {
            customer: true,
            seller: true,
          },
        },
      },
    });

    if (existingIdentity) {
      const user = existingIdentity.user;

      // Ensure account is not deactivated
      if (!user.isActive) {
        throw new AppError('تم تعطيل هذا الحساب. يرجى التواصل مع الدعم الفني.', 403, 'ACCOUNT_DEACTIVATED');
      }

      // Check seller status if logging into seller domain
      if (input.applicationType === SocialAccountType.SELLER && user.seller) {
        if (user.seller.status === SellerStatus.SUSPENDED) {
          // Keep seller suspended flag known to client
        }
      }

      // Update lastLoginAt and any missing profile data asynchronously
      await prisma.socialIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          lastLoginAt: new Date(),
          providerEmail: profile.email || existingIdentity.providerEmail,
          displayName: profile.displayName || existingIdentity.displayName,
          avatarUrl: profile.avatarUrl || existingIdentity.avatarUrl,
        },
      });

      if (!user.avatar && profile.avatarUrl) {
        await prisma.user.update({
          where: { id: user.id },
          data: { avatar: profile.avatarUrl },
        });
      }

      // SOUQNA Session Generation
      const tokens = JwtUtil.generateTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      await redis.set(`refresh:${user.id}`, tokens.refreshToken, 7 * 24 * 3600);

      const isNewAccount = false;
      const requiresOnboarding =
        user.role === UserRoleType.SELLER && user.seller ? !user.seller.isOnboarded : false;

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user: this.sanitizeUser(user),
        isNewAccount,
        requiresOnboarding,
      };
    }

    // 4. Social Identity NOT found — Account Resolution
    const assignedRole =
      input.applicationType === SocialAccountType.SELLER
        ? UserRoleType.SELLER
        : UserRoleType.CUSTOMER;

    // 4. Account Resolution & Safe Verified Auto-Linking
    let emailToUse =
      profile.email ||
      `${profile.provider.toLowerCase()}_${profile.providerUserId}@social.souqna.ye`;

    if (profile.email) {
      const existingUserByEmail = await prisma.user.findUnique({
        where: { email: profile.email },
        include: {
          seller: true,
          customer: true,
        },
      });

      if (existingUserByEmail) {
        if (existingUserByEmail.role === assignedRole) {
          // If of the same role and email is verified by identity provider (Google/Facebook),
          // auto-link the social identity and authenticate immediately
          if (profile.emailVerified) {
            if (!existingUserByEmail.isActive) {
              throw new AppError('تم تعطيل هذا الحساب. يرجى التواصل مع الدعم الفني.', 403, 'ACCOUNT_DISABLED');
            }

            // Link identity transactionally
            await prisma.$transaction(async (tx) => {
              const existingIdentity = await tx.socialIdentity.findUnique({
                where: {
                  provider_providerUserId_accountType: {
                    provider: profile.provider,
                    providerUserId: profile.providerUserId,
                    accountType: input.applicationType,
                  },
                },
              });

              if (!existingIdentity) {
                await tx.socialIdentity.create({
                  data: {
                    provider: profile.provider,
                    providerUserId: profile.providerUserId,
                    accountType: input.applicationType,
                    userId: existingUserByEmail.id,
                    providerEmail: profile.email,
                    providerEmailVerified: true,
                    displayName: profile.displayName,
                    avatarUrl: profile.avatarUrl,
                  },
                });
              }

              const userUpdates: any = {};
              if (!existingUserByEmail.isVerified) {
                userUpdates.isVerified = true;
              }
              if (!existingUserByEmail.avatar && profile.avatarUrl) {
                userUpdates.avatar = profile.avatarUrl;
              }

              if (Object.keys(userUpdates).length > 0) {
                await tx.user.update({
                  where: { id: existingUserByEmail.id },
                  data: userUpdates,
                });
              }
            });

            // Issue SOUQNA session tokens
            const tokens = JwtUtil.generateTokens({
              userId: existingUserByEmail.id,
              email: existingUserByEmail.email,
              role: existingUserByEmail.role,
            });

            await redis.set(`refresh:${existingUserByEmail.id}`, tokens.refreshToken, 7 * 24 * 3600);

            const requiresOnboarding =
              existingUserByEmail.role === UserRoleType.SELLER && existingUserByEmail.seller
                ? !existingUserByEmail.seller.isOnboarded
                : false;

            return {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresIn: tokens.expiresIn,
              user: this.sanitizeUser(existingUserByEmail),
              isNewAccount: false,
              requiresOnboarding,
            };
          } else {
            // Unverified email from provider cannot auto-merge
            throw new AppError(
              'البريد الإلكتروني غير مؤكد من مزود الخدمة. يرجى تسجيل الدخول أولاً برقم الهاتف أو كلمة المرور.',
              409,
              'SOCIAL_ACCOUNT_LINK_REQUIRED'
            );
          }
        } else {
          // Different domain (e.g. Existing CUSTOMER creates SELLER account or vice-versa)
          // Maintain strict account domain isolation without colliding on User.email @unique
          emailToUse = `${profile.provider.toLowerCase()}_${input.applicationType.toLowerCase()}_${profile.providerUserId}@social.souqna.ye`;
        }
      }
    }

    // 5. Account Creation (Transactional & Idempotent)
    const randomPassword = crypto.randomBytes(32).toString('hex') + 'A1!@';
    const passwordHash = await bcrypt.hash(randomPassword, 10);

    const newUser = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: emailToUse,
          passwordHash,
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatar: profile.avatarUrl,
          role: assignedRole,
          isVerified: profile.emailVerified,
          isActive: true,
        },
      });

      if (assignedRole === UserRoleType.CUSTOMER) {
        await tx.customer.create({ data: { userId: createdUser.id } });
        await tx.cart.create({ data: { userId: createdUser.id } });
        await tx.wishlist.create({ data: { userId: createdUser.id } });
      } else if (assignedRole === UserRoleType.SELLER) {
        const seller = await tx.seller.create({
          data: {
            userId: createdUser.id,
            status: SellerStatus.PENDING_VERIFICATION,
            isOnboarded: false,
          },
        });

        await tx.sellerBalance.create({
          data: {
            sellerId: seller.id,
            availableBalance: 0,
            pendingBalance: 0,
            withdrawnBalance: 0,
          },
        });
      }

      await tx.socialIdentity.create({
        data: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          accountType: input.applicationType,
          userId: createdUser.id,
          providerEmail: profile.email,
          providerEmailVerified: profile.emailVerified,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
        },
      });

      return createdUser;
    });

    // 6. Asynchronous Welcome Notifications
    if (newUser.email && newUser.email.includes('@') && !newUser.email.endsWith('@social.souqna.ye')) {
      smtpEmailProvider
        .sendTemplate(newUser.email, 'WELCOME', 'ar', {
          name: `${newUser.firstName} ${newUser.lastName}`.trim(),
          actionUrl: 'https://souqnaa.com',
        })
        .catch((err) => console.error('[Social Auth] Welcome email error:', err));
    }

    // 7. SOUQNA Session Generation
    const tokens = JwtUtil.generateTokens({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    await redis.set(`refresh:${newUser.id}`, tokens.refreshToken, 7 * 24 * 3600);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: this.sanitizeUser(newUser),
      isNewAccount: true,
      requiresOnboarding: assignedRole === UserRoleType.SELLER,
    };
  }

  /**
   * Account Linking: Connect a social provider to an already authenticated account
   */
  async linkSocialAccount(userId: string, input: SocialAuthLinkInput): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.isActive) {
      throw new AppError('المستخدم غير موجود أو حسابه غير نشط.', 404, 'USER_NOT_FOUND');
    }

    if (user.role === UserRoleType.ADMIN) {
      throw new AppError('لا يمكن ربط حساب اجتماعي بحساب إدارة.', 403, 'SOCIAL_UNAUTHORIZED_ROLE');
    }

    const adapter = this.getProviderAdapter(input.provider);
    const profile = await adapter.verifyToken(input.credential, input.platform);

    // Determine accountType matching user's domain
    const accountType =
      user.role === UserRoleType.SELLER ? SocialAccountType.SELLER : SocialAccountType.CUSTOMER;

    // Check if this provider identity is already linked to ANY account of this type
    const existingIdentity = await prisma.socialIdentity.findUnique({
      where: {
        provider_providerUserId_accountType: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          accountType,
        },
      },
    });

    if (existingIdentity) {
      throw new AppError(
        existingIdentity.userId === userId
          ? 'هذا الحساب الاجتماعي مرتبط بالفعل بحسابك الحالي.'
          : 'هذا الحساب الاجتماعي مرتبط بحساب آخر بالفعل على سوقناا.',
        409,
        'SOCIAL_ACCOUNT_ALREADY_LINKED'
      );
    }

    // Create identity link
    await prisma.socialIdentity.create({
      data: {
        provider: profile.provider,
        providerUserId: profile.providerUserId,
        accountType,
        userId: user.id,
        providerEmail: profile.email,
        providerEmailVerified: profile.emailVerified,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      },
    });

    // Update avatar if missing
    if (!user.avatar && profile.avatarUrl) {
      await prisma.user.update({
        where: { id: user.id },
        data: { avatar: profile.avatarUrl },
      });
    }

    return { message: 'تم ربط الحساب الاجتماعي بنجاح.' };
  }

  /**
   * Account Unlinking: Safely disconnect a social identity
   */
  async unlinkSocialAccount(
    userId: string,
    provider: SocialProvider,
    accountType: SocialAccountType
  ): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        socialIdentities: true,
      },
    });

    if (!user || !user.isActive) {
      throw new AppError('المستخدم غير موجود.', 404, 'USER_NOT_FOUND');
    }

    const identity = user.socialIdentities.find(
      (si) => si.provider === provider && si.accountType === accountType
    );

    if (!identity) {
      throw new AppError('الحساب الاجتماعي المطلوب فك ارتباطه غير موجود.', 404, 'SOCIAL_ACCOUNT_NOT_FOUND');
    }

    // Safety check: Prevent lock-out if user has only this social identity and no phone
    const remainingIdentities = user.socialIdentities.filter((si) => si.id !== identity.id);
    const hasPhone = Boolean(user.phone && user.phone.trim().length > 0);

    if (remainingIdentities.length === 0 && !hasPhone) {
      throw new AppError(
        'لا يمكن إلغاء ربط الحساب الاجتماعي الوحيد دون ربط رقم هاتف أو حساب اجتماعي بديل لتسجيل الدخول.',
        400,
        'CANNOT_UNLINK_SOLE_IDENTITY'
      );
    }

    await prisma.socialIdentity.delete({
      where: { id: identity.id },
    });

    return { message: 'تم إلغاء ربط الحساب الاجتماعي بنجاح.' };
  }

  /**
   * List all linked social identities for an authenticated user
   */
  async getLinkedIdentities(userId: string): Promise<LinkedSocialIdentityDto[]> {
    const identities = await prisma.socialIdentity.findMany({
      where: { userId },
      select: {
        id: true,
        provider: true,
        providerEmail: true,
        providerEmailVerified: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return identities;
  }

  private sanitizeUser(user: any) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone || '',
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role.toLowerCase(),
      isVerified: user.isVerified,
      isActive: user.isActive,
      avatar: user.avatar,
      createdAt: user.createdAt.toISOString ? user.createdAt.toISOString() : String(user.createdAt),
    };
  }
}

export const socialAuthService = new SocialAuthenticationService();
