import { Event, IEvent, IGuestListFile } from './events.model';
import { User } from '../auth/user.model';
import { Photo } from '../photos/photos.model';
import { rekognitionService } from '../rekognition/rekognition.service';
import { couponService } from '../coupon/coupon.service';
import {
  generateEventCode,
  generateRandomSlugSuffix,
  generateCustomSlug,
  formatPhoneNumber,
  generateReferralCode,
  isValidIsraeliMobile,
  isValidEmail,
  israeliPhoneCandidates,
} from '@/shared/utils/helpers';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/utils/errors';
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

  /**
   * Walk a desired slug to one nothing else holds.
   *
   * `generated` says whether the trailing 4 characters are OUR random suffix. If
   * they are, a collision replaces them rather than stacking a second one, so a
   * retry never grows the URL. If the slug was typed by a human it is left
   * whole: stripping the last four characters of `dana-yoav` on collision would
   * quietly publish `dana-x7k2` and lose a partner's name from the link.
   */
  private async resolveUniqueSlug(desired: string, generated = true): Promise<string> {
    const suffixPattern = /-[a-z0-9]{4}$/;
    const base = generated && suffixPattern.test(desired) ? desired.slice(0, -5) : desired;

    let slug = desired;
    while (await Event.findOne({ customSlug: slug })) {
      slug = `${base}-${generateRandomSlugSuffix()}`;
    }
    return slug;
  }

  async createEventWithSlug(userId: string, name: string, customSlug: string, weddingDate: Date, packageName?: string): Promise<IEvent> {
    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;

    await rekognitionService.createCollection(collectionId);

    const expiresAt = this.computeExpiresAt(weddingDate);

    const slug = await this.resolveUniqueSlug(customSlug);

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
  async registerFreeFlash(
    data: {
      coupleName: string;
      weddingDate: Date;
      phoneNumber: string;
      email: string;
    },
    // Stamp events made via the automation service token so that token can later
    // delete its own test events — but never a real couple's gallery.
    opts?: { createdByService?: boolean }
  ): Promise<{ event: IEvent; isNew: boolean }> {
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
        // Required and unique on the model — the auth paths generate it too, and
        // omitting it made every free signup fail with a 500.
        referralCode: generateReferralCode(),
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
      createdByService: !!opts?.createdByService,
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
          // The canonical number the account logs in with — shown in the email
          // so the couple knows exactly which number opens their album.
          phoneNumber: user.phoneNumber,
        });
      }
    } catch (err) {
      logger.error(`Free פלאש welcome mail failed for ${eventCode}: ${(err as Error).message}`);
    }

    // Lead alert. Only on isNew — registration is idempotent per phone, so a
    // couple returning to the form must not re-notify. Service-created events
    // are QA fixtures rather than real signups, so they stay silent.
    if (!opts?.createdByService) {
      try {
        const { emailService } = await import('@/shared/services/email.service');
        await emailService.sendSignupAdminNotification({
          coupleName: data.coupleName,
          eventCode,
          weddingDate: data.weddingDate,
          phoneNumber: user.phoneNumber,
          contactEmail: data.email || user.email,
          tier: (event.flashTier as 'basic' | 'plus') || 'basic',
        });
      } catch (err) {
        logger.error(`Signup admin alert failed for ${eventCode}: ${(err as Error).message}`);
      }
    }

    return { event, isNew: true };
  }

  /** Lowercase, hyphen-joined, and free of anything a URL would have to escape. */
  private normalizeSlug(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Admin-created event — the manual path for a couple who never came through
   * registration: a phone sale, a venue deal, a photographer's client, or a
   * gallery being rebuilt after the fact.
   *
   * It deliberately walks the same road the self-serve flow does rather than
   * writing a bare Event document: the couple gets a real account they can log
   * into with their own phone number, a Rekognition collection, a gift coupon
   * and a personal coupon. An event assembled by hand out of half those pieces
   * looks fine in the admin table and then fails in the gallery.
   *
   * Two things it does NOT do. It never mails anyone unless the admin asks —
   * backfilling last season's weddings must not spray welcome mail at couples
   * who are already married. And it refuses a phone number that already has an
   * event: the couple-facing flows all resolve a couple to ONE event
   * (`Event.findOne({ userId })`), so a second one would be a gallery their
   * guests can reach and they cannot.
   */
  async adminCreateEvent(
    data: {
      partnerName1: string;
      partnerName2?: string;
      phoneNumber: string;
      email?: string;
      weddingDate: Date | string;
      packageName?: string;
      isPaid?: boolean;
      flashTier?: 'basic' | 'plus';
      customSlug?: string;
      disposableEnabled?: boolean;
      // No shot limit here on purpose: the camera reads the roll length from
      // planFor(flashTier).shotLimit, so event.disposableShotLimit is never
      // consulted. Offering the field would promise something that never happens.
      sendWelcomeEmail?: boolean;
    },
    opts?: { createdByService?: boolean }
  ): Promise<{ event: IEvent; userCreated: boolean; phoneNumber: string; emailSent: boolean }> {
    // Every text field is checked for type before use. A JSON body is whatever
    // the caller sent, and `.trim()` on a number is a 500 rather than a 400.
    const text = (value: unknown, field: string): string => {
      if (value === undefined || value === null) return '';
      if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
      return value.trim();
    };

    const partner1 = text(data.partnerName1, 'Partner name');
    const partner2 = text(data.partnerName2, 'Partner name');
    if (!partner1) {
      throw new ValidationError('Partner name is required');
    }

    const rawPhone = text(data.phoneNumber, 'Phone number');
    if (!isValidIsraeliMobile(rawPhone)) {
      throw new ValidationError('A valid Israeli mobile number is required');
    }
    const phone = formatPhoneNumber(rawPhone);

    const email = text(data.email, 'Email');
    if (email && !isValidEmail(email)) {
      throw new ValidationError('Email address is not valid');
    }

    const weddingDate = new Date(data.weddingDate);
    if (isNaN(weddingDate.getTime())) {
      throw new ValidationError('Wedding date is not a valid date');
    }
    // Wider than the self-serve rule on purpose: an admin backfilling a gallery
    // for a wedding that already happened is a real, ordinary case.
    const earliest = new Date();
    earliest.setFullYear(earliest.getFullYear() - 5);
    const latest = new Date();
    latest.setFullYear(latest.getFullYear() + 5);
    if (weddingDate < earliest || weddingDate > latest) {
      throw new ValidationError('Wedding date must be within five years either side of today');
    }

    const packageName = text(data.packageName, 'Package name');
    const customSlug = text(data.customSlug, 'Custom link');

    // EVERY check has to clear before the first write. An account created and
    // then abandoned by a later throw is not merely litter: it is a passwordless
    // account carrying a real couple's name and number, and the unauthenticated
    // /api/auth/register/direct mints a FULL session for any account that has no
    // event — so whoever knows that number could claim it. Nothing below this
    // line may reject the request.
    const slugIsGenerated = !customSlug;
    const desiredSlug = slugIsGenerated
      ? this.normalizeSlug(generateCustomSlug(partner1, partner2, weddingDate))
      : this.normalizeSlug(customSlug);
    if (desiredSlug.length < 3) {
      throw new ValidationError(
        'Custom link must be at least 3 characters, using English letters, numbers or hyphens'
      );
    }

    // Match the number the way LOGIN matches it. Numbers stored before the
    // formatPhoneNumber fix live as +0501234567 and other variants, and a lookup
    // on the canonical form alone would miss a couple who already has an event —
    // handing them a second gallery, with login landing on whichever one Mongo
    // returned first and the QR codes pointing at the other.
    let user = await User.findOne({ phoneNumber: { $in: israeliPhoneCandidates(phone) } });
    let userCreated = false;

    if (user) {
      const existing = await Event.findOne({ userId: user._id }).sort({ createdAt: -1 });
      if (existing) {
        throw new ConflictError(
          `${phone} already has an event (${existing.eventCode} — ${existing.name}). Edit that one instead.`
        );
      }
      // Fill gaps without clobbering anything the couple already set themselves.
      const patch: Record<string, unknown> = {};
      if (!user.name) patch.name = partner2 ? `${partner1} & ${partner2}` : partner1;
      if (!user.partnerName1) patch.partnerName1 = partner1;
      if (!user.partnerName2 && partner2) patch.partnerName2 = partner2;
      if (!user.weddingDate) patch.weddingDate = weddingDate;
      if (!user.email && email) patch.email = email;
      if (Object.keys(patch).length) await User.updateOne({ _id: user._id }, patch);
    } else {
      user = await User.create({
        phoneNumber: phone,
        name: partner2 ? `${partner1} & ${partner2}` : partner1,
        partnerName1: partner1,
        partnerName2: partner2 || undefined,
        email: email || undefined,
        weddingDate,
        referralCode: generateReferralCode(),
      });
      userCreated = true;
    }

    const slug = await this.resolveUniqueSlug(desiredSlug, slugIsGenerated);

    // A wedding more than six months gone would compute an expiry already in the
    // past, and the gallery refuses an expired event — so the admin would have
    // created something dead on arrival. Give any such event a full six months
    // from today instead.
    const expiresAt = this.computeExpiresAt(weddingDate);
    const effectiveExpiresAt =
      expiresAt > new Date() ? expiresAt : this.computeExpiresAt(null, new Date());

    // A body is not a form; `"false"` and `0` are not booleans.
    const isPaid = data.isPaid === true;
    const disposableEnabled = data.disposableEnabled === true;

    // Paid means Plus, with no way to ask for otherwise. Every payment path
    // writes flashTier: 'plus', so a self-serve paid event is always Plus; a
    // paid event left on basic answers 400 from every face endpoint and gives
    // guests an 8-shot roll — a fully paid gallery with its album switched off.
    const flashTier = isPaid ? 'plus' : data.flashTier === 'plus' ? 'plus' : 'basic';

    // The stamp is the automation's licence to delete this event later, so grant
    // it only for something the token invented outright: a free event on an
    // account this very call created. A paid gallery, or an event hung on a
    // couple who already had an account, is somebody's real wedding — and
    // `createdByService` is precisely the flag that would let the token purge it.
    const createdByService = !!opts?.createdByService && userCreated && !isPaid;

    const eventCode = generateEventCode();
    const collectionId = `event-${eventCode.toLowerCase()}`;

    let event: IEvent;
    try {
      await rekognitionService.createCollection(collectionId);

      event = await Event.create({
        userId: user._id,
        name: partner2 ? `${partner1} & ${partner2}` : partner1,
        eventCode,
        customSlug: slug,
        collectionId,
        expiresAt: effectiveExpiresAt,
        weddingDate,
        isPaid,
        packageName: packageName || undefined,
        source: 'admin',
        flashTier,
        disposableEnabled,
        createdByService,
      });
    } catch (err) {
      // AWS was down, or a concurrent create took the slug. Whatever the reason,
      // an account with no event is a CLAIMABLE account — /api/auth/register/direct
      // hands a full session to anyone who knows the number — so take it back out
      // rather than leave one behind for a request that failed.
      if (userCreated) {
        await User.deleteOne({ _id: user._id }).catch((cleanupErr) =>
          logger.error(`Failed to roll back user ${user!._id}: ${(cleanupErr as Error).message}`)
        );
      }
      await rekognitionService
        .deleteCollection(collectionId)
        .catch(() => logger.warn(`Left an orphan Rekognition collection: ${collectionId}`));

      // A unique-index clash is the caller losing a race, not a server fault.
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError('That phone number or link was just taken. Please try again.');
      }
      throw err;
    }

    logger.info(
      `Admin created event ${eventCode} (${slug}) for ${partner1}${partner2 ? ` & ${partner2}` : ''} (${phone}) — paid=${isPaid} tier=${flashTier}`
    );

    await this.ensureGiftCoupon(String(event._id));
    try {
      await couponService.getOrCreatePersonal(String(user._id));
    } catch (err) {
      logger.error(`Personal coupon creation failed for ${user._id}: ${(err as Error).message}`);
    }

    // Report whether mail actually left, rather than whether it was requested.
    // With no address on the account there is nothing to send to, and the admin
    // would otherwise close the dialog believing the couple had been told.
    let emailSent = false;
    if (data.sendWelcomeEmail) {
      emailSent = await this.sendCreationEmail(String(user._id), event);
    }

    return { event, userCreated, phoneNumber: user.phoneNumber, emailSent };
  }

  // Guest link + calendar reminders for the couple. Never let a mail failure
  // abort event creation — the event is the thing that matters. Returns whether
  // the mail actually left, so a caller can tell the operator the truth instead
  // of assuming a request to send is a send.
  private async sendCreationEmail(userId: string, event: IEvent): Promise<boolean> {
    try {
      if (!event.weddingDate) return false;

      const user = await User.findById(userId).select('email').lean();
      if (!user?.email) {
        logger.warn(`No email for user ${userId}; skipping event creation email`);
        return false;
      }

      const { emailService } = await import('@/shared/services/email.service');
      await emailService.sendEventCreatedEmail(user.email, {
        eventName: event.name,
        eventCode: event.eventCode,
        weddingDate: event.weddingDate,
      });
      return true;
    } catch (err) {
      logger.error(`Event creation email failed for ${event.eventCode}: ${(err as Error).message}`);
      return false;
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
