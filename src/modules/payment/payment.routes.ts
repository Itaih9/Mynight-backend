import { Router } from 'express';
import { paymentController } from './payment.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect } from '@/shared/middleware/auth.middleware';
import {
  createPaymentIntentSchema,
  payWithCouponSchema,
  chargeSumitSchema,
} from './payment.validation';

const router = Router();

// Pay with coupon only (100% discount)
router.post(
  '/pay-with-coupon',
  protect,
  validate(payWithCouponSchema),
  paymentController.payWithCoupon
);

// Create payment intent (with optional coupon)
router.post(
  '/create',
  protect,
  validate(createPaymentIntentSchema),
  paymentController.createPayment
);

// Charge with Sumit token (embedded form flow, legacy)
router.post(
  '/charge',
  protect,
  validate(chargeSumitSchema),
  paymentController.chargeSumit
);

// Begin Sumit hosted redirect — returns URL to render in iframe
router.post(
  '/sumit-redirect/begin',
  protect,
  paymentController.beginSumitRedirect
);

// Verify Sumit hosted redirect result — called from /payment-callback
router.post(
  '/sumit-redirect/verify',
  protect,
  paymentController.verifySumitRedirect
);

// Get single payment
router.get('/:paymentId', protect, paymentController.getPayment);

// Get all user payments
router.get('/', protect, paymentController.getUserPayments);

// Get event payment status
router.get('/event/:eventId/status', protect, paymentController.getEventPaymentStatus);

export default router;
