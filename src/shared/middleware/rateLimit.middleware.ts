import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'יותר מדי ניסיונות התחברות. נסו שוב בעוד מספר דקות.',
    statusCode: 429,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const loginBruteForceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 7,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    error: 'יותר מדי ניסיונות כניסה כושלים. נסו שוב בעוד שעה.',
    statusCode: 429,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpPhoneTracker = new Map<string, number[]>();
const otpIpHourTracker = new Map<string, number[]>();
const otpIpDayTracker = new Map<string, number[]>();
const suspiciousIpTracker = new Map<string, Set<string>>();

const OTP_PHONE_LIMIT = 3;
const OTP_PHONE_WINDOW = 60 * 60 * 1000;
const OTP_IP_HOUR_LIMIT = 5;
const OTP_IP_HOUR_WINDOW = 60 * 60 * 1000;
const OTP_IP_DAY_LIMIT = 10;
const OTP_IP_DAY_WINDOW = 24 * 60 * 60 * 1000;
const SUSPICIOUS_PHONE_THRESHOLD = 3;

function cleanOldEntries(timestamps: number[], windowMs: number): number[] {
  const now = Date.now();
  return timestamps.filter(t => now - t < windowMs);
}

export const otpRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const phone = req.body?.phoneNumber;
  const now = Date.now();

  if (phone) {
    const phoneKey = String(phone);
    const phoneTimestamps = cleanOldEntries(otpPhoneTracker.get(phoneKey) || [], OTP_PHONE_WINDOW);
    if (phoneTimestamps.length >= OTP_PHONE_LIMIT) {
      res.status(429).json({
        success: false,
        error: 'יותר מדי בקשות קוד לטלפון זה. נסו שוב מאוחר יותר.',
        statusCode: 429,
      });
      return;
    }
    phoneTimestamps.push(now);
    otpPhoneTracker.set(phoneKey, phoneTimestamps);

    const ipPhones = suspiciousIpTracker.get(ip) || new Set();
    ipPhones.add(phoneKey);
    suspiciousIpTracker.set(ip, ipPhones);

    if (ipPhones.size > SUSPICIOUS_PHONE_THRESHOLD) {
      res.status(429).json({
        success: false,
        error: 'פעילות חשודה זוהתה. נסו שוב מאוחר יותר.',
        statusCode: 429,
      });
      return;
    }
  }

  const ipHourTimestamps = cleanOldEntries(otpIpHourTracker.get(ip) || [], OTP_IP_HOUR_WINDOW);
  if (ipHourTimestamps.length >= OTP_IP_HOUR_LIMIT) {
    res.status(429).json({
      success: false,
      error: 'יותר מדי בקשות קוד. נסו שוב מאוחר יותר.',
      statusCode: 429,
    });
    return;
  }
  ipHourTimestamps.push(now);
  otpIpHourTracker.set(ip, ipHourTimestamps);

  const ipDayTimestamps = cleanOldEntries(otpIpDayTracker.get(ip) || [], OTP_IP_DAY_WINDOW);
  if (ipDayTimestamps.length >= OTP_IP_DAY_LIMIT) {
    res.status(429).json({
      success: false,
      error: 'חרגתם מהמגבלה היומית. נסו שוב מחר.',
      statusCode: 429,
    });
    return;
  }
  ipDayTimestamps.push(now);
  otpIpDayTracker.set(ip, ipDayTimestamps);

  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of otpPhoneTracker) {
    const cleaned = timestamps.filter(t => now - t < OTP_PHONE_WINDOW);
    if (cleaned.length === 0) otpPhoneTracker.delete(key);
    else otpPhoneTracker.set(key, cleaned);
  }
  for (const [key, timestamps] of otpIpHourTracker) {
    const cleaned = timestamps.filter(t => now - t < OTP_IP_HOUR_WINDOW);
    if (cleaned.length === 0) otpIpHourTracker.delete(key);
    else otpIpHourTracker.set(key, cleaned);
  }
  for (const [key, timestamps] of otpIpDayTracker) {
    const cleaned = timestamps.filter(t => now - t < OTP_IP_DAY_WINDOW);
    if (cleaned.length === 0) otpIpDayTracker.delete(key);
    else otpIpDayTracker.set(key, cleaned);
  }
  suspiciousIpTracker.clear();
}, 60 * 60 * 1000);

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: {
    success: false,
    error: 'Too many upload requests, please try again later',
    statusCode: 429,
  },
});

export const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10000'),
  message: {
    success: false,
    error: 'Too many requests, please try again later',
    statusCode: 429,
  },
});
