import { EmailSendLog, IEmailSendLog, WhatsAppDeliveryStatus } from '../emailCampaign/emailCampaign.model';
import { WhatsAppEvent } from './whatsappEvent.model';
import { sanitizePhoneNumber } from '@/shared/utils/helpers';
import logger from '@/shared/utils/logger';

/**
 * Wati delivery callbacks.
 *
 * Wati posts one JSON object per event and has never committed to a schema:
 * field names differ between v1 and v2 tenants, `eventType` spellings change,
 * and a payload we don't recognise still means something happened. So parsing
 * is deliberately forgiving — pull what we can from a list of candidate keys,
 * store the event either way, and never reject. A 4xx from us makes Wati retry
 * and eventually disable the webhook, which costs more than a row we can't read.
 */

const MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Ordered so a late-arriving 'delivered' can't undo a 'read' we already have.
// Callbacks arrive out of order often enough that this matters.
const STATUS_RANK: Record<WhatsAppDeliveryStatus, number> = {
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 4,
  replied: 5,
};

const STAMP: Partial<Record<WhatsAppDeliveryStatus, string>> = {
  delivered: 'deliveredAt',
  read: 'readAt',
  replied: 'repliedAt',
  failed: 'failedAt',
};

interface ParsedEvent {
  phone: string;
  eventType: string;
  status: WhatsAppDeliveryStatus | null;
  messageId?: string;
  text?: string;
  occurredAt: Date;
}

const pick = (body: any, keys: string[]): any => {
  for (const key of keys) {
    const value = key.split('.').reduce((acc: any, part) => (acc == null ? acc : acc[part]), body);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const clip = (value: unknown, max: number): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).slice(0, max);
};

/** Wati sends unix seconds, unix millis or an ISO string depending on the event. */
const parseTime = (value: unknown): Date => {
  if (typeof value === 'number' || /^\d+$/.test(String(value || ''))) {
    const n = Number(value);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }
  const parsed = new Date(String(value || ''));
  return isNaN(parsed.getTime()) ? new Date() : parsed;
};

/**
 * Map Wati's label onto our five states. Checked most specific first:
 * "sentMessageDELIVERED" contains both "sent" and "deliver", and it means
 * delivered.
 */
const toStatus = (label: string, incoming: boolean): WhatsAppDeliveryStatus | null => {
  const t = label.toLowerCase();
  if (/fail|error|undeliver|reject|invalid/.test(t)) return 'failed';
  if (t.includes('replied')) return 'replied';
  if (t.includes('read')) return 'read';
  if (t.includes('deliver')) return 'delivered';
  if (t.includes('sent')) return 'sent';
  // An inbound message on a thread we started is a reply, whatever Wati calls it.
  if (incoming) return 'replied';
  return null;
};

/** Exported for tests: the mapping is the part of this file most likely to rot. */
export const parseWatiEvent = (body: any): ParsedEvent | null => {
  if (!body || typeof body !== 'object') return null;

  const phone = sanitizePhoneNumber(
    String(
      pick(body, [
        'waId',
        'whatsappNumber',
        'phone_number',
        'phoneNumber',
        'contact.wa_id',
        'data.waId',
        'senderPhone',
        'phone',
        'to',
      ]) || ''
    )
  );

  const eventType = String(pick(body, ['eventType', 'type', 'event']) || '');
  const statusString = String(pick(body, ['statusString', 'status', 'messageStatus']) || '');
  // `owner` is Wati's outgoing flag: false means the contact sent it.
  const owner = pick(body, ['owner', 'data.owner']);
  const incoming = owner === false && /message|received/i.test(eventType);

  return {
    phone,
    eventType: eventType || statusString || 'unknown',
    status: toStatus(`${eventType} ${statusString}`, incoming),
    messageId: clip(pick(body, ['whatsappMessageId', 'messageId', 'id', 'data.whatsappMessageId']), 120),
    text: clip(
      pick(body, ['text', 'eventDescription', 'failureReason', 'errorMessage', 'data.text']),
      500
    ),
    occurredAt: parseTime(pick(body, ['timestamp', 'created', 'eventTime', 'createdAt'])),
  };
};

