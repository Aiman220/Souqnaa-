import { z } from 'zod';
import { UserRoleType } from '@prisma/client';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email('البريد الإلكتروني غير صالح'),
    password: z.string().min(6, 'كلمة المرور يجب ألا تقل عن 6 أحرف'),
    firstName: z.string().min(1, 'الاسم الأول مطلوب'),
    lastName: z.string().min(1, 'اسم العائلة مطلوب'),
    phone: z.string().optional().nullable(),
    role: z
      .preprocess(
        (val) => (typeof val === 'string' ? val.toUpperCase() : val),
        z.enum([UserRoleType.CUSTOMER, UserRoleType.SELLER])
      )
      .optional()
      .default(UserRoleType.CUSTOMER),
    storeName: z.string().optional().nullable(),
    crNumber: z.string().optional().nullable(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('البريد الإلكتروني غير صالح'),
    password: z.string().min(1, 'كلمة المرور مطلوبة'),
  }),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'رمز التحديث مطلوب'),
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    target: z.string().min(3, 'الوجهة مطلوبة'),
    type: z.string().default('verification'),
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    target: z.string().min(3, 'الوجهة مطلوبة'),
    code: z.string().min(4, 'رمز التحقق مطلوب'),
    type: z.string().default('verification'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('البريد الإلكتروني غير صالح'),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('البريد الإلكتروني غير صالح'),
    code: z.string().min(4, 'رمز التحقق مطلوب'),
    newPassword: z.string().min(6, 'كلمة المرور يجب ألا تقل عن 6 أحرف'),
  }),
});

export const updateProfileSchema = z.object({
  body: z.object({
    firstName: z.string().min(1, 'الاسم الأول مطلوب').optional(),
    lastName: z.string().min(1, 'اسم العائلة مطلوب').optional(),
    email: z.string().email('البريد الإلكتروني غير صالح').optional(),
    phone: z.string().optional().nullable(),
    avatar: z.string().optional().nullable(),
  }),
});

export const socialLoginSchema = z.object({
  body: z.object({
    provider: z.preprocess(
      (val) => (typeof val === 'string' ? val.toUpperCase() : val),
      z.enum(['GOOGLE', 'FACEBOOK', 'APPLE'])
    ),
    credential: z.string().min(1, 'رمز الدخول أو تفويض المزود مطلوب'),
    applicationType: z.preprocess(
      (val) => (typeof val === 'string' ? val.toUpperCase() : val),
      z.enum(['CUSTOMER', 'SELLER'])
    ).optional().default('CUSTOMER'),
    platform: z.string().optional(),
  }),
});

export const socialLinkSchema = z.object({
  body: z.object({
    provider: z.preprocess(
      (val) => (typeof val === 'string' ? val.toUpperCase() : val),
      z.enum(['GOOGLE', 'FACEBOOK', 'APPLE'])
    ),
    credential: z.string().min(1, 'رمز الدخول أو تفويض المزود مطلوب'),
    platform: z.string().optional(),
  }),
});

export const socialUnlinkSchema = z.object({
  body: z.object({
    provider: z.preprocess(
      (val) => (typeof val === 'string' ? val.toUpperCase() : val),
      z.enum(['GOOGLE', 'FACEBOOK', 'APPLE'])
    ),
  }),
});

