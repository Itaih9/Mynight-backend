import { Router } from 'express';
import { eventsController } from './events.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect, requireFullSession } from '@/shared/middleware/auth.middleware';
import { flashSignupLimiter, flashSignupDailyLimiter } from '@/shared/middleware/rateLimit.middleware';
import { createEventSchema, updateSharingPermissionsSchema, updateSlugSchema } from './events.validation';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/pdf',
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, CSV, XLS, and XLSX files are allowed.'));
    }
  },
});

const router = Router();

// Public: free פלאש signup — no auth, no payment (top of the lead funnel).
// Rate-limited because it's unauthenticated and creates records + sends email.
router.post(
  '/flash/register',
  flashSignupDailyLimiter,
  flashSignupLimiter,
  eventsController.registerFreeFlash
);

router.post('/', protect, validate(createEventSchema), eventsController.createEvent);
router.get('/my-events', protect, eventsController.getUserEvents);
router.get('/code/:code', eventsController.getEventByCode);
// Public QR PNG of the guest camera link (?download=1 to force download).
router.get('/code/:code/qr.png', eventsController.getEventQr);
router.get('/slug/:slug', eventsController.getEventBySlug);
router.get('/find/:identifier', eventsController.getEventByCodeOrSlug);
router.get('/:id', protect, eventsController.getEvent);
router.delete('/:id', protect, requireFullSession, eventsController.deleteEvent);
router.patch('/:id/slug', protect, requireFullSession, validate(updateSlugSchema), eventsController.updateSlug);
router.patch('/:id/sharing-permissions', protect, requireFullSession, validate(updateSharingPermissionsSchema), eventsController.updateSharingPermissions);

router.post('/:id/guest-list-file', protect, requireFullSession, upload.single('file'), eventsController.uploadGuestListFile);
router.get('/:id/guest-list-file', protect, requireFullSession, eventsController.getGuestListFile);
router.delete('/:id/guest-list-file', protect, requireFullSession, eventsController.deleteGuestListFile);

export default router;
