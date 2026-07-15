/**
 * Minimal iCalendar + Google Calendar helpers.
 *
 * Only all-day events are supported, which is all the reminders need — a
 * reminder shouldn't claim a time slot, and an all-day entry sidesteps timezone
 * ambiguity entirely (no VTIMEZONE, no UTC offset guessing for the couple).
 */

export interface CalendarEvent {
  /** Stable per-event id; clients update rather than duplicate on re-add. */
  uid: string;
  title: string;
  description: string;
  /** The day the entry lands on. */
  date: Date;
  url?: string;
}

/** YYYYMMDD in local terms — an all-day entry has no timezone. */
function toDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function toUtcStamp(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** RFC 5545: backslash, semicolon and comma are literals; newlines are \n. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * One .ics containing every reminder, so a single click adds them all.
 * DTEND is exclusive for all-day events, hence date + 1.
 */
export function buildIcs(events: CalendarEvent[]): string {
  const now = toUtcStamp(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyNight//Event Reminders//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${toDateStamp(e.date)}`,
      `DTEND;VALUE=DATE:${toDateStamp(addDays(e.date, 1))}`,
      `SUMMARY:${escapeText(e.title)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      ...(e.url ? [`URL:${e.url}`] : []),
      'BEGIN:VALARM',
      'TRIGGER:PT9H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(e.title)}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 requires CRLF line endings.
  return lines.join('\r\n');
}

/** One-tap add for Google Calendar users (no attachment involved). */
export function googleCalendarUrl(e: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${toDateStamp(e.date)}/${toDateStamp(addDays(e.date, 1))}`,
    details: e.url ? `${e.description}\n\n${e.url}` : e.description,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
