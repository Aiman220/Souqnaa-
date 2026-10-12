import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validate } from '../../middleware/validate.middleware';
import { authenticate } from '../../middleware/auth.middleware';
import { authLimiter } from '../../middleware/rate-limiter.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  sendOtpSchema,
  verifyOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  socialLoginSchema,
  socialLinkSchema,
  socialUnlinkSchema,
} from './auth.schema';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), auditLog('USER_REGISTER', 'users'), AuthController.register);
router.post('/login', authLimiter, validate(loginSchema), auditLog('USER_LOGIN', 'users'), AuthController.login);
router.post('/google', authLimiter, auditLog('USER_GOOGLE_AUTH', 'users'), AuthController.googleAuth);

// Unified Social Authentication & Identity Management
router.post('/social/login', authLimiter, validate(socialLoginSchema), auditLog('USER_SOCIAL_LOGIN', 'users'), AuthController.socialLogin);
router.post('/social/link', authenticate, validate(socialLinkSchema), auditLog('USER_SOCIAL_LINK', 'users'), AuthController.linkSocialAccount);
router.post('/social/unlink', authenticate, validate(socialUnlinkSchema), auditLog('USER_SOCIAL_UNLINK', 'users'), AuthController.unlinkSocialAccount);
router.get('/social/identities', authenticate, AuthController.getLinkedIdentities);

router.post('/refresh', validate(refreshTokenSchema), AuthController.refreshToken);
router.post('/logout', authenticate, AuthController.logout);

router.post('/otp/send', authLimiter, validate(sendOtpSchema), AuthController.sendOtp);
router.post('/otp/verify', authLimiter, validate(verifyOtpSchema), AuthController.verifyOtp);

router.post('/password/forgot', authLimiter, validate(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/password/reset', authLimiter, validate(resetPasswordSchema), auditLog('PASSWORD_RESET', 'users'), AuthController.resetPassword);

router.get('/me', authenticate, AuthController.getMe);
router.put('/me', authenticate, validate(updateProfileSchema), AuthController.updateMe);
router.patch('/me', authenticate, validate(updateProfileSchema), AuthController.updateMe);
router.delete('/me', authenticate, AuthController.deleteAccount);
router.post('/delete-account', authenticate, AuthController.deleteAccount);

// Customer Preferences & Settings
router.get('/settings', authenticate, AuthController.getSettings);
router.put('/settings', authenticate, AuthController.updateSettings);

export const authRoutes = router;

