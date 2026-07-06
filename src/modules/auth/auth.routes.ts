import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect } from '@/shared/middleware/auth.middleware';
import { authLimiter, otpRateLimiter, loginBruteForceLimiter } from '@/shared/middleware/rateLimit.middleware';
import {
  loginSendOTPSchema,
  loginVerifyOTPSchema,
  loginWithPasswordSchema,
  registerSendOTPSchema,
  registerVerifyOTPSchema,
  registerDirectSchema,
  setPasswordSchema,
  updateProfileSchema
} from './auth.validation';

const router = Router();

router.post('/login/send-otp', authLimiter, otpRateLimiter, validate(loginSendOTPSchema), authController.loginSendOTP);
router.post('/login/verify-otp', loginBruteForceLimiter, authLimiter, validate(loginVerifyOTPSchema), authController.loginVerifyOTP);
router.post('/login/password', loginBruteForceLimiter, authLimiter, validate(loginWithPasswordSchema), authController.loginWithPassword);

router.post('/register/send-otp', authLimiter, otpRateLimiter, validate(registerSendOTPSchema), authController.registerSendOTP);
router.post('/register/verify-otp', authLimiter, validate(registerVerifyOTPSchema), authController.registerVerifyOTP);
router.post('/register/direct', authLimiter, validate(registerDirectSchema), authController.registerDirect);

// Couple gallery login — the login screen posts a phone or email and gets a
// gallery-scoped session. This is the only entry point (no direct link).
router.post('/gallery-login', loginBruteForceLimiter, authLimiter, authController.galleryLogin);

router.get('/profile', protect, authController.getProfile);
router.put('/profile', protect, validate(updateProfileSchema), authController.updateProfile);
router.put('/set-password', protect, validate(setPasswordSchema), authController.setPassword);

export default router;
