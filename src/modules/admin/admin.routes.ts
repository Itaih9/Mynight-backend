import { Router } from 'express';
import { adminController } from './admin.controller';
import { adminProtect } from './admin.middleware';
import { loginBruteForceLimiter } from '@/shared/middleware/rateLimit.middleware';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

router.post('/login', loginBruteForceLimiter, adminController.login);
router.post('/verify-otp', loginBruteForceLimiter, adminController.verifyOtp);
router.post('/change-password', adminProtect, adminController.changePassword);

router.get('/admins', adminProtect, adminController.listAdmins);
router.post('/admins', adminProtect, adminController.createAdmin);
router.patch('/admins/:adminId/active', adminProtect, adminController.setAdminActive);
router.delete('/admins/:adminId', adminProtect, adminController.deleteAdmin);

router.get('/dashboard', adminProtect, adminController.getDashboard);
router.get('/pending-counts', adminProtect, adminController.getPendingCounts);
router.get('/users', adminProtect, adminController.getUsers);
router.patch('/users/:userId/reset-password', adminProtect, adminController.resetUserPassword);
router.delete('/users/:userId', adminProtect, adminController.deleteUser);

router.get('/withdrawals', adminProtect, adminController.listWithdrawals);
router.post('/affiliates/:affiliateId/payout', adminProtect, adminController.payoutAffiliate);
router.post('/affiliates/:affiliateId/prepaid/topup', adminProtect, adminController.topUpPrepaid);
router.get('/affiliates/:affiliateId/prepaid', adminProtect, adminController.getPrepaidSummary);
router.patch('/withdrawals/:withdrawalId/paid', adminProtect, adminController.markWithdrawalPaid);
router.patch('/withdrawals/:withdrawalId/reject', adminProtect, adminController.rejectWithdrawal);
router.get('/events', adminProtect, adminController.getEvents);
router.get('/coupons', adminProtect, adminController.getCoupons);
router.post('/coupons', adminProtect, adminController.createCoupon);
router.get('/coupon-defaults', adminProtect, adminController.getCouponDefaults);
router.put('/coupon-defaults', adminProtect, adminController.updateCouponDefaults);
router.post('/coupon-defaults/apply-existing', adminProtect, adminController.applyCouponDefaults);
router.patch('/coupons/:couponId', adminProtect, adminController.updateCoupon);
router.delete('/coupons/:couponId', adminProtect, adminController.deleteCoupon);
router.get('/referrals', adminProtect, adminController.getReferrals);
router.get('/affiliates', adminProtect, adminController.getAffiliates);
router.patch('/affiliates/:affiliateId/status', adminProtect, adminController.updateAffiliateStatus);
router.patch('/events/:eventId/extend', adminProtect, adminController.extendEventUpload);
router.patch('/events/:eventId/slug', adminProtect, adminController.updateEventSlug);
router.delete('/events/:eventId', adminProtect, adminController.deleteEvent);
router.get('/events/:eventId/guest-list-download', adminProtect, adminController.downloadGuestList);
router.get('/events/:eventId/guest-list-data', adminProtect, adminController.getGuestListData);

router.post('/events/:eventId/cover-image', adminProtect, upload.single('coverImage'), adminController.uploadCoverImage);
router.delete('/events/:eventId/cover-image', adminProtect, adminController.deleteCoverImage);

router.post('/events/:eventId/photos', adminProtect, upload.array('photos', 100), adminController.uploadPhotosToEvent);
router.get('/events/:eventId/photos', adminProtect, adminController.getEventPhotos);
router.delete('/events/:eventId/photos/:photoId', adminProtect, adminController.deleteEventPhoto);
router.post('/events/:eventId/photos/bulk-delete', adminProtect, adminController.deleteEventPhotosBulk);

router.post('/events/:eventId/presigned-urls', adminProtect, adminController.getBatchPresignedUrls);
router.post('/events/:eventId/complete-batch', adminProtect, adminController.batchCompleteUpload);

router.post('/events/:eventId/zip-presigned-url', adminProtect, adminController.getZipPresignedUrl);
router.post('/events/:eventId/process-zip', adminProtect, adminController.processZip);
router.get('/events/:eventId/zip-jobs/:jobId', adminProtect, adminController.getZipJobStatus);

router.post('/events/:eventId/zip-multipart/initiate', adminProtect, adminController.initiateZipMultipart);
router.post('/zip-multipart/presign-parts', adminProtect, adminController.getZipPartPresignedUrls);
router.post('/zip-multipart/complete', adminProtect, adminController.completeZipMultipart);
router.post('/zip-multipart/abort', adminProtect, adminController.abortZipMultipart);

export default router;
