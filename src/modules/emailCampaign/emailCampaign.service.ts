import { EmailCampaign, EmailSendLog, IEmailCampaign, ICampaignBlocks } from './emailCampaign.model';
import { Event } from '../events/events.model';
import { User } from '../auth/user.model';
import { env } from '@/shared/config/env';
import { NotFoundError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recipient resolved from an audience query, ready to mail. */
interface Recipient {
  eventId: string;
  eventCode: string;
  coupleName: string;
  email: string;
  daysToWedding: number | null;
  daysSinceSignup: number;
}

/**
 * The default sequence, seeded once on first boot. Mirrors the previous
 * hardcoded 60/30/7 stages exactly so behaviour is unchanged on migration —
 * everything here is editable in the admin afterwards.
 */
const DEFAULT_CAMPAIGNS: Partial<IEmailCampaign>[] = [60, 30, 7].map((days) => ({
  name: `Here I Am — ${days} ימים לפני החתונה`,
  audience: 'flash_free_unpaid' as const,
  filters: { requireEmail: true },
  trigger: { type: 'before_wedding' as const, days },
  subject:
    days <= 7
      ? 'עוד {{daysToWedding}} ימים — רוצים שכל אורח יקבל את התמונות שלו?'
      : '{{coupleName}}, שדרוג אחד לפני החתונה',
  blocks: {
    title: 'עוד {{daysToWedding}} ימים לחתונה שלכם',
    paragraphs: [
      'פלאש כבר מוכן — האורחים שלכם יצלמו, ואתם תקבלו את כל התמונות בבוקר שאחרי.',
      'זה בדיוק מה ש-<strong>Here I Am</strong> מוסיף. אפשר לשדרג עד ליום החתונה.',
    ],
    bullets: [
      'כל אורח מקבל אלבום אישי — רק עם התמונות שהוא בהן',
      'גם התמונות מהצלם המקצועי נכנסות לזיהוי הפנים',
      'סטורי מוכן כבר ביום שאחרי החתונה',
    ],
    ctaText: 'שדרוג ל-Here I Am',
    ctaUrl: `${env.FRONTEND_URL}/here-i-am`,
    footnote: 'לא מעוניינים? אפשר להתעלם — פלאש נשאר שלכם בחינם.',
  },
  isActive: true,
}));

class EmailCampaignService {
  async seedDefaults(): Promise<void> {
    if ((await EmailCampaign.countDocuments()) > 0) return;
    await EmailCampaign.insertMany(DEFAULT_CAMPAIGNS);
    logger.info(`Seeded ${DEFAULT_CAMPAIGNS.length} default email campaigns`);
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
    }

    const now = Date.now();
    const events = await Event.find(query).lean();
    const out: Recipient[] = [];

    for (const event of events) {
      const daysToWedding = event.weddingDate
        ? Math.ceil((new Date(event.weddingDate).getTime() - now) / DAY_MS)
        : null;
      const daysSinceSignup = Math.floor((now - new Date(event.createdAt).getTime()) / DAY_MS);

      // --- timing ---
      const t = campaign.trigger;
      if (t.type === 'before_wedding') {
        // Matches once the couple is inside the window, and never after the
        // wedding — couples don't buy once the day has passed.
        if (daysToWedding === null || daysToWedding < 0) continue;
        if (typeof t.days === 'number' && daysToWedding > t.days) continue;
      } else if (t.type === 'after_signup') {
        if (typeof t.days === 'number' && daysSinceSignup < t.days) continue;
      } else if (t.type === 'fixed_date') {
        if (!t.date || new Date(t.date).getTime() > now) continue;
      }

      // --- filters ---
      const f = campaign.filters || ({} as any);
      if (typeof f.minDaysToWedding === 'number' && (daysToWedding ?? -1) < f.minDaysToWedding) continue;
      if (typeof f.maxDaysToWedding === 'number' && (daysToWedding ?? Infinity) > f.maxDaysToWedding) continue;

      const user = await User.findById(event.userId).select('email').lean();
      const email = (user as any)?.email;
      if (f.requireEmail !== false && !email) continue;

      out.push({
        eventId: String(event._id),
        eventCode: event.eventCode,
        coupleName: event.name,
        email,
        daysToWedding,
        daysSinceSignup,
      });
    }

    return out;
  }

  /** Replace {{tokens}} with this recipient's values. */
  private fill(text: string | undefined, r: Recipient): string {
    if (!text) return '';
    return text
      .replace(/\{\{coupleName\}\}/g, r.coupleName)
      .replace(/\{\{daysToWedding\}\}/g, String(r.daysToWedding ?? ''))
      .replace(/\{\{eventCode\}\}/g, r.eventCode)
      .replace(/\{\{cameraUrl\}\}/g, `${env.FRONTEND_URL}/camera/${r.eventCode}`);
  }

  private fillBlocks(blocks: ICampaignBlocks, r: Recipient): ICampaignBlocks {
    return {
      title: this.fill(blocks.title, r),
      paragraphs: (blocks.paragraphs || []).map((p) => this.fill(p, r)),
      bullets: (blocks.bullets || []).map((b) => this.fill(b, r)),
      ctaText: this.fill(blocks.ctaText, r),
      ctaUrl: this.fill(blocks.ctaUrl, r),
      footnote: this.fill(blocks.footnote, r),
    };
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
      for (const r of pending) {
        try {
          await emailService.sendCampaignEmail({
            to: r.email,
            subject: this.fill(campaign.subject, r),
            blocks: this.fillBlocks(campaign.blocks, r),
          });
          // Log first-class: the unique index is what stops a double send.
          await EmailSendLog.create({
            campaignId: campaign._id,
            eventId: r.eventId,
            email: r.email,
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

  /** Send one campaign to an arbitrary address with sample data. */
  async sendTest(campaignId: string, to: string): Promise<void> {
    const campaign = await EmailCampaign.findById(campaignId);
    if (!campaign) throw new NotFoundError('Campaign');

    const sample: Recipient = {
      eventId: 'test',
      eventCode: 'TESTCODE',
      coupleName: 'דנה & יואב',
      email: to,
      daysToWedding: campaign.trigger.days ?? 30,
      daysSinceSignup: 3,
    };

    const { emailService } = await import('@/shared/services/email.service');
    await emailService.sendCampaignEmail({
      to,
      subject: `[בדיקה] ${this.fill(campaign.subject, sample)}`,
      blocks: this.fillBlocks(campaign.blocks, sample),
    });
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
