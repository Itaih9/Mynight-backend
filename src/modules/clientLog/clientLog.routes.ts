import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import logger from '@/shared/utils/logger';

const router = Router();

/**
 * Camera telemetry from the guest disposable camera.
 *
 * The iPhone-only camera failures (stream frozen after an interruption, lens
 * silently swapped by a recovery restart) don't reproduce on anything we can
 * drive — not a simulator, not a device farm with no real camera, not the
 * Android handsets. They happen on a guest's phone, at a venue, mid-party. So
 * the failure has to report itself.
 *
 * Public and unauthenticated, because guests have no login. That makes it an
 * open write into our logs, so it's rate-limited per IP and every field is
 * clipped to a fixed length before it reaches the logger — an unbounded string
 * from a client is how you turn a log file into an outage.
 */
const clientLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many log events' },
});

const clip = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  // Newlines would let a client forge extra log lines.
  return String(v).replace(/[\r\n]+/g, ' ').slice(0, max);
};

router.post('/camera', clientLogLimiter, (req: Request, res: Response) => {
  const b = (req.body || {}) as Record<string, unknown>;

  const field = (label: string, value: unknown, max: number) => {
    const v = clip(value, max);
    return v === undefined ? '' : `${label}=${v}`;
  };

  const line = [
    field('session', b.session, 12),
    field('code', b.code, 12),
    field('event', b.event, 40),
    field('requested', b.requested, 12),
    field('granted', b.granted, 12),
    field('res', b.width && b.height ? `${b.width}x${b.height}` : undefined, 12),
    field('muted', b.muted, 6),
    field('track', b.readyState, 12),
    field('vis', b.visibility, 10),
    field('mode', b.mode, 8),
    field('rec', b.recording, 6),
    field('tier', b.tier, 3),
    field('detail', b.detail, 300),
    field('ua', b.ua, 180),
  ]
    .filter(Boolean)
    .join(' ');

  // warn, not info: the logger defaults to level 'warn' in production, so info
  // is discarded before it reaches any transport — a diagnostic channel nobody
  // can read is worse than none. Volume is bounded by the rate limiter above.
  logger.warn(`[camera] ${line}`);
  // 204: the client uses sendBeacon, which ignores the body anyway, and this
  // must never be something the camera waits on.
  res.status(204).end();
});

export default router;
