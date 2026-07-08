import { Event, IEvent, IGuestListFile } from './events.model';
import { User } from '../auth/user.model';
import { Photo } from '../photos/photos.model';
import { rekognitionService } from '../rekognition/rekognition.service';
import { couponService } from '../coupon/coupon.service';
import { generateEventCode, generateRandomSlugSuffix } from '@/shared/utils/helpers';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';

class EventsService {
  private isExpired(event: IEvent): boolean {
    const base = new Date(event.createdAt);
    base.setMonth(base.getMonth() + 6);
    const stored = event.expiresAt ? new Date(event.expiresAt) : null;
    const effective = stored && stored > base ? stored : base;
    return effective < new Date();
  }

  async createEvent(userId: string, name: string): Promise<IEvent> {
    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;

    await rekognitionService.createCollection(collectionId);

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);

    const event = await Event.create({
      userId,
      name,
      eventCode,
      collectionId,
      expiresAt,
    });

    logger.info(`Event created: ${eventCode} by user ${userId}`);

    await this.ensureGiftCoupon(String(event._id));

    return event;
  }

  // Auto-create the per-event gift coupon shown in the gallery's gift section.
  // Never let a coupon failure abort event creation.
  private async ensureGiftCoupon(eventId: string): Promise<void> {
    try {
      await couponService.getOrCreateEventCoupon(eventId);
    } catch (err) {
      logger.error(`Failed to create gift coupon for event ${eventId}: ${(err as Error).message}`);
    }
  }

  async createEventWithSlug(userId: string, name: string, customSlug: string, weddingDate: Date, packageName?: string): Promise<IEvent> {
    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;

    await rekognitionService.createCollection(collectionId);

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);

    const suffixPattern = /-[a-z0-9]{4}$/;
    const slugBase = suffixPattern.test(customSlug)
      ? customSlug.slice(0, -5)
      : customSlug;

    let slug = customSlug;
    let slugExists = await Event.findOne({ customSlug: slug });
    while (slugExists) {
      slug = `${slugBase}-${generateRandomSlugSuffix()}`;
      slugExists = await Event.findOne({ customSlug: slug });
    }

    const event = await Event.create({
      userId,
      name,
      eventCode,
      customSlug: slug,
      collectionId,
      expiresAt,
      weddingDate,
      packageName,
    });

    logger.info(`Event created with slug: ${slug} (code: ${eventCode}) by user ${userId}`);

    await this.ensureGiftCoupon(String(event._id));

    return event;
  }

  async getEvent(eventId: string): Promise<IEvent> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (this.isExpired(event)) {
      throw new ValidationError('Event has expired');
    }

    return event;
  }

  async getEventByCode(eventCode: string): Promise<IEvent> {
    const event = await Event.findOne({ eventCode: eventCode.toUpperCase() });
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (this.isExpired(event)) {
      throw new ValidationError('Event has expired');
    }

    return event;
  }

  async getEventBySlug(slug: string): Promise<IEvent> {
    const event = await Event.findOne({ customSlug: slug.toLowerCase() });
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (this.isExpired(event)) {
      throw new ValidationError('Event has expired');
    }

    return event;
  }

  async getEventByCodeOrSlug(identifier: string): Promise<IEvent> {
    let event = await Event.findOne({ customSlug: identifier.toLowerCase() });

    if (!event) {
      event = await Event.findOne({ eventCode: identifier.toUpperCase() });
    }

    if (!event) {
      throw new NotFoundError('Event');
    }

    if (this.isExpired(event)) {
      throw new ValidationError('Event has expired');
    }

    if (!event.weddingDate) {
      const user = await User.findById(event.userId).select('weddingDate');
      if (user?.weddingDate) {
        event.weddingDate = user.weddingDate;
        await event.save();
      }
    }

    return event;
  }

  async getUserEvents(userId: string): Promise<IEvent[]> {
    const events = await Event.find({ userId }).sort({ createdAt: -1 });
    return events;
  }

  async deleteEvent(eventId: string, userId: string): Promise<void> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    await this.purgeEvent(event);

    logger.info(`Event deleted: ${event.eventCode} by user ${userId}`);
  }

  async adminDeleteEvent(eventId: string): Promise<void> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    await this.purgeEvent(event);

    logger.info(`Event deleted by admin: ${event.eventCode}`);
  }

  private async purgeEvent(event: IEvent): Promise<void> {
    await rekognitionService.deleteCollection(event.collectionId);

    await this.deleteS3Prefix(`events/${event.eventCode}/`);
    await this.deleteS3Prefix(`thumbnails/events/${event.eventCode}/`);

    await Photo.deleteMany({ eventId: event._id });

    await Event.findByIdAndDelete(event._id);
  }

  private async deleteS3Prefix(prefix: string): Promise<void> {
    try {
      let continuationToken: string | undefined;
      do {
        const listed = await s3
          .listObjectsV2({
            Bucket: env.S3_BUCKET_NAME,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          })
          .promise();

        const objects = (listed.Contents || [])
          .map((o) => ({ Key: o.Key! }))
          .filter((o) => !!o.Key);

        if (objects.length > 0) {
          await s3
            .deleteObjects({
              Bucket: env.S3_BUCKET_NAME,
              Delete: { Objects: objects, Quiet: true },
            })
            .promise();
        }

        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err: any) {
      logger.error(`Failed to delete S3 objects under prefix ${prefix}: ${err.message}`);
    }
  }

  async updateSlug(eventId: string, userId: string, customSlug: string): Promise<IEvent> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    if ((event.slugChangeCount ?? 0) >= 3) {
      throw new ValidationError('Slug change limit reached. Please contact support to make further changes.');
    }

    const existing = await Event.findOne({ customSlug, _id: { $ne: eventId } });
    if (existing) {
      throw new ValidationError('Slug already in use');
    }

    event.customSlug = customSlug;
    event.slugChangeCount = (event.slugChangeCount ?? 0) + 1;
    await event.save();

    logger.info(`Slug updated to ${customSlug} (change #${event.slugChangeCount}) for event ${event.eventCode} by user ${userId}`);
    return event;
  }

  async updateSharingPermissions(
    eventId: string,
    userId: string,
    permissions: { showProPhotos?: boolean; showGuestPhotos?: boolean; showGuestStories?: boolean }
  ): Promise<IEvent> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    const updatedEvent = await Event.findByIdAndUpdate(
      eventId,
      {
        $set: {
          'sharingPermissions.showProPhotos': permissions.showProPhotos ?? event.sharingPermissions.showProPhotos,
          'sharingPermissions.showGuestPhotos': permissions.showGuestPhotos ?? event.sharingPermissions.showGuestPhotos,
          'sharingPermissions.showGuestStories': permissions.showGuestStories ?? event.sharingPermissions.showGuestStories,
        },
      },
      { new: true }
    );

    logger.info(`Sharing permissions updated for event ${event.eventCode}`);

    return updatedEvent!;
  }

  async uploadGuestListFile(
    eventId: string,
    userId: string,
    file: Express.Multer.File
  ): Promise<IGuestListFile> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.guestListFile?.s3Key) {
      await s3
        .deleteObject({
          Bucket: env.S3_BUCKET_NAME,
          Key: event.guestListFile.s3Key,
        })
        .promise();
      logger.debug(`Deleted old guest list file: ${event.guestListFile.s3Key}`);
    }

    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = originalName.includes('.') ? originalName.split('.').pop() : '';
    const s3Key = `events/${event.eventCode}/guest-list/${Date.now()}-guest-list${ext ? `.${ext}` : ''}`;

    await s3
      .putObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    const guestListFile: IGuestListFile = {
      s3Key,
      originalName,
      size: file.size,
      mimeType: file.mimetype,
      uploadedAt: new Date(),
    };

    await Event.findByIdAndUpdate(eventId, {
      guestListFile,
      $inc: { guestListUploadCount: 1 },
    });

    logger.info(`Guest list file uploaded for event ${event.eventCode}: ${originalName}`);

    return guestListFile;
  }

  async deleteGuestListFile(eventId: string, userId: string): Promise<void> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (!event.guestListFile?.s3Key) {
      throw new ValidationError('No guest list file exists');
    }

    await s3
      .deleteObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: event.guestListFile.s3Key,
      })
      .promise();

    await Event.findByIdAndUpdate(eventId, { $unset: { guestListFile: 1 } });

    logger.info(`Guest list file deleted for event ${event.eventCode}`);
  }

  async getGuestListFile(eventId: string, userId: string): Promise<IGuestListFile | null> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    return event.guestListFile || null;
  }
}

export const eventsService = new EventsService();
