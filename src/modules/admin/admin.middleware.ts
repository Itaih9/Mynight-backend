import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/shared/config/env';
import { Event } from '@/modules/events/events.model';

export interface AdminRequest extends Request {
  adminId?: string;
  adminEmail?: string;
  // Set when the request authenticated with the static service token rather than
  // an admin login. Such requests get admin-level access but are barred from
  // deleting accounts or deleting events they did not create (see guards below).
  isServiceToken?: boolean;
}

interface AdminTokenPayload {
  adminId: string;
  email: string;
  role: string;
}

/**
 * Constant-time comparison against the configured service token. Returns false
 * when no token is configured, so the whole mechanism is off unless an operator
 * explicitly sets SERVICE_API_TOKEN.
 */
const serviceTokenMatches = (candidate: string): boolean => {
  const expected = env.SERVICE_API_TOKEN;
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export const adminProtect = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'No token provided',
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    // Service token: admin-level access, capped by the guards below. Checked
    // first and short-circuits, so it never reaches jwt.verify.
    if (serviceTokenMatches(token)) {
      req.isServiceToken = true;
      req.adminId = 'service-token';
      req.adminEmail = 'service-token';
      next();
      return;
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as AdminTokenPayload;

    if (decoded.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required',
      });
      return;
    }

    req.adminId = decoded.adminId;
    req.adminEmail = decoded.email;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid token',
    });
  }
};

/**
 * Hard rail: forbidden to the service token, always allowed for a human admin.
 * Guards account-deletion routes (users and admins).
 */
export const blockServiceToken = (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.isServiceToken) {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'The service token may not delete accounts.',
    });
    return;
  }
  next();
};

/**
 * Event-scoped rail: a human admin passes straight through; the service token
 * may proceed ONLY when the target event is one it created (createdByService).
 * Guards event deletion and destructive per-event content deletion. Default-deny
 * — an unknown/unstamped event (every real gallery, everything pre-dating this
 * feature) is never deletable by the token.
 */
export const requireServiceOwnedEvent = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.isServiceToken) {
    next();
    return;
  }
  try {
    const { eventId } = req.params;
    const event = await Event.findById(eventId).select('createdByService');
    if (!event) {
      res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
      return;
    }
    if (!event.createdByService) {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'The service token may only delete events it created.',
      });
      return;
    }
    next();
  } catch (error) {
    // A malformed id (CastError) or lookup failure must never fall open.
    res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid event id' });
  }
};
