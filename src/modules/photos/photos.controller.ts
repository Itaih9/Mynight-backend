import { Request, Response, NextFunction } from 'express';
import { photosService } from './photos.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';
import { Photo } from './photos.model';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import { secretMatches } from '@/shared/utils/secrets';

/**
 * A poster is an image derived from one specific video: same key, a suffix, an
 * image extension. Anything else is a caller naming an unrelated object.
 */
const isPosterKeyFor = (s3Key: string, posterKey: string): boolean =>
  posterKey.startsWith(`${s3Key}-`) &&
  !posterKey.includes('..') &&
  /\.(jpe?g|png)$/i.test(posterKey);

/**
 * A ceiling on abuse, not on customers. "Download all" in the guest gallery
 * sends every photo in that guest's album, and the largest live event holds
 * 3,542 — a 200 cap would have broken the feature for exactly the weddings that
 * paid the most. What this stops is the 10MB JSON body of ~380,000 ids that the
 * endpoint accepted before.
 */
const MAX_ZIP_PHOTOS = 5000;

export class PhotosController {
  async getPresignedUrl(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { eventId, fileName, fileType } = req.body;
      const result = await photosService.getPresignedUrl(eventId, fileName, fileType, req.userId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async completeUpload(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { eventId, s3Key, metadata, path } = req.body;
      const photo = await photosService.completeUpload(eventId, s3Key, metadata, path, req.userId);
      res.status(201).json({
        success: true,
        data: photo,
        message: 'Photo uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async matchPhotos(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No selfie uploaded',
        });
        return;
      }

      const { eventId } = req.body;
      const photos = await photosService.matchPhotosWithFile(eventId, req.file);
      res.json({
        success: true,
        data: {
          matchedPhotos: photos,
          totalMatches: photos.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventStoryGroups(req: Request, res: Response, next: NextFunction) {
    try {
      const groups = await photosService.getEventStoryGroups(req.params.eventId);
      res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
      res.json({ success: true, data: groups });
    } catch (error) {
      next(error);
    }
  }

  async getEventPhotos(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit as string) || 20));
      const seed = typeof req.query.seed === 'string' && req.query.seed.length > 0 ? req.query.seed : undefined;
      const category = typeof req.query.category === 'string' && req.query.category.length > 0 ? req.query.category : undefined;
      const result = await photosService.getEventPhotos(req.params.eventId, page, limit, seed, category);
      res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
      res.json({
        success: true,
        data: result.photos,
        pagination: {
          page,
          limit,
          total: result.total,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async guestUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No photo uploaded',
        });
        return;
      }

      const { eventCode, guestName } = req.body;
      const photo = await photosService.guestUpload(eventCode, req.file, guestName);
      res.status(201).json({
        success: true,
        data: photo,
        message: 'Photo uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async guestPresignedUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventCode, fileName, fileType } = req.body;
      const result = await photosService.guestPresignedUrl(eventCode, fileName, fileType);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async guestCompleteUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventCode, s3Key, guestName, metadata } = req.body;
      const photo = await photosService.guestCompleteUpload(eventCode, s3Key, guestName, metadata);
      res.status(201).json({
        success: true,
        data: photo,
      });
    } catch (error) {
      next(error);
    }
  }

  async setVideoPoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Unset INTERNAL_WEBHOOK_SECRET refuses everything: secretMatches returns
      // false with nothing configured. Previously the secret defaulted to a
      // string published in this repository, so any deployment that had not set
      // it accepted this call from anyone.
      if (!secretMatches(req.header('x-internal-secret'), env.INTERNAL_WEBHOOK_SECRET)) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const { s3Key, posterKey } = req.body || {};
      if (typeof s3Key !== 'string' || typeof posterKey !== 'string' || !s3Key || !posterKey) {
        res.status(400).json({ success: false, error: 's3Key and posterKey required' });
        return;
      }
      // The poster must be derived from THIS video. setVideoPoster feeds
      // posterKey to Rekognition as the image to index into the event's face
      // collection, so an unconstrained key let a caller index any object in
      // the bucket into any wedding's collection — putting a face of their
      // choosing among a couple's photos.
      if (!isPosterKeyFor(s3Key, posterKey)) {
        res.status(400).json({
          success: false,
          error: 'posterKey must be derived from s3Key, e.g. `${s3Key}-poster.jpg`',
        });
        return;
      }
      const photo = await photosService.setVideoPoster(s3Key, posterKey);
      if (!photo) {
        res.status(404).json({ success: false, error: 'Photo not found' });
        return;
      }
      res.json({ success: true, data: { posterUrl: photo.posterUrl } });
    } catch (error) {
      next(error);
    }
  }

  async deletePhoto(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await photosService.deletePhoto(req.params.id, req.userId!);
      res.json({
        success: true,
        message: 'Photo deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async downloadPhoto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const photo = await Photo.findById(req.params.id);
      if (!photo) {
        res.status(404).json({ success: false, error: 'Photo not found' });
        return;
      }

      const s3Object = await s3.getObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: photo.s3Key,
      }).promise();

      const fileName = photo.s3Key.split('/').pop() || `photo-${photo._id}.jpg`;
      res.setHeader('Content-Type', photo.metadata.mimeType || 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(s3Object.Body);
    } catch (error) {
      next(error);
    }
  }

  async downloadPhotosZip(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { photoIds } = req.body;
      if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        res.status(400).json({ success: false, error: 'Photo IDs are required' });
        return;
      }
      // Uncapped, this took whatever fitted in a 10MB JSON body — roughly 380k
      // ids — and streamed every matching object through this one process.
      if (photoIds.length > MAX_ZIP_PHOTOS) {
        res.status(400).json({
          success: false,
          error: `אפשר להוריד עד ${MAX_ZIP_PHOTOS} תמונות בבת אחת`,
        });
        return;
      }
      await photosService.streamPhotosZip(photoIds, res);
    } catch (error) {
      next(error);
    }
  }

  async getDownloadUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const url = await photosService.getDownloadUrl(req.params.id);
      res.json({
        success: true,
        data: { url },
      });
    } catch (error) {
      next(error);
    }
  }

  async disposableStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, deviceId } = req.query as { code: string; deviceId?: string };
      const result = await photosService.getDisposableStatus(code, deviceId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async disposablePresignedUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventCode, deviceId, fileName, fileType } = req.body;
      const result = await photosService.disposablePresignedUrl(eventCode, deviceId, fileName, fileType);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async disposableComplete(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventCode, deviceId, s3Key, guestName, metadata } = req.body;
      const result = await photosService.disposableComplete(eventCode, deviceId, s3Key, guestName, metadata);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async disposableShots(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, deviceId } = req.query as { code: string; deviceId: string };
      const shots = await photosService.getDisposableShots(code, deviceId);
      res.json({ success: true, data: shots });
    } catch (error) {
      next(error);
    }
  }

  async disposableDelete(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventCode, deviceId, photoId } = req.body;
      const result = await photosService.deleteDisposablePhoto(eventCode, deviceId, photoId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getShowcaseImages(_req: Request, res: Response, next: NextFunction) {
    try {
      const images = await photosService.getShowcaseImages();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        success: true,
        data: images,
      });
    } catch (error) {
      next(error);
    }
  }

  async getShowcaseFacePhotos(req: Request, res: Response, next: NextFunction) {
    try {
      const { faceId } = req.params;
      const photos = await photosService.getShowcaseFacePhotos(faceId);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ success: true, data: photos });
    } catch (error) {
      next(error);
    }
  }
}

export const photosController = new PhotosController();
