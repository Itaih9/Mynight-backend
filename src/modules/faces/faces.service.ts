import { Photo } from '../photos/photos.model';
import { displayUrlFor } from '../photos/photos.service';
import { rekognitionService } from '../rekognition/rekognition.service';
import { Event } from '../events/events.model';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import archiver from 'archiver';
import { Response } from 'express';

interface UniqueFace {
  faceId: string;
  rekognitionFaceId: string;
  photoCount: number;
  samplePhotoUrl: string;
  sampleThumbnailUrl: string;
}

class FacesService {
  async getEventFaces(eventId: string, userId: string): Promise<UniqueFace[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to view faces for this event');
    }

    // Get all photos with faces for this event
    const photos = await Photo.find({
      eventId,
      faceId: { $exists: true, $ne: null },
    });

    // Group photos by faceId
    const faceMap = new Map<string, { photoCount: number; samplePhoto: any }>();

    for (const photo of photos) {
      if (photo.faceId) {
        const existing = faceMap.get(photo.faceId);
        if (existing) {
          existing.photoCount++;
        } else {
          faceMap.set(photo.faceId, {
            photoCount: 1,
            samplePhoto: photo,
          });
        }
      }
    }

    // Convert to UniqueFace array
    const faces: UniqueFace[] = [];

    for (const [faceId, data] of faceMap.entries()) {
      faces.push({
        faceId: faceId,
        rekognitionFaceId: faceId,
        photoCount: data.photoCount,
        samplePhotoUrl: `${env.CLOUDFRONT_URL}/${data.samplePhoto.s3Key}`,
        sampleThumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${data.samplePhoto.s3Key}`,
      });
    }

    // Sort by photo count descending
    faces.sort((a, b) => b.photoCount - a.photoCount);

    logger.debug(`Found ${faces.length} unique faces for event ${event.eventCode}`);

    return faces;
  }

  async getFacePhotos(eventId: string, rekognitionFaceId: string, userId?: string): Promise<any[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (userId && event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to view photos for this event');
    }

    // A Rekognition FaceId is unique per detected face, so the tapped face id
    // only ever appears on the single photo it came from. To return ALL photos
    // of that person, search the collection for the same face and collect every
    // matching face id, then fetch each photo that contains any of them.
    const faceIds = new Set<string>([rekognitionFaceId]);
    if (event.collectionId) {
      const matches = await rekognitionService.searchByFaceId({
        collectionId: event.collectionId,
        faceId: rekognitionFaceId,
      });
      for (const m of matches) faceIds.add(m.faceId);
    }
    const ids = Array.from(faceIds);

    const photos = await Photo.find({
      eventId,
      $or: [{ faceId: { $in: ids } }, { 'indexedFaces.faceId': { $in: ids } }],
    }).sort({ createdAt: 1 });

    // Shape each photo like a normal gallery photo (url, thumbnailUrl, displayUrl,
    // category, indexedFaces, metadata) so the frontend face gallery and lightbox
    // can consume them the same way as the main gallery.
    const photosWithUrls = photos.map((photo) => ({
      ...photo.toObject(),
      url: `${env.CLOUDFRONT_URL}/${photo.s3Key}`,
      thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photo.s3Key}`,
      displayUrl: displayUrlFor(photo.s3Key, photo.metadata?.mimeType),
      category: (photo as any).category ?? null,
    }));

    logger.debug(`Found ${photos.length} photos for face ${rekognitionFaceId}`);

    return photosWithUrls;
  }

  async streamFacePhotosZip(eventId: string, rekognitionFaceId: string, res: Response): Promise<void> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const photos = await Photo.find({
      eventId,
      $or: [{ faceId: rekognitionFaceId }, { 'indexedFaces.faceId': rekognitionFaceId }],
    }).sort({ createdAt: -1 });

    if (photos.length === 0) {
      throw new NotFoundError('Photos');
    }

    const zipFilename = `photos-${event.eventCode}-${Date.now()}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });

    archive.on('error', (err) => {
      logger.error(`Archive error: ${err.message}`);
      throw err;
    });

    archive.pipe(res);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const filename = `photo-${i + 1}.jpg`;

      const s3Stream = s3.getObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: photo.s3Key,
      }).createReadStream();

      archive.append(s3Stream, { name: filename });
    }

    await archive.finalize();

    logger.debug(`Streamed zip with ${photos.length} photos for face ${rekognitionFaceId}`);
  }

}

export const facesService = new FacesService();
