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

export const formatPhoneNumber = (phone: string): string => {
  const cleaned = sanitizePhoneNumber(phone);
  if (!cleaned.startsWith('+')) {
    return `+${cleaned}`;
  }
  return cleaned;
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

export const generateCustomSlug = (partner1: string, partner2: string, weddingDate: Date): string => {
  const transliterate = (text: string): string => {
    const hebrewMap: { [key: string]: string } = {
      'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
      'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm',
      'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'p',
      'צ': 'ts', 'ץ': 'ts', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't'
    };
    return text.split('').map(char => hebrewMap[char] || char).join('');
  };

  const cleanName = (name: string): string => {
    const transliterated = transliterate(name.trim().toLowerCase());
    return transliterated.replace(/[^a-z0-9]/g, '');
  };

  const date = new Date(weddingDate);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${cleanName(partner1)}-${cleanName(partner2)}-${day}-${month}-${year}-${generateSlugSuffix()}`;
};
