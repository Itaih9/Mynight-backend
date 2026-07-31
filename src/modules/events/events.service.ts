import { Event, IEvent, IGuestListFile } from './events.model';
import { User } from '../auth/user.model';
import { Photo } from '../photos/photos.model';
import { rekognitionService } from '../rekognition/rekognition.service';
import { couponService } from '../coupon/coupon.service';
import { generateEventCode, generateRandomSlugSuffix, formatPhoneNumber } from '@/shared/utils/helpers';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';

class EventsService {
  /**
   * Every event lives until 6 months AFTER the wedding — not 6 months after it
   * was created. A couple who books a year out would otherwise lose the album
   * before the day. Falls back to creation date only when no wedding date is
   * known (the bare createEvent path).
   */
  private computeExpiresAt(weddingDate?: Date | null, createdAt?: Date): Date {
    const base = new Date(weddingDate || createdAt || new Date());
    base.setMonth(base.getMonth() + 6);
    return base;
  }

  private isExpired(event: IEvent): boolean {
    // Derive from weddingDate rather than trusting the stored value, so events
    // created before this rule get the correct lifetime with no migration.
    const base = this.computeExpiresAt(event.weddingDate, event.createdAt);
    const stored = event.expiresAt ? new Date(event.expiresAt) : null;
    // A stored date that's later wins — that's an admin extension.
    const effective = stored && stored > base ? stored : base;
    return effective < new Date();
  }

  async createEvent(userId: string, name: string): Promise<IEvent> {
    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;

    await rekognitionService.createCollection(collectionId);

    // No wedding date on this path — falls back to creation date.
    const expiresAt = this.computeExpiresAt(null, new Date());

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

    const expiresAt = this.computeExpiresAt(weddingDate);

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
    await this.sendCreationEmail(userId, event);

    return event;
  }

  /**
   * Self-serve FREE פלאש signup — the top of the lead funnel.
   *
   * A couple registers with no payment and gets the disposable camera enabled
   * immediately. They keep every photo their guests shoot; what's sold later is
   * the smart layer (face recognition, per-guest albums, photographer photos).
   * The event is marked `source: 'flash_free'` so the pre-wedding upsell sweep
   * can find it, and stays `isPaid: false` until they buy.
   *
   * Idempotent per phone: a couple who signs up twice gets their existing event
   * back rather than a duplicate — including a PAID one, so a paying couple who
   * lands on /flash never ends up with their photos split across two events.
   */
  async registerFreeFlash(data: {
    coupleName: string;
    weddingDate: Date;
    phoneNumber: string;
    email: string;
  }): Promise<{ event: IEvent; isNew: boolean }> {
    // Must match how auth stores numbers (+972…), or the account we create here
    // can never be logged into and every login mints a second, orphaned user.
    const phone = formatPhoneNumber(data.phoneNumber);

    let user = await User.findOne({ phoneNumber: phone });
    if (!user) {
      user = await User.create({
        phoneNumber: phone,
        name: data.coupleName,
        email: data.email,
        weddingDate: data.weddingDate,
      });
      logger.info(`Free פלאש: created user ${user._id} (${phone})`);
    } else {
      // Fill gaps without clobbering anything they've already set.
      const patch: Record<string, unknown> = {};
      if (!user.weddingDate) patch.weddingDate = data.weddingDate;
      if (!user.email && data.email) patch.email = data.email;
      if (!user.name) patch.name = data.coupleName;
      if (Object.keys(patch).length) await User.updateOne({ _id: user._id }, patch);
    }

    // Reuse ANY existing event for this couple, paid or free — creating a second
    // one would scatter their guests' photos across two galleries.
    const existing = await Event.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (existing) {
      if (!existing.disposableEnabled) {
        existing.disposableEnabled = true;
        await existing.save();
      }
      return { event: existing, isNew: false };
    }

    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;
    await rekognitionService.createCollection(collectionId);

    const expiresAt = this.computeExpiresAt(data.weddingDate);

    const event = await Event.create({
      userId: user._id,
      name: data.coupleName,
      eventCode,
      collectionId,
      expiresAt,
      weddingDate: data.weddingDate,
      isPaid: false,
      source: 'flash_free',
      disposableEnabled: true,
    });

    logger.info(`Free פלאש registered: ${eventCode} for ${data.coupleName} (${phone})`);

    await this.ensureGiftCoupon(String(event._id));
    // Welcome + first Here I Am pitch. Never let mail failure abort signup.
    try {
      if (data.email || user.email) {
        const { emailService } = await import('@/shared/services/email.service');
        await emailService.sendFlashWelcomeEmail({
          to: (data.email || user.email)!,
          coupleName: data.coupleName,
          eventCode,
          weddingDate: data.weddingDate,
        });
      }
    } catch (err) {
      logger.error(`Free פלאש welcome mail failed for ${eventCode}: ${(err as Error).message}`);
    }

    return { event, isNew: true };
  }

  // Guest link + calendar reminders for the couple. Never let a mail failure
  // abort event creation — the event is the thing that matters.
  private async sendCreationEmail(userId: string, event: IEvent): Promise<void> {
    try {
      if (!event.weddingDate) return;

      const user = await User.findById(userId).select('email').lean();
      if (!user?.email) {
        logger.warn(`No email for user ${userId}; skipping event creation email`);
        return;
      }

      const { emailService } = await import('@/shared/services/email.service');
      await emailService.sendEventCreatedEmail(user.email, {
        eventName: event.name,
        eventCode: event.eventCode,
        weddingDate: event.weddingDate,
      });
    } catch (err) {
      logger.error(`Event creation email failed for ${event.eventCode}: ${(err as Error).message}`);
    }
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
