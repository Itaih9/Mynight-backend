import { Router } from 'express';
import { couponController } from './coupon.controller';
import { protect } from '@/shared/middleware/auth.middleware';

const router = Router();

router.post('/validate', couponController.validate);
router.get('/active-standard', couponController.getActiveStandard);
router.get('/event/:eventId', couponController.getEventCoupon);

router.get('/mine', protect, couponController.getMyPersonal);
router.post('/', protect, couponController.create);
router.get('/', protect, couponController.getAll);
router.patch('/:couponId/deactivate', protect, couponController.deactivate);

export default router;
