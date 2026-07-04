import { Request, Response, NextFunction } from 'express';
import { facesService } from './faces.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

export class FacesController {
  async getEventFaces(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const faces = await facesService.getEventFaces(req.params.eventId, req.userId!);
      res.json({
        success: true,
        data: faces,
      });
    } catch (error) {
      next(error);
    }
  }

  async getFacePhotos(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId, rekognitionFaceId } = req.params;
      const userId = (req as AuthRequest).userId;

      const photos = await facesService.getFacePhotos(eventId, rekognitionFaceId, userId);
      res.json({
        success: true,
        data: photos,
        total: photos.length,
      });
    } catch (error) {
      next(error);
    }
  }

  async downloadFacePhotosZip(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId, rekognitionFaceId } = req.params;
      await facesService.streamFacePhotosZip(eventId, rekognitionFaceId, res);
    } catch (error) {
      next(error);
    }
  }
}

export const facesController = new FacesController();
