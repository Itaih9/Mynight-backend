import { EmailCampaign, EmailSendLog, IEmailCampaign, ICampaignBlocks } from './emailCampaign.model';
import { Event } from '../events/events.model';
import { User } from '../auth/user.model';
import { env } from '@/shared/config/env';
import { NotFoundError } from '@/shared/utils/errors';
import { publicEventRef } from '@/shared/utils/helpers';
import logger from '@/shared/utils/logger';
import { sanitizePhoneNumber } from '@/shared/utils/helpers';
import { clickUrl, signClickToken, trackingBase, withSource, TrackedChannel } from './campaignTracking';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The CTA as it goes out on one channel, for one recipient: `url` is what the
 * link points at (our redirect when tracking is on), `code` is the bare token
 * for a Wati URL-button, whose dynamic part is a suffix rather than a whole URL.
 */
interface CtaLink {
  url: string;
  code: string;
}

/** Recipient resolved from an audience query, ready to mail. */
interface Recipient {
  eventId: string;
  eventCode: string;
  // The personal link, when the event has one — camera links prefer it so a
  // guest sees names rather than eight random characters.
  customSlug?: string;
  coupleName: string;
  email: string;
  phone: string;
  daysToWedding: number | null;
  daysSinceSignup: number;
}

/**
 * The default sequence, seeded once on first boot. Mirrors the previous
 * hardcoded 60/30/7 stages exactly so behaviour is unchanged on migration —
 * everything here is editable in the admin afterwards.
 */
// Each stage carries a lower bound so the windows don't overlap. Without it a
// couple who registers 10 days out matches d60 AND d30 on the same sweep and
// receives two near-identical emails at once.
const DEFAULT_CAMPAIGNS: Partial<IEmailCampaign>[] = [
  { days: 60, minDays: 31 },
  { days: 30, minDays: 8 },
  { days: 7, minDays: 0 },
].map(({ days, minDays }) => ({
  name: `My Night — ${days} ימים לפני החתונה`,
  audience: 'flash_free_unpaid' as const,
  filters: { requireEmail: true, minDaysToWedding: minDays },
  trigger: { type: 'before_wedding' as const, days },
  subject:
    days <= 7
      ? 'עוד {{daysToWedding}} ימים — רוצים שכל אורח יקבל את התמונות שלו?'
      : '{{coupleName}}, שדרוג אחד לפני החתונה',
  blocks: {
    title: 'עוד {{daysToWedding}} ימים לחתונה שלכם',
    paragraphs: [
      'פלאש כבר מוכן — האורחים שלכם יצלמו, ואתם תקבלו את כל התמונות בבוקר שאחרי.',
      'זה בדיוק מה ש-<strong>My Night</strong> מוסיף. אפשר לשדרג עד ליום החתונה.',
    ],
    bullets: [
      'כל אורח מקבל אלבום אישי — רק עם התמונות שהוא בהן',
      'גם התמונות מהצלם המקצועי נכנסות לזיהוי הפנים',
      'סטורי מוכן כבר ביום שאחרי החתונה',
    ],
    // Always "שדרוג ל-My Night" in post-פלאש copy. The package is called
    // Here I Am / החכמה in the catalogue, but a free פלאש couple has never seen
    // that name — to them the upgrade is to My Night, and naming a product they
    // do not recognise reads as a different company asking for money.
    ctaText: 'שדרוג ל-My Night',
    // Straight to checkout, not the /here-i-am lead form: a couple who clicked
    // "שדרוג ל-My Night" has decided, and should not be asked to request a call
    // back on a page named after a product they have never heard of.
    ctaUrl: `${env.FRONTEND_URL}/register?package=Here%20I%20Am`,
    footnote: 'לא מעוניינים? אפשר להתעלם — פלאש נשאר שלכם בחינם.',
  },
  isActive: true,
}));

