import { z } from 'zod';

export const loginSendOTPSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits'),
});

export const loginVerifyOTPSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number is required'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
});

export const loginWithPasswordSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
  email: z.string().email('Invalid email address').optional(),
  password: z.string().min(1, 'Password is required'),
}).refine(data => data.phoneNumber || data.email, { message: 'Phone number or email is required' });

export const registerSendOTPSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits'),
  referralCode: z.string().optional(),
});

export const registerVerifyOTPSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number is required'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
  partnerName1: z.string().min(1, 'Partner name 1 is required'),
  partnerName2: z.string().min(1, 'Partner name 2 is required'),
  weddingDate: z.string().min(1, 'Wedding date is required'),
  packageName: z.string().optional(),
});

export const registerDirectSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
  partnerName1: z.string().min(1, 'Partner name 1 is required'),
  partnerName2: z.string().min(1, 'Partner name 2 is required'),
  weddingDate: z.string().min(1, 'Wedding date is required'),
  referralCode: z.string().optional(),
  packageName: z.string().optional(),
});

export const setPasswordSchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters'),
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
  email: z.string().email('Invalid email address').optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  email: z.string().email('Invalid email address').optional(),
  partnerName1: z.string().min(1, 'Partner name 1 is required').optional(),
  partnerName2: z.string().min(1, 'Partner name 2 is required').optional(),
  weddingDate: z.string().optional(),
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
});
