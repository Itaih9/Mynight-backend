import { Router } from 'express';
import { couponController } from './coupon.controller';
import { protect } from '@/shared/middleware/auth.middleware';
import { adminProtect } from '@/modules/admin/admin.middleware';

const router = Router();

router.post('/validate', couponController.validate);
router.get('/active-standard', couponController.getActiveStandard);
router.get('/event/:eventId', couponController.getEventCoupon);

router.get('/mine', protect, couponController.getMyPersonal);

// Admin-only. These were `protect`, which meant any logged-in customer could
// mint themselves a 100% coupon, list every code in the system — including the
// GIFT-* cards guests had paid for — and deactivate anyone else's. The admin
// panel calls the equivalents under /api/admin/coupons; these had no caller.
router.post('/', adminProtect, couponController.create);
router.get('/', adminProtect, couponController.getAll);
router.patch('/:couponId/deactivate', adminProtect, couponController.deactivate);

export default router;
