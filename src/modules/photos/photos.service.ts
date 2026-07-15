import { Photo, IPhoto } from './photos.model';
import { Event, IEvent } from '../events/events.model';
import { rekognitionService } from '../rekognition/rekognition.service';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { nanoid } from 'nanoid';
import archiver from 'archiver';
import { Response } from 'express';

const UPLOAD_WINDOW_DAYS = 180;
const SHOWCASE_CACHE_TTL = 300000; // 5 min — so S3 showcase edits show up quickly
const SHUFFLE_CACHE_TTL = 300000;
const PHOTO_GALLERY_FIELDS = '_id s3Key posterUrl category indexedFaces uploaderName uploadedBy createdAt metadata.mimeType metadata.width metadata.height';

function hashStringToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function collectPhotoFaceIds(photo: Pick<IPhoto, 'faceId' | 'indexedFaces'>): string[] {
  const ids = [
    photo.faceId,
    ...(photo.indexedFaces || []).map((f) => f.faceId),
  ].filter(Boolean) as string[];
  return [...new Set(ids)];
}

/**
 * URL of the web-optimized "display" rendition, generated alongside thumbnails:
 *  - images: resized (max 2048px long edge) at display/{s3Key}
 *  - videos: transcoded H.264 + faststart MP4 at display/{s3Key}.mp4
 * Frontends should fall back to the original `url` if this 404s (media uploaded
 * before the display pipeline existed and not yet backfilled, or a rendition
 * still being transcoded).
 */
export function displayUrlFor(s3Key: string, mimeType?: string): string | undefined {
  if (mimeType && mimeType.startsWith('video/')) {
    return env.VIDEO_RENDITIONS_ENABLED ? `${env.CLOUDFRONT_URL}/display/${s3Key}.mp4` : undefined;
  }
  return `${env.CLOUDFRONT_URL}/display/${s3Key}`;
}

/**
 * Normalize a raw moment/subfolder name into a category — keep only the words.
 * Folder names carry ordering noise like "01-חופה", "חופה-2", or "03_כיסא כלה";
 * we strip leading/trailing digits/dashes/underscores/whitespace and collapse
 * any remaining separators to single spaces, leaving just the Hebrew words
 * ("01-חופה" -> "חופה", "03_כיסא כלה" -> "כיסא כלה"). Returns null for
 * empty/absent input so photos without a moment stay null. This MUST stay in
 * sync with the frontend's formatCategoryLabel so stored and displayed values
 * match.
 */
export function normalizeCategory(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^[\d._\-\s]+/, '')
    .replace(/[\d._\-\s]+$/, '')
    .replace(/[._\-\s]+/g, ' ')
    .trim();
  return cleaned || null;
}

/**
 * Derive a category from a file's (relative) path by taking the top-level
 * subfolder — e.g. "01_huppah/img_001.jpg" -> "huppah". Files with no subfolder
 * (e.g. "img_001.jpg") return null. Handles both "/" and "\" separators.
 */
export function categoryFromPath(path?: string | null): string | null {
  if (!path) return null;
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return normalizeCategory(segments[0]);
}

export interface ShowcaseMedia {
  url: string;
  /** Small rendition, when one exists at thumbnails/{key} (else undefined). */
  thumbnailUrl?: string;
  /** Capped rendition, when one exists at display/{key} (else undefined). */
  displayUrl?: string;
  type: 'photo' | 'video';
  /** Subfolder under gallery_showcase/ (= story name), or null for grid-only. */
  story: string | null;
}

class PhotosService {
  private showcaseImageCache: ShowcaseMedia[] | null = null;
  private cacheExpiry: number = 0;
  private shuffledIdCache = new Map<string, { ids: string[]; total: number; expiresAt: number }>();
  private pendingVideoPosters = new Map<string, { posterUrl: string; expiresAt: number }>();

