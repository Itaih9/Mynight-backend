import crypto from 'crypto';
import { env } from '@/shared/config/env';

/**
 * Signed click tokens for campaign CTAs.
 *
 * A WhatsApp template can tell us it was delivered and read, but never that a
 * link was clicked — Meta doesn't report it and Wati has nothing to pass on. So
 * the CTA points at us instead: /t/<token> records the hit and 302s on.
 *
 * The token is self-contained rather than a database row: nothing to write at
 * send time, nothing to clean up, and a link stays valid for as long as the
 * campaign does. It carries the campaign id, the event id and which channel the
 * link went out on, signed with an HMAC so a stranger can't mint hits for a
 * campaign or enumerate our couples by walking ids.
 *
 * Layout: 12-byte campaign ObjectId + 12-byte event ObjectId + 1 channel byte,
 * then 6 bytes of HMAC — 31 bytes, 42 base64url characters. Short matters: on a
 * Wati URL-button the token is the dynamic suffix, and it also has to survive
 * being read aloud in a WhatsApp bubble without looking like a phishing link.
 */

export type TrackedChannel = 'email' | 'whatsapp';

const CHANNEL_CODE: Record<TrackedChannel, number> = { email: 1, whatsapp: 2 };
const CODE_CHANNEL: Record<number, TrackedChannel> = { 1: 'email', 2: 'whatsapp' };

const PAYLOAD_BYTES = 25;
const SIG_BYTES = 6;

const isObjectId = (value: string): boolean => /^[0-9a-fA-F]{24}$/.test(value);

// Reuses JWT_SECRET rather than adding another required env var: same trust
// domain, and a click token is worth strictly less than a session token.
const sign = (payload: Buffer): Buffer =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(payload).digest().subarray(0, SIG_BYTES);

export const signClickToken = (
  campaignId: string,
  eventId: string,
  channel: TrackedChannel
): string | null => {
  // Test sends carry a placeholder event id, so they simply go out untracked.
  if (!isObjectId(campaignId) || !isObjectId(eventId)) return null;
  const payload = Buffer.concat([
    Buffer.from(campaignId, 'hex'),
    Buffer.from(eventId, 'hex'),
    Buffer.from([CHANNEL_CODE[channel]]),
  ]);
  return Buffer.concat([payload, sign(payload)]).toString('base64url');
};

export const verifyClickToken = (
  token: string
): { campaignId: string; eventId: string; channel: TrackedChannel } | null => {
  try {
    const buf = Buffer.from(String(token || ''), 'base64url');
    if (buf.length !== PAYLOAD_BYTES + SIG_BYTES) return null;
    const payload = buf.subarray(0, PAYLOAD_BYTES);
    const expected = sign(payload);
    if (!crypto.timingSafeEqual(buf.subarray(PAYLOAD_BYTES), expected)) return null;
    const channel = CODE_CHANNEL[payload[PAYLOAD_BYTES - 1]];
    if (!channel) return null;
    return {
      campaignId: payload.subarray(0, 12).toString('hex'),
      eventId: payload.subarray(12, 24).toString('hex'),
      channel,
    };
  } catch {
    return null;
  }
};

/** Where our own redirect lives. Empty when PUBLIC_API_URL isn't configured. */
export const trackingBase = (): string => (env.PUBLIC_API_URL || '').replace(/\/+$/, '');

export const clickUrl = (token: string): string => `${trackingBase()}/t/${token}`;

/**
 * Tag the destination so the click is also visible to whatever analytics the
 * site runs — our counter knows the click happened, but only the page knows
 * what the visitor did next.
 */
export const withSource = (url: string, channel: TrackedChannel, campaignId: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const source = channel === 'whatsapp' ? 'whatsapp' : 'email';
    if (!parsed.searchParams.has('src')) parsed.searchParams.set('src', channel === 'whatsapp' ? 'wa' : 'email');
    if (!parsed.searchParams.has('utm_source')) parsed.searchParams.set('utm_source', source);
    if (!parsed.searchParams.has('utm_medium')) parsed.searchParams.set('utm_medium', 'campaign');
    if (!parsed.searchParams.has('utm_campaign')) parsed.searchParams.set('utm_campaign', campaignId);
    return parsed.toString();
  } catch {
    return '';
  }
};

/**
 * Link previews are not people. WhatsApp fetches a URL to render the preview
 * card the moment the message lands, and Facebook's crawler does the same — a
 * counter that believed them would report a click for every message delivered.
 * Anchored on `WhatsApp/` so the in-app browser, which sends an ordinary mobile
 * UA, still counts.
 */
const PREVIEW_UA = /^WhatsApp\/|facebookexternalhit|bot\b|crawler|spider|preview|curl\/|wget|python-requests|axios\/|headless|monitoring|pingdom|uptime/i;

export const isPreviewFetch = (userAgent: string | undefined): boolean =>
  !userAgent || PREVIEW_UA.test(userAgent);
