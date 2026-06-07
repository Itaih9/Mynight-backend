import { Router } from 'express';
import { facesController } from './faces.controller';
import { protect } from '@/shared/middleware/auth.middleware';

const router = Router();

router.get('/event/:eventId/faces', protect, facesController.getEventFaces);

router.get('/event/:eventId/face/:rekognitionFaceId/photos', facesController.getFacePhotos);

router.get('/event/:eventId/face/:rekognitionFaceId/download', facesController.downloadFacePhotosZip);

export default router;
