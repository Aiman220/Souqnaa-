import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { JwtUtil } from '../../utils/jwt.util';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { UserRoleType, SellerStatus } from '@prisma/client';
import { otpService } from './otp.service';
import { smtpEmailProvider } from '../notifications/providers/email.provider';
import { socialAuthService } from './social/social-auth.service';
import { SocialProvider, SocialAccountType } from './social/social-auth.types';
import { MembershipEligibilityService } from '../membership/membership-eligibility.service';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, firstName, lastName, phone, role, storeName, crNumber } = req.body;

      const cleanPhone = (phone && typeof phone === 'string' && phone.trim().length > 0) ? phone.trim() : null;
      const cleanEmail = email.trim().toLowerCase();

      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { email: cleanEmail },
            ...(cleanPhone ? [{ phone: cleanPhone }] : []),
          ],
        },
      });

      if (existingUser) {
        throw new AppError('يوجد حساب مسجل مسبقاً بهذا البريد الإلكتروني أو رقم الهاتف.', 409);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const rawRole = typeof role === 'string' ? role.toUpperCase() : role;
      const parsedRole: UserRoleType = (rawRole === UserRoleType.SELLER) ? UserRoleType.SELLER : UserRoleType.CUSTOMER;

      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: cleanEmail,
            phone: cleanPhone,
            passwordHash,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            role: parsedRole,
            isVerified: false,
          },
        });

        if (newUser.role === UserRoleType.CUSTOMER) {
          await tx.customer.create({ data: { userId: newUser.id } });
          await tx.cart.create({ data: { userId: newUser.id } });
          await tx.wishlist.create({ data: { userId: newUser.id } });
        } else if (newUser.role === UserRoleType.SELLER) {
          const seller = await tx.seller.create({
            data: {
              userId: newUser.id,
              crNumber: crNumber || null,
              status: SellerStatus.PENDING_VERIFICATION,
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

          if (storeName) {
            const slug = storeName.toLowerCase().replace(/[\s\W-]+/g, '-') + '-' + Math.floor(Math.random() * 1000);
            await tx.store.create({
              data: {
                sellerId: seller.id,
                name: storeName,
                slug,
              },
            });
          }
        }

        return newUser;
      });

      const tokens = JwtUtil.generateTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      // Save refresh token in Redis
      await redis.set(`refresh:${user.id}`, tokens.refreshToken, 7 * 24 * 3600);

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.toLowerCase(),
        isVerified: user.isVerified,
        isActive: user.isActive,
        avatar: user.avatar,
        createdAt: user.createdAt.toISOString(),
      };

      // Centralized Notification Platform: Dispatch Welcome Email
      const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';
      smtpEmailProvider.sendTemplate(user.email, 'WELCOME', locale, {
        name: `${user.firstName} ${user.lastName}`.trim(),
        actionUrl: `${process.env.APP_BASE_URL || 'https://souqnaa.com'}/login`,
      }).catch((err) => console.error('[Auth Register] Welcome email dispatch error:', err));

      if (user.role === UserRoleType.SELLER) {
        smtpEmailProvider.sendTemplate(user.email, 'SELLER_NOTIFICATION', locale, {
          name: `${user.firstName} ${user.lastName}`.trim(),
          sellerTitle: locale === 'en' ? 'Welcome to SOUQNAA Merchant Platform' : 'مرحباً بك في منصة تجار سوقناا',
          sellerMessage: locale === 'en'
            ? 'Your seller registration is received. Submit your commercial documents to start selling.'
            : 'تم استلام تسجيلك كتاجر. يرجى إرفاق السجل التجاري لتفعيل متاجرك ومتابعة المبيعات.',
          actionUrl: `${process.env.APP_BASE_URL || 'https://souqnaa.com'}/seller/dashboard`,
        }).catch((err) => console.error('[Auth Register] Seller onboarding email error:', err));
      }

      ResponseUtil.created(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user: sanitizedUser,
      }, 'Account registered successfully');
    } catch (error) {
      console.error('[Register Error Details]:', error);
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password } = req.body;
      const cleanEmail = String(email || '').trim().toLowerCase();

      // 1. Check Brute-Force Lockout
      const { AdminSessionService } = await import('../admin/admin-session.service');
      const lockout = await AdminSessionService.isAccountLocked(cleanEmail);
      if (lockout.locked) {
        throw new AppError(
          `تم قفل الحساب مؤقتاً لمدة ${Math.ceil(lockout.lockTtlSeconds / 60)} دقيقة بسبب تكرار المحاولات غير الصحيحة.`,
          429,
          'ACCOUNT_LOCKED'
        );
      }

      const user = await prisma.user.findUnique({
        where: { email: cleanEmail },
      });

      // 2. Anti-enumeration: identical error for non-existent account
      if (!user) {
        await AdminSessionService.recordFailedLogin(cleanEmail);
        throw new AppError('بيانات الدخول غير صحيحة.', 401);
      }

      if (!user.isActive) {
        throw new AppError('Your account has been deactivated. Please contact support.', 403);
      }

      // 3. Verify Password
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (!isPasswordValid) {
        const attemptResult = await AdminSessionService.recordFailedLogin(cleanEmail);
        if (user.role === 'ADMIN') {
          await AdminSessionService.logAudit({
            actorId: user.id,
            action: 'ADMIN_LOGIN_FAILED',
            resource: 'auth',
            ipAddress: req.ip || req.socket.remoteAddress,
            userAgent: req.headers['user-agent'],
            details: { email: cleanEmail, remainingAttempts: attemptResult.remainingAttempts },
          });
        }
        if (attemptResult.locked) {
          throw new AppError(
            'تم تجاوز الحد الأقصى للمحاولات الخاطئة وتم قفل الحساب مؤقتاً لمدة 15 دقيقة.',
            429,
            'ACCOUNT_LOCKED'
          );
        }
        throw new AppError('بيانات الدخول غير صحيحة.', 401);
      }

      // 4. Successful Login: Clear Lockout & Failed Counter
      await AdminSessionService.recordSuccessfulLogin(cleanEmail);

      let adminRoles: string[] = [];
      if (user.role === 'ADMIN') {
        const { AdminRbacService } = await import('../admin/admin-rbac.service');
        adminRoles = await AdminRbacService.getUserRoleNames(user.id);

        await AdminSessionService.logAudit({
          actorId: user.id,
          action: 'ADMIN_LOGIN_SUCCESS',
          resource: 'auth',
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          details: { email: cleanEmail, roles: adminRoles },
        });
      }

      const tokens = JwtUtil.generateTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      // Rotate / store refresh token in Redis
      await redis.set(`refresh:${user.id}`, tokens.refreshToken, 7 * 24 * 3600);

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.toLowerCase(),
        adminRoles: adminRoles.length > 0 ? adminRoles : undefined,
        isVerified: user.isVerified,
        isActive: user.isActive,
        avatar: user.avatar,
        createdAt: user.createdAt.toISOString(),
      };

      ResponseUtil.success(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user: sanitizedUser,
      }, 'Logged in successfully');
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;
      const payload = JwtUtil.verifyRefreshToken(refreshToken);

      const cachedToken = await redis.get(`refresh:${payload.userId}`);
      if (!cachedToken || cachedToken !== refreshToken) {
        throw new AppError('Invalid or revoked refresh token.', 401);
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user || !user.isActive) {
        throw new AppError('User session is no longer active.', 401);
      }

      if (user.role === 'ADMIN') {
        const { AdminSessionService } = await import('../admin/admin-session.service');
        const isRevoked = await AdminSessionService.isSessionRevoked(user.id, payload.iat);
        if (isRevoked) {
          await redis.del(`refresh:${user.id}`);
          throw new AppError('الجلسة ملغاة أو منتهية الصلاحية. يرجى تسجيل الدخول مجدداً.', 401, 'SESSION_REVOKED');
        }
      }

      const newTokens = JwtUtil.generateTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      await redis.set(`refresh:${user.id}`, newTokens.refreshToken, 7 * 24 * 3600);

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.toLowerCase(),
        isVerified: user.isVerified,
        isActive: user.isActive,
        avatar: user.avatar,
        createdAt: user.createdAt.toISOString(),
      };

      ResponseUtil.success(res, {
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresIn: newTokens.expiresIn,
        user: sanitizedUser,
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.user) {
        await redis.del(`refresh:${req.user.userId}`);
      }
      ResponseUtil.success(res, null, 'Logged out successfully');
    } catch (error) {
      next(error);
    }
  }

  static async sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { target, type } = req.body;
      const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';
      const result = await otpService.generateAndSendOtp({ target, type, locale });
      ResponseUtil.success(res, result, 'OTP sent successfully');
    } catch (error) {
      next(error);
    }
  }

  static async verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { target, code, type } = req.body;
      await otpService.verifyOtp(target, code, type);
      ResponseUtil.success(res, { verified: true }, 'OTP verified successfully');
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = req.body;
      const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';
      await otpService.sendPasswordResetOtp(email, locale);
      ResponseUtil.success(res, null, 'If this email exists, password reset instructions have been sent.');
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, code, newPassword } = req.body;
      const stored = await redis.get(`pwd_reset:${email.toLowerCase()}`);

      if (!stored || stored !== code) {
        throw new AppError('Invalid or expired reset code.', 400);
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { email: email.toLowerCase() },
        data: { passwordHash },
      });

      await redis.del(`pwd_reset:${email.toLowerCase()}`);
      ResponseUtil.success(res, null, 'Password updated successfully. You can now login.');
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        include: {
          customer: true,
          seller: { include: { stores: true } },
        },
      });

      if (!user) {
        throw new AppError('User not found.', 404);
      }

      let membershipSummary: any = null;
      if (user.role === 'CUSTOMER' || user.role === 'ADMIN') {
        try {
          const summary = await MembershipEligibilityService.getCustomerSummary(user.id);
          membershipSummary = {
            tierCode: summary.tierCode,
            tierName: summary.tierNameEn,
            tierNameAr: summary.tierNameAr,
            tierNameEn: summary.tierNameEn,
            level: summary.level,
            status: summary.status,
            badge: summary.badge,
            progress: summary.progress,
            benefits: summary.benefits,
          };
        } catch (_) {}
      }

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.toLowerCase(),
        isVerified: user.isVerified,
        isActive: user.isActive,
        avatar: user.avatar,
        membership: membershipSummary,
        createdAt: user.createdAt.toISOString(),
      };

      ResponseUtil.success(res, sanitizedUser);
    } catch (error) {
      next(error);
    }
  }

  static async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { firstName, lastName, phone, avatar } = req.body;

      const dataToUpdate: any = {};
      if (firstName !== undefined) dataToUpdate.firstName = firstName.trim();
      if (lastName !== undefined) dataToUpdate.lastName = lastName.trim();
      if (phone !== undefined) {
        dataToUpdate.phone = phone && typeof phone === 'string' && phone.trim() !== '' ? phone.trim() : null;
      }
      if (avatar !== undefined) {
        dataToUpdate.avatar = avatar && typeof avatar === 'string' && avatar.trim() !== '' ? avatar.trim() : null;
      }

      if (dataToUpdate.phone) {
        const existingPhone = await prisma.user.findFirst({
          where: {
            phone: dataToUpdate.phone,
            id: { not: userId },
          },
        });
        if (existingPhone) {
          throw new AppError('رقم الجوال مسجل مسبقاً بحساب آخر', 400);
        }
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
      });

      const sanitizedUser = {
        id: updatedUser.id,
        email: updatedUser.email,
        phone: updatedUser.phone || '',
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        role: updatedUser.role.toLowerCase(),
        isVerified: updatedUser.isVerified,
        isActive: updatedUser.isActive,
        avatar: updatedUser.avatar,
        createdAt: updatedUser.createdAt.toISOString(),
      };

      ResponseUtil.success(res, sanitizedUser, 'تم تحديث الملف الشخصي بنجاح');
    } catch (error) {
      next(error);
    }
  }

  static async googleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      let { email, firstName, lastName, photoUrl, idToken } = req.body;

      // If idToken is provided, verify against Google's tokeninfo endpoint
      if (idToken && typeof idToken === 'string' && idToken.trim().length > 0) {
        try {
          const verifyRes = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken.trim())}`,
            { headers: { Accept: 'application/json' } }
          );
          if (verifyRes.ok) {
            const tokenPayload = (await verifyRes.json()) as any;
            if (tokenPayload.email) {
              email = tokenPayload.email;
              if (tokenPayload.given_name) firstName = tokenPayload.given_name;
              if (tokenPayload.family_name) lastName = tokenPayload.family_name;
              if (tokenPayload.picture) photoUrl = tokenPayload.picture;
            }
          }
        } catch (verifyErr) {
          console.warn('[Google Auth] Token verification warning, continuing with client payload:', verifyErr);
        }
      }

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        throw new AppError('بريد إلكتروني غير صالح من حساب Google', 400);
      }

      const cleanEmail = email.trim().toLowerCase();
      let user = await prisma.user.findUnique({
        where: { email: cleanEmail },
      });

      if (!user) {
        // Create new customer account from Google Sign-In
        const randomPassword = Math.random().toString(36).slice(-10) + 'A1!@' + Date.now().toString(36);
        const passwordHash = await bcrypt.hash(randomPassword, 10);
        const fName = (firstName && typeof firstName === 'string' && firstName.trim()) ? firstName.trim() : 'مستخدم';
        const lName = (lastName && typeof lastName === 'string' && lastName.trim()) ? lastName.trim() : 'Google';

        user = await prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email: cleanEmail,
              passwordHash,
              firstName: fName,
              lastName: lName,
              role: UserRoleType.CUSTOMER,
              isVerified: true,
              avatar: (photoUrl && typeof photoUrl === 'string' && photoUrl.trim()) ? photoUrl.trim() : null,
            },
          });

          await tx.customer.create({ data: { userId: newUser.id } });
          await tx.cart.create({ data: { userId: newUser.id } });
          await tx.wishlist.create({ data: { userId: newUser.id } });

          return newUser;
        });

        // Centralized Notification Platform: Dispatch Welcome Email
        const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';
        smtpEmailProvider.sendTemplate(user.email, 'WELCOME', locale, {
          name: `${user.firstName} ${user.lastName}`.trim(),
          actionUrl: `${process.env.APP_BASE_URL || 'https://souqnaa.com'}/login`,
        }).catch((err) => console.error('[Auth Google] Welcome email dispatch error:', err));
      } else {
        if (!user.isActive) {
          throw new AppError('تم تعطيل هذا الحساب. يرجى التواصل مع الدعم الفني.', 403);
        }

        // Auto-verify if was unverified
        const updateData: any = {};
        if (!user.isVerified) {
          updateData.isVerified = true;
        }
        if (photoUrl && !user.avatar) {
          updateData.avatar = photoUrl.trim();
        }
        if (Object.keys(updateData).length > 0) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });
        }
      }

      const tokens = JwtUtil.generateTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      // Save refresh token in Redis
      await redis.set(`refresh:${user.id}`, tokens.refreshToken, 7 * 24 * 3600);

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.toLowerCase(),
        isVerified: user.isVerified,
        isActive: user.isActive,
        avatar: user.avatar,
        createdAt: user.createdAt.toISOString(),
      };

      ResponseUtil.success(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user: sanitizedUser,
      }, 'تم تسجيل الدخول بحساب Google بنجاح');
    } catch (error) {
      console.error('[Google Auth Error]:', error);
      next(error);
    }
  }

  static async socialLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { provider, credential, applicationType, platform } = req.body;
      const result = await socialAuthService.authenticateSocialLogin({
        provider,
        credential,
        applicationType: applicationType || SocialAccountType.CUSTOMER,
        platform,
      });

      const message = result.isNewAccount
        ? 'تم إنشاء الحساب بنجاح عبر تسجيل الدخول الاجتماعي'
        : 'تم تسجيل الدخول بنجاح';

      ResponseUtil.success(res, result, message);
    } catch (error) {
      next(error);
    }
  }

  static async linkSocialAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { provider, credential, platform } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });

      const applicationType =
        user?.role === UserRoleType.SELLER ? SocialAccountType.SELLER : SocialAccountType.CUSTOMER;

      const result = await socialAuthService.linkSocialAccount(userId, {
        provider,
        credential,
        applicationType,
        platform,
      });

      ResponseUtil.success(res, null, result.message);
    } catch (error) {
      next(error);
    }
  }

  static async unlinkSocialAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { provider } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });

      const applicationType =
        user?.role === UserRoleType.SELLER ? SocialAccountType.SELLER : SocialAccountType.CUSTOMER;

      const result = await socialAuthService.unlinkSocialAccount(
        userId,
        provider as SocialProvider,
        applicationType
      );

      ResponseUtil.success(res, null, result.message);
    } catch (error) {
      next(error);
    }
  }

  static async getLinkedIdentities(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const identities = await socialAuthService.getLinkedIdentities(userId);
      ResponseUtil.success(res, identities);
    } catch (error) {
      next(error);
    }
  }

  static async deleteAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { reason } = req.body || {};

      await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      });

      try {
        await redis.del(`refresh:${userId}`);
      } catch (redisErr) {
        console.warn('[DeleteAccount] Redis delete error:', redisErr);
      }

      await prisma.auditLog.create({
        data: {
          userId,
          action: 'USER_ACCOUNT_DELETED',
          resource: 'users',
          details: JSON.stringify({ reason: reason || 'Customer requested account deletion' }),
        },
      });

      ResponseUtil.success(res, null, 'تم إغلاق وحذف الحساب بنجاح.');
    } catch (error) {
      next(error);
    }
  }

  static async getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const defaultSettings = {
        language: 'ar',
        showFloatingBot: true,
        chatSoundEnabled: true,
        readReceipts: true,
        onlineStatus: true,
        activityStatus: true,
        personalizedAds: true,
        saveSearchHistory: true,
        profileVisibility: true,
        orderAutoConfirm: true,
        orderInvoiceEmail: true,
        orderSmsUpdates: true,
        orderOneClickReorder: true,
        orderDeliveryPreference: 'standard',
        orderArchiveCompleted: false,
      };

      const record = await prisma.systemSetting.findUnique({
        where: { key: `user_settings_${userId}` },
      });

      let userSettings = defaultSettings;
      if (record?.value) {
        try {
          userSettings = { ...defaultSettings, ...JSON.parse(record.value) };
        } catch (_) {}
      }

      ResponseUtil.success(res, userSettings, 'تم استرجاع إعدادات وتفضيلات المستخدم بنجاح');
    } catch (error) {
      next(error);
    }
  }

  static async updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const incoming = req.body || {};

      const existingRecord = await prisma.systemSetting.findUnique({
        where: { key: `user_settings_${userId}` },
      });

      let currentSettings = {
        language: 'ar',
        showFloatingBot: true,
        chatSoundEnabled: true,
        readReceipts: true,
        onlineStatus: true,
        activityStatus: true,
        personalizedAds: true,
        saveSearchHistory: true,
        profileVisibility: true,
        orderAutoConfirm: true,
        orderInvoiceEmail: true,
        orderSmsUpdates: true,
        orderOneClickReorder: true,
        orderDeliveryPreference: 'standard',
        orderArchiveCompleted: false,
      };

      if (existingRecord?.value) {
        try {
          currentSettings = { ...currentSettings, ...JSON.parse(existingRecord.value) };
        } catch (_) {}
      }

      const merged = { ...currentSettings, ...incoming };

      await prisma.systemSetting.upsert({
        where: { key: `user_settings_${userId}` },
        update: { value: JSON.stringify(merged), updatedAt: new Date() },
        create: {
          key: `user_settings_${userId}`,
          value: JSON.stringify(merged),
          type: 'json',
          group: 'customer_settings',
        },
      });

      ResponseUtil.success(res, merged, 'تم حفظ إعدادات وتفضيلات المستخدم بنجاح');
    } catch (error) {
      next(error);
    }
  }
}



