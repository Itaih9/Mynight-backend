import { customAlphabet } from 'nanoid';
import { TrackedLink, ITrackedLink } from './trackedLink.model';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import { endsInDigit } from '@/shared/utils/helpers';
import logger from '@/shared/utils/logger';

// Unambiguous characters only, and never ending in a digit — a printed code
// gets read aloud and typed by hand, and these links get pasted into
// spreadsheets where Excel renumbers a trailing number.
const BODY = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 5);
const TAIL = customAlphabet('abcdefghjkmnpqrstuvwxyz', 1);

const today = () => new Date().toISOString().slice(0, 10);

class TrackedLinkService {
  /**
   * Where a tracked link is allowed to point.
   *
   * Our own site only. A redirect that will send a visitor anywhere the caller
   * names is an open redirect: it lends our domain's reputation to a phishing
   * destination, and a link that reads mynight.co.il is exactly what makes that
   * worth doing. Every legitimate use of this is our own marketing.
   */
  private assertOwnDomain(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ValidationError('Target must be a full URL, e.g. https://mynight.co.il/');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ValidationError('Target must be an http(s) URL');
    }
    const allowed = new URL(env.FRONTEND_URL).hostname.replace(/^www\./, '');
    const host = url.hostname.replace(/^www\./, '');
    if (host !== allowed && !host.endsWith(`.${allowed}`)) {
      throw new ValidationError(`Target must be on ${allowed} — this redirect is not open to other sites`);
    }
    return url;
  }

  private async uniqueCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = `${BODY()}${TAIL()}`;
      if (!(await TrackedLink.findOne({ code }))) return code;
    }
    throw new Error('Could not allocate a tracked-link code');
  }

  async create(data: { targetUrl: string; label: string; code?: string }): Promise<ITrackedLink> {
    const url = this.assertOwnDomain(String(data.targetUrl || ''));
    const label = String(data.label || '').trim();
    if (!label) throw new ValidationError('Give the QR a label so you know what it is later');

    let code: string;
    if (data.code) {
      code = String(data.code).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (code.length < 3) throw new ValidationError('Code must be at least 3 characters');
      if (endsInDigit(code)) {
        throw new ValidationError('Code must not end in a number — Excel renumbers those when you drag a column of links');
      }
      if (await TrackedLink.findOne({ code })) throw new ValidationError('That code is already taken');
    } else {
      code = await this.uniqueCode();
    }

    const link = await TrackedLink.create({ code, targetUrl: url.toString(), label });
    logger.warn(`Tracked link created: /q/${code} -> ${url.toString()} (${label})`);
    return link;
  }

  /** The scan itself: count it, then hand back where to send the visitor. */
  async recordScan(code: string): Promise<string | null> {
    const link = await TrackedLink.findOne({ code: String(code || '').toLowerCase() });
    if (!link || !link.isActive) return null;

    const day = today();
    const bucket = link.daily.find((d) => d.day === day);
    if (bucket) bucket.count += 1;
    else link.daily.push({ day, count: 1 });

    link.scans += 1;
    link.lastScanAt = new Date();
    await link.save();

    return link.targetUrl;
  }

  async list(): Promise<any[]> {
    const links = await TrackedLink.find().sort({ createdAt: -1 }).lean();
    return links.map((l) => ({
      ...l,
      url: `${env.FRONTEND_URL}/api/q/${l.code}`,
      // Last 14 days, oldest first — enough to see a fair or a mailshot land.
      recent: [...(l.daily || [])].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    }));
  }

  async get(code: string): Promise<ITrackedLink> {
    const link = await TrackedLink.findOne({ code: String(code || '').toLowerCase() });
    if (!link) throw new NotFoundError('Tracked link');
    return link;
  }

  /** The URL a QR for this link should encode. */
  scanUrl(code: string): string {
    return `${env.FRONTEND_URL}/api/q/${code}`;
  }
}

export const trackedLinkService = new TrackedLinkService();