class EmailCampaignService {
  async seedDefaults(): Promise<void> {
    if ((await EmailCampaign.countDocuments()) === 0) {
      await EmailCampaign.insertMany(DEFAULT_CAMPAIGNS);
      logger.info(`Seeded ${DEFAULT_CAMPAIGNS.length} default email campaigns`);
      return;
    }

    // Backfill: campaigns seeded before stage windows existed have no lower
    // bound, so overlapping stages would double-send. Give any before_wedding
    // campaign that's still missing one the bound implied by its own stage.
    const BOUNDS: Record<number, number> = { 60: 31, 30: 8, 7: 0 };
    const stale = await EmailCampaign.find({
      'trigger.type': 'before_wedding',
      'filters.minDaysToWedding': { $exists: false },
    });
    for (const c of stale) {
      const min = BOUNDS[c.trigger.days ?? -1];
      if (min === undefined) continue;
      await EmailCampaign.updateOne({ _id: c._id }, { $set: { 'filters.minDaysToWedding': min } });
      logger.info(`Campaign "${c.name}": set minDaysToWedding=${min} to stop overlapping stages`);
    }
  }

  // ---- CRUD ----------------------------------------------------------------
  async list() {
    return EmailCampaign.find().sort({ 'trigger.days': -1, createdAt: -1 }).lean();
  }

  async create(data: Partial<IEmailCampaign>) {
    return EmailCampaign.create(data);
  }

  async update(id: string, data: Partial<IEmailCampaign>) {
    const c = await EmailCampaign.findByIdAndUpdate(id, data, { new: true });
    if (!c) throw new NotFoundError('Campaign');
    return c;
  }

  async remove(id: string): Promise<void> {
    await EmailCampaign.findByIdAndDelete(id);
    await EmailSendLog.deleteMany({ campaignId: id });
  }

  /** Who has already received this campaign — the audit trail. */
  async history(campaignId: string, limit = 100) {
    return EmailSendLog.find({ campaignId }).sort({ sentAt: -1 }).limit(limit).lean();
  }

