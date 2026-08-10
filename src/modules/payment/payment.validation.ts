import { z } from 'zod';

export const createPaymentIntentSchema = z.object({
  eventId: z.string(),
  // Optional: for the Flash Plus (פלאש+) product the server sets the price.
  amount: z.number().positive().optional(),
  couponCode: z.string().optional(),
  product: z.string().optional(),
});

export const payWithCouponSchema = z.object({
  eventId: z.string(),
  couponCode: z.string(),
  // Accepted for backwards compatibility with clients that still send it, but
  // ignored — the server prices the event from its package.
  amount: z.number().positive().optional(),
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
