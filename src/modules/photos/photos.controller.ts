import { Request, Response, NextFunction } from 'express';
import { photosService } from './photos.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';
import { Photo } from './photos.model';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import { secretMatches } from '@/shared/utils/secrets';
import logger from '@/shared/utils/logger';
import crypto from 'crypto';

/**
 * The value INTERNAL_WEBHOOK_SECRET used to default to. It is published in this
 * repository, so naming it in a log leaks nothing — and "the caller is using
 * the repo default" is the single most useful thing a log can say here.
 */
const PUBLISHED_DEFAULT_SECRET = 'change-me-in-production';

/**
 * Describe a presented secret without writing it down. A length and a short
 * SHA-256 prefix are enough to compare against
 * `printf %s "$SECRET" | sha256sum` on the caller, which is how you find out
 * whether two systems hold the same value without either of them printing it.
 */
const describeSecret = (secret: unknown): string => {
  if (typeof secret !== 'string' || !secret) return 'none presented';
  if (secret === PUBLISHED_DEFAULT_SECRET) return 'the published repo default';
  const fingerprint = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `${secret.length} chars, sha256:${fingerprint}`;
};

/**
 * At most one line per case per window. This endpoint is unauthenticated by
 * definition — it is the thing deciding whether to authenticate — so logging
 * every rejection would hand anyone a way to fill the disk.
 */
const AUTH_LOG_WINDOW_MS = 5 * 60 * 1000;
const lastLoggedAt = new Map<string, number>();
const logThrottled = (key: string, emit: () => void): void => {
  const now = Date.now();
  if (now - (lastLoggedAt.get(key) ?? 0) < AUTH_LOG_WINDOW_MS) return;
  lastLoggedAt.set(key, now);
  emit();
};

/** Bounded, because it is caller-supplied and ends up in a log line. */
const forLog = (value: string): string =>
  value.length > 200 ? `${value.slice(0, 200)}…` : value;

/**
 * A poster is an image derived from one specific video: same key, a suffix, an
 * image extension. Anything else is a caller naming an unrelated object.
 */
export const isPosterKeyFor = (s3Key: string, posterKey: unknown): boolean =>
  // Defensive about the type as well as the value: the handler already rejects
  // a non-string, but a predicate that throws on one is a trap for the next
  // caller — and it made this disagree with the diagnostic script, which is
  // supposed to predict exactly what this returns.
  typeof posterKey === 'string' &&
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
      const presented = req.header('x-internal-secret');
      if (!secretMatches(presented, env.INTERNAL_WEBHOOK_SECRET)) {
        // Loud, because the failure is otherwise invisible: the poster Lambda
        // gets a 401 and nobody sees it, videos keep their black thumbnails,
        // and — since the poster is the only image Rekognition can read from a
        // video — no video enters a face album again.
        if (!env.INTERNAL_WEBHOOK_SECRET) {
          logThrottled('unconfigured', () =>
            logger.error(
              'video-poster refused: INTERNAL_WEBHOOK_SECRET is not set on this server, so the endpoint ' +
                `rejects everything. Caller presented ${describeSecret(presented)}. ` +
                'Video posters are not being recorded, and videos will not reach face albums until it is set.'
            )
          );
        } else {
          logThrottled('mismatch', () =>
            logger.warn(
              `video-poster refused: wrong x-internal-secret. Caller presented ${describeSecret(presented)}; ` +
                'this server expects a different value. Either a prober, or the poster Lambda and the server ' +
                'have drifted apart.'
            )
          );
        }
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
        // Says exactly what was sent, so a caller naming posters by some other
        // convention can be identified from the log rather than guessed at.
        logThrottled('bad-poster-key', () =>
          logger.warn(
            `video-poster refused: posterKey does not belong to s3Key. ` +
              `s3Key=${forLog(s3Key)} posterKey=${forLog(posterKey)}`
          )
        );
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