  private rememberPendingVideoPoster(s3Key: string, posterKey: string): void {
    this.pendingVideoPosters.set(s3Key, {
      posterUrl: `${env.CLOUDFRONT_URL}/${posterKey}`,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  private takePendingVideoPoster(s3Key: string): string | undefined {
    const pending = this.pendingVideoPosters.get(s3Key);
    if (!pending) return undefined;
    this.pendingVideoPosters.delete(s3Key);
    if (pending.expiresAt < Date.now()) return undefined;
    return pending.posterUrl;
  }

  private async getExistingVideoPosterUrl(s3Key: string): Promise<string | undefined> {
    const posterKey = `${s3Key}-poster.jpg`;
    try {
      await s3.headObject({ Bucket: env.S3_BUCKET_NAME, Key: posterKey }).promise();
      return `${env.CLOUDFRONT_URL}/${posterKey}`;
    } catch {
      return undefined;
    }
  }

  private async resolveVideoPosterUrl(s3Key: string, mimeType?: string): Promise<string | undefined> {
    if (!mimeType?.startsWith('video/')) return undefined;
    return this.takePendingVideoPoster(s3Key) || await this.getExistingVideoPosterUrl(s3Key);
  }

  private clearShuffleCacheForEvent(eventId: string): void {
    for (const key of this.shuffledIdCache.keys()) {
      if (key.startsWith(`${eventId}:`)) {
        this.shuffledIdCache.delete(key);
      }
    }
  }

  private isUploadExpired(event: IEvent): boolean {
    if (!event.uploadExpiresAt) {
      return false;
    }
    return new Date() > new Date(event.uploadExpiresAt);
  }

  private async setUploadStartedIfFirst(event: IEvent): Promise<void> {
    if (!event.uploadStartedAt) {
      const uploadStartedAt = new Date();
      const uploadExpiresAt = new Date(uploadStartedAt);
      uploadExpiresAt.setDate(uploadExpiresAt.getDate() + UPLOAD_WINDOW_DAYS);

      await Event.findByIdAndUpdate(event._id, {
        uploadStartedAt,
        uploadExpiresAt,
      });

      logger.debug(`Upload window started for event ${event.eventCode}`);
    }
  }

  async getPresignedUrl(eventId: string, fileName: string, fileType: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (!event.isPaid) {
      throw new ValidationError('Event must be activated before uploading photos. Please complete payment first.');
    }

    if (this.isUploadExpired(event)) {
      throw new ValidationError('Upload window has expired. Contact us to extend your event.');
    }

    const key = `events/${event.eventCode}/${nanoid()}-${fileName}`;
    const url = await s3.getSignedUrlPromise('putObject', {
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
      Expires: 300,
      ContentType: fileType,
    });

    return { uploadUrl: url, key };
  }

  async completeUpload(
    eventId: string,
    s3Key: string,
    metadata: { size: number; mimeType: string; width?: number; height?: number },
    path?: string
  ): Promise<IPhoto> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (this.isUploadExpired(event)) {
      throw new ValidationError('Upload window has expired. Contact us to extend your event.');
    }

    await this.setUploadStartedIfFirst(event);

    const url = `${env.CLOUDFRONT_URL}/${s3Key}`;
    const thumbnailUrl = `${env.CLOUDFRONT_URL}/thumbnails/${s3Key}`;
    const posterUrl = await this.resolveVideoPosterUrl(s3Key, metadata?.mimeType);

    const photo = await Photo.create({
      eventId,
      s3Key,
      url,
      thumbnailUrl,
      ...(posterUrl ? { posterUrl } : {}),
      category: categoryFromPath(path),
      uploadedBy: 'owner',
      uploaderName: 'צלם האירוע',
      metadata,
    });

    const indexedFaces = await rekognitionService.indexEventPhoto({
      collectionId: event.collectionId,
      s3Key,
      eventId: String(eventId),
      photoId: String(photo._id),
    });
    if (indexedFaces.length > 0) {
      photo.indexedFaces = indexedFaces;
      photo.faceId = indexedFaces[0].faceId;
      await photo.save();
    }

    await Event.findByIdAndUpdate(eventId, {
      $inc: { photoCount: 1 },
      lastPhotoUploadedAt: new Date(),
    });

    this.clearShuffleCacheForEvent(String(eventId));

    logger.debug(`Upload complete: ${s3Key.split('/').pop()}`);

    return photo;
  }

  async matchPhotosWithFile(eventId: string, file: Express.Multer.File): Promise<IPhoto[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.packageName === 'האוספת') {
      throw new ValidationError('Face matching is not available for this package');
    }

    // Upload selfie to S3 temporarily
    const selfieKey = `events/${event.eventCode}/selfies/${Date.now()}-${file.originalname}`;

    await s3
      .putObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: selfieKey,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    logger.debug(`Selfie uploaded to S3: ${selfieKey}`);

    const matches = await rekognitionService.searchBySingleSelfie({
      collectionId: event.collectionId,
      s3Key: selfieKey,
    });

    const photos = await this.mapMatchesToPhotos(String(eventId), matches);

    logger.debug(`Selfie search returned ${photos.length} unique photo(s)`);

    return photos as any;
  }

  private async mapMatchesToPhotos(
    eventId: string,
    matches: { faceId: string; similarity: number }[]
  ): Promise<any[]> {
    if (matches.length === 0) {
      return [];
    }

    const similarityByFaceId = new Map<string, number>();
    for (const m of matches) {
      const prev = similarityByFaceId.get(m.faceId) ?? 0;
      if (m.similarity > prev) similarityByFaceId.set(m.faceId, m.similarity);
    }

    const faceIds = Array.from(similarityByFaceId.keys());

    const photos = await Photo.find({
      eventId,
      $or: [{ faceId: { $in: faceIds } }, { 'indexedFaces.faceId': { $in: faceIds } }],
    }).sort({ createdAt: 1 });

    return photos.map((photo) => {
      const photoFaceIds = [
        photo.faceId,
        ...(photo.indexedFaces || []).map((f) => f.faceId),
      ].filter(Boolean) as string[];
      const similarity = Math.max(
        0,
        ...photoFaceIds.map((fid) => similarityByFaceId.get(fid) ?? 0)
      );

      return {
        ...photo.toObject(),
        url: `${env.CLOUDFRONT_URL}/${photo.s3Key}`,
        thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photo.s3Key}`,
        displayUrl: displayUrlFor(photo.s3Key, photo.metadata?.mimeType),
        similarity,
      };
    });
  }

  async matchPhotos(eventId: string, selfieKey: string): Promise<IPhoto[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const matches = await rekognitionService.searchBySingleSelfie({
      collectionId: event.collectionId,
      s3Key: selfieKey,
    });

    const photos = await this.mapMatchesToPhotos(String(eventId), matches);

    return photos as any;
  }


  async getEventStoryGroups(eventId: string): Promise<{ uploaderName: string; items: any[] }[]> {
    const photos = await Photo.find({ eventId })
      .select('_id s3Key thumbnailUrl posterUrl category indexedFaces uploaderName uploadedBy createdAt metadata.mimeType metadata.width metadata.height')
      .sort({ createdAt: 1 })
      .lean();

    const groups = new Map<string, any[]>();
    for (const p of photos) {
      const name = p.uploaderName || (p.uploadedBy === 'guest' ? 'אורח' : 'צלם האירוע');
      const item = {
        _id: p._id,
        s3Key: p.s3Key,
        url: `${env.CLOUDFRONT_URL}/${p.s3Key}`,
        thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${p.s3Key}`,
        displayUrl: displayUrlFor(p.s3Key, p.metadata?.mimeType),
        posterUrl: p.posterUrl,
        category: p.category ?? null,
        indexedFaces: (p as any).indexedFaces ?? [],
        uploaderName: name,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        metadata: p.metadata,
      };
      const arr = groups.get(name);
      if (arr) arr.push(item);
      else groups.set(name, [item]);
    }

    return Array.from(groups.entries()).map(([uploaderName, items]) => ({ uploaderName, items }));
  }

  async getEventPhotos(eventId: string, page: number = 1, limit: number = 20, seed?: string, category?: string): Promise<{ photos: IPhoto[]; total: number; hasMore: boolean }> {
    const skip = (page - 1) * limit;

    const normalizedCategory = normalizeCategory(category);
    const query: Record<string, any> = { eventId };
    if (normalizedCategory) {
      query.category = normalizedCategory;
    }

    if (!seed) {
      logger.debug(`Fetching photos from DB for event ${eventId} (page ${page}, limit ${limit})`);
      const [photos, total] = await Promise.all([
        Photo.find(query)
          .select(PHOTO_GALLERY_FIELDS)
          .sort({ createdAt: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Photo.countDocuments(query),
      ]);

      const photosWithUrls = photos.map((photo) => ({
        ...photo,
        url: `${env.CLOUDFRONT_URL}/${photo.s3Key}`,
        thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photo.s3Key}`,
        displayUrl: displayUrlFor(photo.s3Key, (photo as any).metadata?.mimeType),
        category: (photo as any).category ?? null,
      }));

      const hasMore = skip + limit < total;
      logger.debug(`Fetched ${photosWithUrls.length} photos for event ${eventId}, total: ${total}, hasMore: ${hasMore}`);
      return { photos: photosWithUrls as any, total, hasMore };
    }

    logger.debug(`Fetching shuffled photos for event ${eventId} (seed=${seed}, page ${page}, limit ${limit})`);
    const cacheKey = `${eventId}:${seed}:${normalizedCategory ?? ''}`;
    const cached = this.shuffledIdCache.get(cacheKey);
    const cachedIsFresh = Boolean(cached && cached.expiresAt > Date.now());
    const currentTotal = cachedIsFresh ? await Photo.countDocuments(query) : null;
    let allIds = cachedIsFresh && cached?.total === currentTotal ? cached.ids : null;

    if (!allIds) {
      const idDocs = await Photo.find(query).select('_id').sort({ _id: 1 }).lean();
      allIds = idDocs.map((d) => String(d._id));

      const rng = mulberry32(hashStringToInt(seed));
      for (let i = allIds.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
      }

      this.shuffledIdCache.set(cacheKey, {
        ids: allIds,
        total: allIds.length,
        expiresAt: Date.now() + SHUFFLE_CACHE_TTL,
      });
    }

    const total = allIds.length;

    const pageIds = allIds.slice(skip, skip + limit);
    if (pageIds.length === 0) {
      return { photos: [], total, hasMore: false };
    }

    const docs = await Photo.find({ _id: { $in: pageIds } })
      .select(PHOTO_GALLERY_FIELDS)
      .lean();
    const docMap = new Map(docs.map((d) => [String(d._id), d]));
    const ordered = pageIds
      .map((id) => docMap.get(id))
      .filter(Boolean)
      .map((photo: any) => ({
        ...photo,
        url: `${env.CLOUDFRONT_URL}/${photo.s3Key}`,
        thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photo.s3Key}`,
        displayUrl: displayUrlFor(photo.s3Key, photo.metadata?.mimeType),
        category: photo.category ?? null,
      }));

    const hasMore = skip + limit < total;
    return { photos: ordered as any, total, hasMore };
  }

  async guestUpload(
    eventCodeOrSlug: string,
    file: Express.Multer.File,
    guestName?: string
  ): Promise<IPhoto> {
    // Try to find by slug first, then by eventCode
    let event = await Event.findOne({ customSlug: eventCodeOrSlug.toLowerCase() });
    if (!event) {
      event = await Event.findOne({ eventCode: eventCodeOrSlug.toUpperCase() });
    }
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (!event.isPaid) {
      throw new ValidationError('This event is not yet activated. Please contact the event organizer.');
    }

    if (event.packageName === 'החכמה') {
      throw new ValidationError('Guest upload is not available for this package');
    }

    if (this.isUploadExpired(event)) {
      throw new ValidationError('Upload window has expired. Contact us to extend your event.');
    }

    await this.setUploadStartedIfFirst(event);

    const s3Key = `events/${event.eventCode}/guest-uploads/${Date.now()}-${file.originalname}`;

    await s3
      .putObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    const url = `${env.CLOUDFRONT_URL}/${s3Key}`;
    const thumbnailUrl = `${env.CLOUDFRONT_URL}/thumbnails/${s3Key}`;
    const posterUrl = await this.resolveVideoPosterUrl(s3Key, file.mimetype);

    const photo = await Photo.create({
      eventId: event._id,
      s3Key,
      url,
      thumbnailUrl,
      ...(posterUrl ? { posterUrl } : {}),
      uploadedBy: 'guest',
      uploaderName: guestName || 'אורח',
      metadata: {
        size: file.size,
        mimeType: file.mimetype,
      },
    });

    const indexedFaces = await rekognitionService.indexEventPhoto({
      collectionId: event.collectionId,
      s3Key,
      eventId: String(event._id),
      photoId: String(photo._id),
    });
    if (indexedFaces.length > 0) {
      photo.indexedFaces = indexedFaces;
      photo.faceId = indexedFaces[0].faceId;
      await photo.save();
    }

    await Event.findByIdAndUpdate(event._id, {
      $inc: { photoCount: 1 },
      lastPhotoUploadedAt: new Date(),
    });

    this.clearShuffleCacheForEvent(String(event._id));

    logger.debug(`Guest photo uploaded to event ${event.eventCode}`);

    return photo;
  }

  private async findEventByCodeOrSlug(eventCodeOrSlug: string): Promise<IEvent> {
    let event = await Event.findOne({ customSlug: eventCodeOrSlug.toLowerCase() });
    if (!event) {
      event = await Event.findOne({ eventCode: eventCodeOrSlug.toUpperCase() });
    }
    if (!event) {
      throw new NotFoundError('Event');
    }
    if (!event.isPaid) {
      throw new ValidationError('This event is not yet activated. Please contact the event organizer.');
    }
    if (this.isUploadExpired(event)) {
      throw new ValidationError('Upload window has expired. Contact us to extend your event.');
    }
    return event;
  }

  async guestPresignedUrl(eventCodeOrSlug: string, fileName: string, fileType: string) {
    const event = await this.findEventByCodeOrSlug(eventCodeOrSlug);

    if (event.packageName === 'החכמה') {
      throw new ValidationError('Guest upload is not available for this package');
    }

    const key = `events/${event.eventCode}/guest-uploads/${nanoid()}-${fileName}`;
    const url = await s3.getSignedUrlPromise('putObject', {
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
      Expires: 300,
      ContentType: fileType,
    });

    return { uploadUrl: url, key, eventId: (event._id as any).toString() };
  }

  async guestCompleteUpload(
    eventCodeOrSlug: string,
    s3Key: string,
    guestName?: string,
    metadata?: { size: number; mimeType: string }
  ): Promise<IPhoto> {
    const event = await this.findEventByCodeOrSlug(eventCodeOrSlug);

    await this.setUploadStartedIfFirst(event);

    const url = `${env.CLOUDFRONT_URL}/${s3Key}`;
    const thumbnailUrl = `${env.CLOUDFRONT_URL}/thumbnails/${s3Key}`;
    const posterUrl = await this.resolveVideoPosterUrl(s3Key, metadata?.mimeType);

    const photo = await Photo.create({
      eventId: event._id,
      s3Key,
      url,
      thumbnailUrl,
      ...(posterUrl ? { posterUrl } : {}),
      uploadedBy: 'guest',
      uploaderName: guestName || 'אורח',
      metadata: metadata || {},
    });

    await Event.findByIdAndUpdate(event._id, {
      $inc: { photoCount: 1 },
      lastPhotoUploadedAt: new Date(),
    });

    this.clearShuffleCacheForEvent(String(event._id));

    rekognitionService.indexEventPhoto({
      collectionId: event.collectionId,
      s3Key,
      eventId: String(event._id),
      photoId: String(photo._id),
    }).then((indexedFaces) => {
      if (indexedFaces.length > 0) {
        Photo.findByIdAndUpdate(photo._id, {
          indexedFaces,
          faceId: indexedFaces[0].faceId,
        }).catch((err) => logger.error(`Face indexing failed for ${s3Key}: ${err.message}`));
      }
    }).catch((err) => logger.error(`Face indexing failed for ${s3Key}: ${err.message}`));

    logger.debug(`Guest photo uploaded to event ${event.eventCode} (presigned)`);

    return photo;
  }

  async setVideoPoster(s3Key: string, posterKey: string): Promise<IPhoto | null> {
    const photo = await Photo.findOne({ s3Key });
    if (!photo) {
      this.rememberPendingVideoPoster(s3Key, posterKey);
      logger.warn(`setVideoPoster: photo not found for s3Key=${s3Key}`);
      return null;
    }
    photo.posterUrl = `${env.CLOUDFRONT_URL}/${posterKey}`;
    await photo.save();
    this.clearShuffleCacheForEvent(String(photo.eventId));
    logger.info(`Poster set for ${s3Key} -> ${posterKey}`);
    return photo;
  }

  async deletePhoto(photoId: string, userId: string): Promise<void> {
    const photo = await Photo.findById(photoId).populate('eventId');
    if (!photo) {
      throw new NotFoundError('Photo');
    }

    const event = await Event.findById(photo.eventId);
    if (!event || event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to delete this photo');
    }

    await s3
      .deleteObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: photo.s3Key,
      })
      .promise();

    const faceIds = collectPhotoFaceIds(photo);
    if (faceIds.length > 0) {
      await rekognitionService.deleteFaces(event.collectionId, faceIds);
    }

    await Photo.findByIdAndDelete(photoId);

    await Event.findByIdAndUpdate(photo.eventId, {
      $inc: { photoCount: -1 },
    });

    this.clearShuffleCacheForEvent(String(event._id));

    logger.debug(`Photo deleted: ${photo.s3Key}`);
  }

  async streamPhotosZip(photoIds: string[], res: Response): Promise<void> {
    const photos = await Photo.find({ _id: { $in: photoIds } });

    if (photos.length === 0) {
      throw new NotFoundError('Photos');
    }

    // Get event for filename
    const event = await Event.findById(photos[0].eventId);
    const eventCode = event?.eventCode || 'photos';

    const zipFilename = `${eventCode}-${Date.now()}.zip`;

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
      const originalName = photo.s3Key.split('/').pop() || `photo-${i + 1}.jpg`;
      const filename = `photo-${i + 1}-${originalName}`;

      const s3Stream = s3.getObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: photo.s3Key,
      }).createReadStream();