  /**
   * Searchable contact list for the picker — one row per couple/event, with
   * everything needed to decide whether to include them.
   */
  async listContacts(search = '', limit = 200) {
    const events = await Event.find()
      .select('_id eventCode customSlug name weddingDate isPaid source userId createdAt')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    const userIds = events.map((e) => e.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('_id email phoneNumber').lean();
    const byId = new Map(users.map((u: any) => [String(u._id), u]));

    const term = search.trim().toLowerCase();
    const rows = events.map((e) => {
      const u: any = byId.get(String(e.userId));
      return {
        eventId: String(e._id),
        eventCode: e.eventCode,
        customSlug: e.customSlug,
        coupleName: e.name,
        email: u?.email || '',
        phone: u?.phoneNumber || '',
        weddingDate: e.weddingDate || null,
        isPaid: !!e.isPaid,
        source: (e as any).source || 'paid',
      };
    });

    const filtered = term
      ? rows.filter((r) =>
          [r.coupleName, r.email, r.phone, r.eventCode].some((v) => String(v).toLowerCase().includes(term))
        )
      : rows;

    return filtered.slice(0, limit);
  }

  // ---- Audience ------------------------------------------------------------
  /**
   * Resolve the couples a campaign currently applies to. Timing is evaluated
   * here too: a `before_wedding` campaign only matches couples who have reached
   * that window, so the engine just sends whatever this returns.
   */
  async resolveAudience(campaign: IEmailCampaign): Promise<Recipient[]> {
    const query: Record<string, any> = {};
    if (campaign.audience === 'flash_free_unpaid') {
      query.source = 'flash_free';
      query.isPaid = false;
    } else if (campaign.audience === 'paid') {
      query.isPaid = true;
    } else if (campaign.audience === 'manual') {
      // Hand-picked list IS the audience — no preset, no timing rules applied.
      query._id = { $in: campaign.recipientEventIds || [] };
    }

    const excluded = new Set((campaign.excludeEventIds || []).map(String));
    const now = Date.now();
    const events = await Event.find(query).lean();
    const out: Recipient[] = [];

    for (const event of events) {
      if (excluded.has(String(event._id))) continue;
      const daysToWedding = event.weddingDate
        ? Math.ceil((new Date(event.weddingDate).getTime() - now) / DAY_MS)
        : null;
      const daysSinceSignup = Math.floor((now - new Date(event.createdAt).getTime()) / DAY_MS);

      // --- timing ---
      // A hand-picked list is an explicit instruction, so timing and window
      // filters don't apply — otherwise a chosen couple could be silently dropped.
      const t = campaign.trigger;
      if (campaign.audience === 'manual') {
        // fall through to the recipient push below
      } else if (t.type === 'before_wedding') {
        // Matches once the couple is inside the window, and never after the
        // wedding — couples don't buy once the day has passed.
        if (daysToWedding === null || daysToWedding < 0) continue;
        if (typeof t.days === 'number' && daysToWedding > t.days) continue;
      } else if (t.type === 'after_signup') {
        if (typeof t.days === 'number' && daysSinceSignup < t.days) continue;
      } else if (t.type === 'fixed_date') {
        if (!t.date || new Date(t.date).getTime() > now) continue;
      }

      // --- filters (skipped for hand-picked lists, same reasoning as above) ---
      const f = campaign.filters || ({} as any);
      if (campaign.audience !== 'manual') {
        if (typeof f.minDaysToWedding === 'number' && (daysToWedding ?? -1) < f.minDaysToWedding) continue;
        if (typeof f.maxDaysToWedding === 'number' && (daysToWedding ?? Infinity) > f.maxDaysToWedding) continue;
      }

      const user = await User.findById(event.userId).select('email phoneNumber').lean();
      const email = (user as any)?.email;
      if (f.requireEmail !== false && !email) continue;

      out.push({
        eventId: String(event._id),
        eventCode: event.eventCode,
        customSlug: event.customSlug,
        coupleName: event.name,
        email,
        phone: (user as any)?.phoneNumber || '',
        daysToWedding,
        daysSinceSignup,
      });
    }

    return out;
  }

  /**
   * Replace {{tokens}} with this recipient's values. `link` is supplied on the
   * send path, where the CTA is known; without it {{ctaUrl}} and {{ctaCode}}
   * resolve to empty rather than leaking the raw token text into a message.
   */
  private fill(text: string | undefined, r: Recipient, link?: CtaLink): string {
    if (!text) return '';
    return text
      .replace(/\{\{coupleName\}\}/g, r.coupleName)
      .replace(/\{\{daysToWedding\}\}/g, String(r.daysToWedding ?? ''))
      .replace(/\{\{eventCode\}\}/g, r.eventCode)
      .replace(/\{\{cameraUrl\}\}/g, `${env.FRONTEND_URL}/camera/${publicEventRef(r)}`)
      .replace(/\{\{ctaUrl\}\}/g, link?.url || '')
      .replace(/\{\{ctaCode\}\}/g, link?.code || '');
  }

  private fillBlocks(blocks: ICampaignBlocks, r: Recipient, link?: CtaLink): ICampaignBlocks {
    return {
      title: this.fill(blocks.title, r, link),
      paragraphs: (blocks.paragraphs || []).map((p) => this.fill(p, r, link)),
      bullets: (blocks.bullets || []).map((b) => this.fill(b, r, link)),
      ctaText: this.fill(blocks.ctaText, r, link),
      // The button is the whole point of the mail, so it gets the tracked URL
      // whenever there is one.
      ctaUrl: link?.url || this.fill(blocks.ctaUrl, r),
      footnote: this.fill(blocks.footnote, r, link),
    };
  }

  /**
   * Build the CTA for one recipient on one channel. Falls back to the plain URL
   * whenever tracking can't be honoured — a campaign with tracking on must never
   * ship a broken link because PUBLIC_API_URL is unset or the ids aren't real.
   */
  private ctaFor(
    campaign: IEmailCampaign,
    r: Recipient,
    channel: TrackedChannel
  ): CtaLink {
    const plain = this.fill(campaign.blocks?.ctaUrl, r);
    if (campaign.trackClicks === false) return { url: plain, code: '' };

    const token = signClickToken(String(campaign._id), r.eventId, channel);
    if (!token) return { url: plain, code: '' };
    if (!trackingBase()) {
      logger.warn('PUBLIC_API_URL is not set — campaign links go out untracked');
      return { url: plain, code: '' };
    }
    return { url: clickUrl(token), code: token };
  }

  // ---- Engine --------------------------------------------------------------
  /**
   * Evaluate every active campaign and send to anyone who matches and hasn't
   * already received it. `dryRun` reports the same set without sending or
   * logging, so a preview is always safe to run against live data.
   */
  async run(opts: { dryRun?: boolean; campaignId?: string } = {}): Promise<{
    sent: number;
    results: { campaign: string; campaignId: string; recipients: Recipient[]; skipped: number }[];
  }> {
    const query: Record<string, any> = { isActive: true };
    if (opts.campaignId) query._id = opts.campaignId;
    const campaigns = await EmailCampaign.find(query);

    let sent = 0;
    const results = [];

    for (const campaign of campaigns) {
      const audience = await this.resolveAudience(campaign);

      // Drop anyone already mailed for this campaign.
      const already = await EmailSendLog.find({
        campaignId: campaign._id,
        eventId: { $in: audience.map((a) => a.eventId) },
      }).select('eventId').lean();
      const sentIds = new Set(already.map((a) => String(a.eventId)));
      const pending = audience.filter((a) => !sentIds.has(a.eventId));

      results.push({
        campaign: campaign.name,
        campaignId: String(campaign._id),
        recipients: pending,
        skipped: audience.length - pending.length,
      });

      if (opts.dryRun) continue;

      const { emailService } = await import('@/shared/services/email.service');
      const { whatsappService } = await import('@/shared/services/whatsapp.service');
      const channel = campaign.channel || 'email';

      for (const r of pending) {
        try {
          if (channel === 'email' || channel === 'both') {
            await emailService.sendCampaignEmail({
              to: r.email,
              subject: this.fill(campaign.subject, r),
              blocks: this.fillBlocks(campaign.blocks, r, this.ctaFor(campaign, r, 'email')),
            });
          }

          // Only set once WhatsApp actually went out, so the log doesn't claim a
          // delivery channel it never used — and webhook events aren't matched
          // against a couple we never messaged.
          let wa: { templateName: string; messageId?: string } | undefined;

          if (channel === 'whatsapp' || channel === 'both') {
            const tpl = campaign.whatsapp?.templateName;
            if (!tpl) throw new Error('No WhatsApp template configured on this campaign');
            if (!r.phone) {
              // On 'both' the email already went out; don't fail the whole send
              // just because we lack a number.
              if (channel === 'whatsapp') throw new Error('Recipient has no phone number');
              logger.warn(`No phone for ${r.coupleName}; WhatsApp skipped`);
            } else {
              const cta = this.ctaFor(campaign, r, 'whatsapp');
              const result = await whatsappService.sendTemplate({
                to: r.phone,
                templateName: tpl,
                broadcastName: campaign.name,
                parameters: (campaign.whatsapp?.parameters || []).map((p) => ({
                  name: p.name,
                  value: this.fill(p.value, r, cta),
                })),
              });
              wa = { templateName: tpl, messageId: result.messageId };
            }
          }
          // Log first-class: the unique index is what stops a double send.
          await EmailSendLog.create({
            campaignId: campaign._id,
            eventId: r.eventId,
            email: r.email,
            channel,
            phone: wa ? sanitizePhoneNumber(r.phone) : undefined,
            whatsapp: wa ? { ...wa, status: 'sent' } : undefined,
          });
          await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 } });
          sent++;
        } catch (err) {
          logger.error(`Campaign "${campaign.name}" failed for ${r.email}: ${(err as Error).message}`);
        }
      }
    }

    return { sent, results };
  }

  /**
   * Send one campaign to an arbitrary destination with sample data. `to` is an
   * email address, or a phone number when testing the WhatsApp side.
   */
  async sendTest(campaignId: string, to: string, channel: 'email' | 'whatsapp' = 'email'): Promise<void> {
    const campaign = await EmailCampaign.findById(campaignId);
    if (!campaign) throw new NotFoundError('Campaign');

    const sample: Recipient = {
      // A syntactically valid id that matches no event: the tracked link is
      // built and followable, so the button can be tested end to end, but the
      // click lands on no send log and so never shows up in the numbers.
      eventId: '0'.repeat(24),
      eventCode: 'TESTCODE',
      customSlug: 'dana-yoav-19-nov',
      coupleName: 'דנה & יואב',
      email: to,
      phone: to,
      daysToWedding: campaign.trigger.days ?? 30,
      daysSinceSignup: 3,
    };

    if (channel === 'whatsapp') {
      const tpl = campaign.whatsapp?.templateName;
      if (!tpl) throw new NotFoundError('WhatsApp template on this campaign');
      const { whatsappService } = await import('@/shared/services/whatsapp.service');
      const cta = this.ctaFor(campaign, sample, 'whatsapp');
      await whatsappService.sendTemplate({
        to,
        templateName: tpl,
        broadcastName: `TEST ${campaign.name}`,
        parameters: (campaign.whatsapp?.parameters || []).map((p) => ({
          name: p.name,
          value: this.fill(p.value, sample, cta),
        })),
      });
      return;
    }

    const { emailService } = await import('@/shared/services/email.service');
    await emailService.sendCampaignEmail({
      to,
      subject: `[בדיקה] ${this.fill(campaign.subject, sample)}`,
      blocks: this.fillBlocks(campaign.blocks, sample, this.ctaFor(campaign, sample, 'email')),
    });
  }

  // ---- Tracking ------------------------------------------------------------
  /**
   * Where a click token should land. Rebuilt from the campaign and the event
   * rather than baked into the link, so editing a campaign's CTA also fixes
   * every link already sitting in someone's WhatsApp.
   */
  async destinationFor(campaignId: string, eventId: string, channel: TrackedChannel): Promise<string> {
    try {
      const campaign = await EmailCampaign.findById(campaignId).select('blocks').lean();
      const raw = campaign?.blocks?.ctaUrl;
      if (!raw) return env.FRONTEND_URL;

      const event = await Event.findById(eventId).select('eventCode customSlug name weddingDate').lean();
      const sample: Recipient = {
        eventId,
        eventCode: event?.eventCode || '',
        customSlug: event?.customSlug,
        coupleName: event?.name || '',
        email: '',
        phone: '',
        daysToWedding: event?.weddingDate
          ? Math.ceil((new Date(event.weddingDate).getTime() - Date.now()) / DAY_MS)
          : null,
        daysSinceSignup: 0,
      };

      return withSource(this.fill(raw, sample), channel, campaignId) || env.FRONTEND_URL;
    } catch (err) {
      logger.error(`Click destination lookup failed for campaign ${campaignId}: ${(err as Error).message}`);
      return env.FRONTEND_URL;
    }
  }

  /**
   * Count a click. No upsert: a token whose send log is gone (campaign deleted,
   * test link) is a redirect we still honour but must not invent a row for.
   */
  async recordClick(campaignId: string, eventId: string): Promise<void> {
    const now = new Date();
    await EmailSendLog.updateOne(
      { campaignId, eventId },
      // $min on a missing field sets it, so firstClickAt survives out-of-order
      // writes without a read first.
      { $inc: { clicks: 1 }, $min: { firstClickAt: now }, $max: { lastClickAt: now } }
    );
  }

  /** Delivery and engagement for one campaign, counted from its send logs. */
  async stats(campaignId: string) {
    const logs = await EmailSendLog.find({ campaignId })
      .select('channel whatsapp clicks')
      .lean();

    const whatsapp = { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 };
    let emails = 0;
    let clicks = 0;
    let clickedRecipients = 0;

    for (const log of logs) {
      const ch = log.channel || 'email';
      if (ch === 'email' || ch === 'both') emails++;
      if (log.whatsapp?.templateName) {
        whatsapp.sent++;
        // Statuses are cumulative — something that was read was also delivered,
        // even if we never saw the delivered callback.
        if (log.whatsapp.failedAt) whatsapp.failed++;
        if (log.whatsapp.deliveredAt || log.whatsapp.readAt || log.whatsapp.repliedAt) whatsapp.delivered++;
        if (log.whatsapp.readAt || log.whatsapp.repliedAt) whatsapp.read++;
        if (log.whatsapp.repliedAt) whatsapp.replied++;
      }
      if (log.clicks) {
        clicks += log.clicks;
        clickedRecipients++;
      }
    }

    return {
      recipients: logs.length,
      emails,
      whatsapp,
      clicks: { total: clicks, recipients: clickedRecipients },
    };
  }

  /** Timer. Idempotency lives in EmailSendLog, so restarts are harmless. */
  startScheduler(): void {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const tick = () => {
      this.run()
        .then((r) => { if (r.sent) logger.info(`Email campaigns: ${r.sent} sent`); })
        .catch((err) => logger.error(`Campaign run crashed: ${(err as Error).message}`));
    };
    setTimeout(tick, 60_000);
    setInterval(tick, SIX_HOURS);
    logger.info('Email campaign scheduler started (every 6h)');
  }
}

export const emailCampaignService = new EmailCampaignService();