/**
 * Israeli numbers reach us in several shapes (+972…, 0…, bare core) depending on
 * who typed them in, and Wati reports the international form. Match on every
 * variant of the same 9-digit core rather than trusting one of them.
 */
const phoneVariants = (digits: string): string[] => {
  const core = digits.slice(-9);
  return Array.from(new Set([digits, `972${core}`, `0${core}`, core].filter(Boolean)));
};

const findSendLog = async (ev: ParsedEvent): Promise<IEmailSendLog | null> => {
  if (ev.messageId) {
    const byId = await EmailSendLog.findOne({ 'whatsapp.messageId': ev.messageId });
    if (byId) return byId;
  }
  if (!ev.phone) return null;
  // Newest first: a couple can be on more than one campaign, and the event
  // belongs to whatever we sent them last.
  return EmailSendLog.findOne({
    phone: { $in: phoneVariants(ev.phone) },
    'whatsapp.templateName': { $exists: true },
    sentAt: { $gte: new Date(Date.now() - MATCH_WINDOW_MS) },
  }).sort({ sentAt: -1 });
};

const applyToSendLog = async (ev: ParsedEvent): Promise<IEmailSendLog | null> => {
  if (!ev.status) return null;
  const log = await findSendLog(ev);
  if (!log) return null;

  const set: Record<string, unknown> = {};
  const stamp = STAMP[ev.status];
  if (stamp && !(log.whatsapp as any)?.[stamp]) set[`whatsapp.${stamp}`] = ev.occurredAt;

  const current = log.whatsapp?.status;
  if (!current || STATUS_RANK[ev.status] > STATUS_RANK[current]) set['whatsapp.status'] = ev.status;
  if (ev.status === 'failed' && ev.text) set['whatsapp.error'] = ev.text;
  if (ev.messageId && !log.whatsapp?.messageId) set['whatsapp.messageId'] = ev.messageId;

  if (Object.keys(set).length) await EmailSendLog.updateOne({ _id: log._id }, { $set: set });
  return log;
};

/** One event: stamp the campaign send log if it belongs to one, keep it either way. */
const handleOne = async (body: any): Promise<void> => {
  const ev = parseWatiEvent(body);
  if (!ev) return;

  const log = await applyToSendLog(ev);

  await WhatsAppEvent.create({
    phone: ev.phone,
    eventType: ev.eventType,
    status: ev.status || undefined,
    messageId: ev.messageId,
    // Only inbound text is worth keeping; on a failure this is the reason.
    text: ev.status === 'replied' || ev.status === 'failed' ? ev.text : undefined,
    campaignId: log?.campaignId,
    eventId: log?.eventId,
    matched: Boolean(log),
    occurredAt: ev.occurredAt,
  });

  const line = `[wati] ${ev.eventType} ${ev.phone || '?'} → ${ev.status || 'ignored'}${log ? ' (campaign)' : ''}`;
  if (ev.status === 'failed') logger.warn(`${line}${ev.text ? `: ${ev.text}` : ''}`);
  else logger.info(line);
};

/** Wati posts a single object; a few tenants batch. Accept both. */
export const handleWatiWebhook = async (body: unknown): Promise<number> => {
  const events = Array.isArray(body) ? body : [body];
  let handled = 0;
  for (const event of events) {
    try {
      await handleOne(event);
      handled++;
    } catch (err) {
      logger.error(`Wati webhook event failed: ${(err as Error).message}`);
    }
  }
  return handled;
};

/** Recent traffic, newest first — the raw feed behind the admin screen. */
export const listWhatsAppEvents = async (opts: {
  phone?: string;
  status?: string;
  campaignId?: string;
  limit?: number;
}) => {
  const query: Record<string, unknown> = {};
  if (opts.phone) {
    const digits = sanitizePhoneNumber(opts.phone);
    if (digits) query.phone = { $in: phoneVariants(digits) };
  }
  if (opts.status) query.status = opts.status;
  if (opts.campaignId) query.campaignId = opts.campaignId;

  return WhatsAppEvent.find(query)
    .sort({ receivedAt: -1 })
    .limit(Math.min(Math.max(Number(opts.limit) || 100, 1), 500))
    .lean();
};
