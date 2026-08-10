import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';
import { handleWatiWebhook, listWhatsAppEvents } from './watiWebhook.service';

/**
 * Wati doesn't sign its webhooks — there is no HMAC to verify, no shared
 * timestamp, nothing. The only available proof that a call came from Wati is a
 * secret we chose and put in the URL we gave them, so that's what we check.
 */
const secretMatches = (provided: string): boolean => {
  const expected = env.WATI_WEBHOOK_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const authorized = (req: Request): boolean => {
  if (!env.WATI_WEBHOOK_SECRET) return true;
  const header = req.headers.authorization || '';
  const provided = String(
    req.query.token ||
      req.headers['x-wati-token'] ||
      req.headers['x-webhook-secret'] ||
      (header.startsWith('Bearer ') ? header.slice(7) : '')
  );
  return secretMatches(provided);
};

export class WhatsAppController {
  /**
   * Delivery, read and reply callbacks from Wati.
   *
   * Always answers 200 once past the secret: Wati retries on any error and
   * disables a webhook that keeps failing, so a payload we can't parse must
   * still be acknowledged — it's logged, not rejected.
   */
  async webhook(req: Request, res: Response): Promise<void> {
    if (!authorized(req)) {
      logger.warn('Rejected a Wati webhook call with a bad or missing token');
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    try {
      const handled = await handleWatiWebhook(req.body);
      res.json({ success: true, handled });
    } catch (err) {
      logger.error(`Wati webhook failed: ${(err as Error).message}`);
      res.json({ success: true, handled: 0 });
    }
  }

  /** Wati (and whoever set it up) pings the URL to check it's alive. */
  async webhookHealth(_req: Request, res: Response): Promise<void> {
    res.json({ success: true, configured: Boolean(env.WATI_WEBHOOK_SECRET) });
  }

  /** Admin: raw event feed, including messages that belong to no campaign. */
  async events(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rows = await listWhatsAppEvents({
        phone: req.query.phone as string | undefined,
        status: req.query.status as string | undefined,
        campaignId: req.query.campaignId as string | undefined,
        limit: Number(req.query.limit) || 100,
      });
      res.json({ success: true, data: rows });
    } catch (error) {
      next(error);
    }
  }
}

export const whatsappController = new WhatsAppController();
