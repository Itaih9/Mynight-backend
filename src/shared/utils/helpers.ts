import { transliterateHebrewName } from './hebrewTranslit';
import { customAlphabet } from 'nanoid';

export const generateEventCode = (): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const generate = customAlphabet(alphabet, 8);
  return generate();
};

export const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const generateReferralCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const generate = customAlphabet(alphabet, 6);
  return generate();
};

export const sanitizePhoneNumber = (phone: string): string => {
  return phone.replace(/\D/g, '');
};

/**
 * Normalize an Israeli phone number to canonical E.164 (+972 + 9-digit core).
 *
 * The old version merely prepended '+' to the stripped digits, so a locally
 * typed 0500000009 became "+0500000009" instead of "+972500000009" — logins
 * still matched (both paths used this same function) but the number was never
 * routable, which broke WhatsApp/Wati delivery. This reduces any input variant
 * (0-prefixed, +972, +9720, 00972, bare core) to the same +972<core> form —
 * the primary variant israeliPhoneCandidates() already looks up.
 */
export const formatPhoneNumber = (phone: string): string => {
  let digits = sanitizePhoneNumber(phone); // digits only — strips '+' and separators
  if (digits.startsWith('00')) digits = digits.slice(2); // 00<cc> international prefix
  if (digits.startsWith('972')) digits = digits.slice(3); // drop country code
  digits = digits.replace(/^0+/, ''); // drop local trunk 0(s)
  return digits ? `+972${digits}` : '';
};

/**
 * All plausible stored formats of an Israeli phone number, derived from any
 * input. Stored numbers are `+` + digits (see formatPhoneNumber), and the digits
 * vary by how the user typed it (local 0-prefixed, +972, or +9720) and by which
 * version of formatPhoneNumber wrote the row. We reduce the input to its 9-digit
 * core and expand back to every stored variant.
 *
 * Anything that has to find "the account for this number" must use this rather
 * than an equality test on the canonical form, or it will miss the legacy rows
 * and conclude the couple is new.
 */
export const israeliPhoneCandidates = (raw: string): string[] => {
  let d = sanitizePhoneNumber(raw || '');
  if (d.startsWith('972')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  const core = d;
  if (!core) return [];
  return Array.from(new Set([
    `+972${core}`,
    `+9720${core}`,
    `+0${core}`,
    `+${core}`,
    `972${core}`,
    `0${core}`,
    core,
  ]));
};

/**
 * Israeli mobile check, run on the NORMALISED number so 050-123-4567,
 * 0501234567, +972501234567 and 972-50-1234567 all validate identically.
 * Mobile prefixes are 05X + 7 digits → +9725XXXXXXXX.
 */
export const isValidIsraeliMobile = (phone: string): boolean =>
  /^\+9725\d{8}$/.test(formatPhoneNumber(phone));

/** Deliberately permissive — catches typos, not exotic-but-legal addresses. */
export const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(String(email).trim());

/**
 * A wedding date has to be today or later (you can't collect photos for a
 * wedding that already happened) and inside a sane horizon.
 */
export const isValidWeddingDate = (value: unknown, yearsAhead = 4): boolean => {
  const d = new Date(value as any);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = new Date();
  max.setFullYear(max.getFullYear() + yearsAhead);
  return d >= today && d <= max;
};

export const isExpired = (date: Date, days: number = 30): boolean => {
  const now = new Date();
  const expiryDate = new Date(date);
  expiryDate.setDate(expiryDate.getDate() + days);
  return now > expiryDate;
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const generateSlugSuffix = customAlphabet(SLUG_SUFFIX_ALPHABET, 4);

export const generateRandomSlugSuffix = (): string => generateSlugSuffix();

/**
 * The couple's personal link: `dana-yoav-19-11-2026`.
 *
 * No random suffix any more. It used to be appended unconditionally, which made
 * every link four junk characters longer than it needed to be; uniqueness is
 * resolved by the caller, which only adds a suffix when the slug is genuinely
 * taken. Transliteration lives in hebrewTranslit.ts — see the note there on why
 * a letter-for-letter map produced "dnh" and cost every real couple a manual fix.
 */
export const generateCustomSlug = (partner1: string, partner2: string, weddingDate: Date): string => {
  const date = new Date(weddingDate);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  const names = [transliterateHebrewName(partner1), transliterateHebrewName(partner2)]
    .filter(Boolean)
    .join('-');

  return `${names}-${day}-${month}-${year}`.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
};
