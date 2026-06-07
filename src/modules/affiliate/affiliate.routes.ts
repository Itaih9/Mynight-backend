import { Router } from 'express';
import { affiliateController } from './affiliate.controller';
import { protectAffiliate } from './affiliate.middleware';
import { loginBruteForceLimiter } from '@/shared/middleware/rateLimit.middleware';

const router = Router();

router.post('/register', affiliateController.register);

router.post('/login', loginBruteForceLimiter, affiliateController.login);

router.get('/me', protectAffiliate, affiliateController.getMe);
router.patch('/me', protectAffiliate, affiliateController.updateProfile);

router.post('/me/withdrawals', protectAffiliate, affiliateController.requestWithdrawal);
router.get('/me/withdrawals', protectAffiliate, affiliateController.getWithdrawals);

router.get('/me/prepaid', protectAffiliate, affiliateController.getMyPrepaid);

router.get('/:affiliateId/stats', protectAffiliate, affiliateController.getStats);

router.get('/:affiliateId/referrals', protectAffiliate, affiliateController.getReferrals);

export default router;
