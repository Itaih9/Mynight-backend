import { z } from 'zod';

export const createPaymentIntentSchema = z.object({
  eventId: z.string(),
  amount: z.number().positive(),
  couponCode: z.string().optional(),
});

export const payWithCouponSchema = z.object({
  eventId: z.string(),
  couponCode: z.string(),
  amount: z.number().positive(),
});

export const chargeSumitSchema = z.object({
  paymentId: z.string(),
  token: z.string(),
});

export const confirmPaymentSchema = z.object({
  paymentIntentId: z.string(),
  eventId: z.string(),
});

export const getPaymentSchema = z.object({
  paymentId: z.string(),
});
