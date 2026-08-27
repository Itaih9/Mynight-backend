import { parseWatiEvent } from './watiWebhook.service';

/**
 * Wati's callback vocabulary is the part of the WhatsApp integration most
 * likely to rot: field names differ between tenants, spellings change without
 * notice, and nothing is signed or versioned. These cases are the payload
 * shapes Wati actually sends, pinned so a future edit to the mapping has to
 * declare what it is changing.
 */

/** The shape Wati posts when a contact writes to us. */
const inbound = (over: Record<string, unknown> = {}) => ({
  id: 'f2b1c0de-1111-2222-3333-444455556666',
  whatsappMessageId: 'wamid.HBgLOTcyNTAxMjM0NTY3',
  text: 'כן, מעוניינים!',
  timestamp: '1755686400',
  // Wati's outgoing flag. false = the contact sent it.
  owner: false,
  eventType: 'message',
  // Wati stamps the messages a CONTACT sends us "SENT" — this is the trap.
  statusString: 'SENT',
  waId: '972501234567',
  ...over,
});

/** The shape Wati posts about a message we sent. */
const outbound = (over: Record<string, unknown> = {}) => ({
  whatsappMessageId: 'wamid.AAA',
  owner: true,
  waId: '972501234567',
  ...over,
});

describe('parseWatiEvent — inbound replies', () => {
  /**
   * The one that matters commercially: a couple answering an upsell broadcast.
   * Read literally, Wati's "SENT" made every reply look like our own outgoing
   * message — repliedAt was never stamped and the answer text was discarded,
   * so the campaign reported silence however many said yes.
   */
  it('reads a contact message as a reply even though Wati labels it SENT', () => {
    const ev = parseWatiEvent(inbound());
    expect(ev?.status).toBe('replied');
    expect(ev?.text).toBe('כן, מעוניינים!');
    expect(ev?.phone).toBe('972501234567');
  });

  it('still reads it as a reply when owner arrives as the string "false"', () => {
    expect(parseWatiEvent(inbound({ owner: 'false' }))?.status).toBe('replied');
  });

  it('treats a message we sent as outgoing, not as a reply', () => {
    const ev = parseWatiEvent(inbound({ owner: true }));
    expect(ev?.status).toBe('sent');
  });
});

describe('parseWatiEvent — delivery states', () => {
  it('reads "sentMessageDELIVERED" as delivered, not sent', () => {
    const ev = parseWatiEvent(outbound({ eventType: 'sentMessageDELIVERED', statusString: 'DELIVERED' }));
    expect(ev?.status).toBe('delivered');
  });

  it('reads a read receipt as read', () => {
    expect(parseWatiEvent(outbound({ eventType: 'sentMessageREAD' }))?.status).toBe('read');
  });

  it.each(['threadUpdate', 'markedUnread'])(
    'does not mistake "%s" for a read receipt',
    (eventType) => {
      // Both spellings contain "read"; neither means the couple opened anything,
      // and a false read would overstate engagement on the campaign report.
      expect(parseWatiEvent(outbound({ eventType }))?.status).not.toBe('read');
    }
  );

  it('ignores an event it cannot place rather than inventing a status', () => {
    expect(parseWatiEvent(outbound({ eventType: 'threadUpdate' }))?.status).toBeNull();
  });
});

describe('parseWatiEvent — failures', () => {
  /**
   * whatsapp.error is what someone reads when they come to ask why a send
   * failed. Wati puts the reason in failureReason and leaves `text` holding the
   * body of the message we sent, so reading text first stored our own copy
   * where the diagnosis belonged.
   */
  it('keeps the failure reason, not the message body we sent', () => {
    const ev = parseWatiEvent(
      outbound({
        eventType: 'sentMessageFAILED',
        statusString: 'FAILED',
        text: 'שלום דנה, נשארו 7 ימים לחתונה...',
        failureReason: 'More than 24 hours have passed since the customer last replied.',
      })
    );
    expect(ev?.status).toBe('failed');
    expect(ev?.text).toBe('More than 24 hours have passed since the customer last replied.');
  });

  it.each(['sentMessageFAILED', 'messageUndelivered', 'INVALID_NUMBER'])(
    'reads "%s" as a failure',
    (eventType) => {
      expect(parseWatiEvent(outbound({ eventType }))?.status).toBe('failed');
    }
  );
});

describe('parseWatiEvent — message id', () => {
  it('prefers the WhatsApp message id over Wati\'s own record id', () => {
    const ev = parseWatiEvent(outbound({ eventType: 'sentMessageDELIVERED', id: 'wati-internal-42' }));
    expect(ev?.messageId).toBe('wamid.AAA');
  });

  it('prefers a nested WhatsApp id over a bare id', () => {
    // A bare `id` written onto the send log would poison the join key that
    // every later event for that message matches on.
    const ev = parseWatiEvent({
      eventType: 'sentMessageDELIVERED',
      id: 'wati-internal-42',
      data: { whatsappMessageId: 'wamid.NESTED' },
      waId: '972501234567',
    });
    expect(ev?.messageId).toBe('wamid.NESTED');
  });
});

describe('parseWatiEvent — timestamps and junk', () => {
  const expected = Date.UTC(2025, 7, 20, 8, 0, 0);

  it.each([
    ['unix seconds', '1755676800'],
    ['unix millis', 1755676800000],
    ['an ISO string', '2025-08-20T08:00:00.000Z'],
  ])('accepts %s', (_label, timestamp) => {
    expect(parseWatiEvent(inbound({ timestamp }))?.occurredAt.getTime()).toBe(expected);
  });

  it('falls back to now rather than an invalid date', () => {
    const at = parseWatiEvent(inbound({ timestamp: 'not-a-date' }))?.occurredAt;
    expect(at?.getTime()).not.toBeNaN();
  });

  it.each([null, undefined, 'a string', 42])('returns null for %p', (body) => {
    expect(parseWatiEvent(body)).toBeNull();
  });

  it('normalises a number written any of the ways Wati reports it', () => {
    expect(parseWatiEvent(inbound({ waId: '+972-50-123-4567' }))?.phone).toBe('972501234567');
  });
});