      archive.append(s3Stream, { name: filename });
    }

    await archive.finalize();

    logger.debug(`Streamed zip with ${photos.length} photos`);
  }

  async getDownloadUrl(photoId: string): Promise<string> {
    const photo = await Photo.findById(photoId);
    if (!photo) {
      throw new NotFoundError('Photo');
    }

    const fileName = photo.s3Key.split('/').pop() || `photo-${photo._id}.jpg`;

    const url = s3.getSignedUrl('getObject', {
      Bucket: env.S3_BUCKET_NAME,
      Key: photo.s3Key,
      Expires: 3600,
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
    });

    return url;
  }

  /** Every (non-placeholder) object under a prefix, paginated. */
  private async listAllObjects(prefix: string): Promise<{ key: string; etag: string }[]> {
    const objects: { key: string; etag: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await s3.listObjectsV2({
        Bucket: env.S3_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }).promise();
      for (const obj of result.Contents || []) {
        // Skip the prefix itself and any zero-byte "folder" placeholder keys.
        if (obj.Key && obj.Key !== prefix && !obj.Key.endsWith('/')) {
          objects.push({ key: obj.Key, etag: obj.ETag || obj.Key });
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    return (await this.listAllObjects(prefix)).map((o) => o.key);
  }

  async getShowcaseImages(): Promise<ShowcaseMedia[]> {
    const now = Date.now();
    if (this.showcaseImageCache && this.cacheExpiry > now) {
      logger.debug('Returning cached showcase media');
      return this.showcaseImageCache;
    }

    logger.debug('Fetching showcase media from S3');
    const prefix = 'gallery_showcase/';
    const videoExt = /\.(mp4|mov|webm|m4v)$/i;

    // Originals, plus whichever renditions already exist. Listing the rendition
    // prefixes (2 cheap calls, cached) lets us point at them only when they're
    // really there — no 404-then-fallback per image.
    const [objects, thumbKeys, displayKeys] = await Promise.all([
      this.listAllObjects(prefix),
      this.listAllKeys(`thumbnails/${prefix}`),
      this.listAllKeys(`display/${prefix}`),
    ]);

    if (objects.length === 0) return [];

    // Identical bytes = identical ETag. A file copied into a story folder but
    // left in the root would otherwise appear twice in the grid; keep the copy
    // that sits deepest so it keeps its story.
    const storyDepth = (key: string) => (key.slice(prefix.length).includes('/') ? 1 : 0);
    const byEtag = new Map<string, string>();
    for (const obj of objects) {
      const kept = byEtag.get(obj.etag);
      if (!kept || storyDepth(obj.key) > storyDepth(kept)) byEtag.set(obj.etag, obj.key);
    }
    const keys = Array.from(byEtag.values());
    const dropped = objects.length - keys.length;
    if (dropped > 0) logger.debug(`Showcase: dropped ${dropped} duplicate object(s)`);

    const thumbSet = new Set(thumbKeys);
    const displaySet = new Set(displayKeys);
    const cloudFrontUrl = env.CLOUDFRONT_URL;
    const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
    const cdn = (key: string) => `${cloudFrontUrl}/${encodeKey(key)}`;

    const media: ShowcaseMedia[] = keys
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const rest = key.slice(prefix.length); // "<story>/file" or "file"
        const slash = rest.indexOf('/');
        const story = slash > 0 ? rest.slice(0, slash) : null;
        const type: 'photo' | 'video' = videoExt.test(key) ? 'video' : 'photo';
        const thumbKey = `thumbnails/${key}`;
        const displayKey = `display/${key}`;
        return {
          url: cdn(key),
          thumbnailUrl: thumbSet.has(thumbKey) ? cdn(thumbKey) : undefined,
          displayUrl: displaySet.has(displayKey) ? cdn(displayKey) : undefined,
          type,
          story,
        };
      });

    const withThumbs = media.filter((m) => m.thumbnailUrl).length;
    this.showcaseImageCache = media;
    this.cacheExpiry = now + SHOWCASE_CACHE_TTL;
    logger.debug(`Cached ${media.length} showcase media (${withThumbs} with thumbnails)`);

    return media;
  }
}

export const photosService = new PhotosService();
