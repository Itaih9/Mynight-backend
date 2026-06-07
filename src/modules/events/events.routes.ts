import { Router } from 'express';
import { eventsController } from './events.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect } from '@/shared/middleware/auth.middleware';
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

router.post('/', protect, validate(createEventSchema), eventsController.createEvent);
router.get('/my-events', protect, eventsController.getUserEvents);
router.get('/code/:code', eventsController.getEventByCode);
router.get('/slug/:slug', eventsController.getEventBySlug);
router.get('/find/:identifier', eventsController.getEventByCodeOrSlug);
router.get('/:id', protect, eventsController.getEvent);
router.delete('/:id', protect, eventsController.deleteEvent);
router.patch('/:id/slug', protect, validate(updateSlugSchema), eventsController.updateSlug);
router.patch('/:id/sharing-permissions', protect, validate(updateSharingPermissionsSchema), eventsController.updateSharingPermissions);

router.post('/:id/guest-list-file', protect, upload.single('file'), eventsController.uploadGuestListFile);
router.get('/:id/guest-list-file', protect, eventsController.getGuestListFile);
router.delete('/:id/guest-list-file', protect, eventsController.deleteGuestListFile);

export default router;
