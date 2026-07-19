import { Router } from 'express';
import { giftController } from './gift.controller';

// All public — a gift is bought and redeemed without an account.
const router = Router();

router.post('/create', giftController.create);
router.post('/charge', giftController.charge);
router.post('/begin-redirect', giftController.beginRedirect);
router.post('/verify-redirect', giftController.verifyRedirect);
router.post('/complete-free', giftController.completeFree);
router.get('/:code', giftController.getByCode);

export default router;
