import { Router } from 'express';
import { facesController } from './faces.controller';
import { protect } from '@/shared/middleware/auth.middleware';
import { facesLimiter } from '@/shared/middleware/rateLimit.middleware';

const router = Router();

router.get('/event/:eventId/faces', protect, facesController.getEventFaces);

router.get('/event/:eventId/face/:rekognitionFaceId/photos', facesLimiter, facesController.getFacePhotos);

router.get('/event/:eventId/face/:rekognitionFaceId/download', facesLimiter, facesController.downloadFacePhotosZip);

export default router;
