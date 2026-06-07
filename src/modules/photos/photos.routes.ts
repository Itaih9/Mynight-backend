import { Router } from 'express';
import { photosController } from './photos.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect } from '@/shared/middleware/auth.middleware';
import {
  getPresignedUrlSchema,
  completeUploadSchema,
  guestPresignedUrlSchema,
  guestCompleteUploadSchema,
} from './photos.validation';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const router = Router();

router.post(
  '/presigned-url',
  protect,
  validate(getPresignedUrlSchema),
  photosController.getPresignedUrl
);

router.post(
  '/complete',
  protect,
  validate(completeUploadSchema),
  photosController.completeUpload
);

router.post('/match', upload.single('selfie'), photosController.matchPhotos);

router.post('/guest-upload', upload.single('photo'), photosController.guestUpload);
router.post('/guest-presigned-url', validate(guestPresignedUrlSchema), photosController.guestPresignedUrl);
router.post('/guest-complete', validate(guestCompleteUploadSchema), photosController.guestCompleteUpload);

router.get('/event/:eventId', photosController.getEventPhotos);
router.get('/event/:eventId/story-groups', photosController.getEventStoryGroups);

router.post('/internal/video-poster', photosController.setVideoPoster);

router.get('/download/:id', photosController.downloadPhoto);

router.get('/download-url/:id', photosController.getDownloadUrl);

router.post('/download-zip', photosController.downloadPhotosZip);

router.get('/showcase/images', photosController.getShowcaseImages);

router.delete('/:id', protect, photosController.deletePhoto);

export default router;
