import { Router } from 'express';
import { reviewController } from './review.controller';
import { protect } from '@/shared/middleware/auth.middleware';
import { adminProtect } from '../admin/admin.middleware';

const router = Router();

// Public — approved reviews for landing page
router.get('/approved', reviewController.getApproved);

// Logged-in user submits a review
router.post('/submit', protect, reviewController.submit);

// Admin endpoints
router.get('/', adminProtect, reviewController.getAll);
router.patch('/:reviewId/status', adminProtect, reviewController.updateStatus);

export default router;
