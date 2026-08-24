import { Request, Response, NextFunction } from 'express';
import QRCode from 'qrcode';
import { rollLengthFor } from '@/shared/config/flashPlans';
import { isValidIsraeliMobile, isValidEmail, isValidWeddingDate } from '@/shared/utils/helpers';
import { eventsService } from './events.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';
import { env } from '@/shared/config/env';

export class EventsController {
  async createEvent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.createEvent(req.userId!, req.body.name);
      res.status(201).json({
        success: true,
        data: event,
        message: 'Event created successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getEvent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.getEvent(req.params.id);
      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventByCode(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.getEventByCode(req.params.code);
      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  }

  // Public QR of the guest camera link — the couple prints/displays it at the
  // wedding and guests scan it. Generated on our own backend (no third-party QR
  // service), cached, and downloadable via ?download=1.
  async getEventQr(req: Request, res: Response, next: NextFunction) {
    try {
      const code = req.params.code.toUpperCase();
      await eventsService.getEventByCode(code); // 404s if the code is unknown
      const target = `${env.FRONTEND_URL}/camera/${code}`;
      const png = await QRCode.toBuffer(target, {
        type: 'png',
        width: 720,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#1A1A1A', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (req.query.download) {
        res.setHeader('Content-Disposition', `attachment; filename="mynight-flash-${code}.png"`);
      }
      res.send(png);
    } catch (error) {
      next(error);
    }
  }

  async getEventBySlug(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.getEventBySlug(req.params.slug);
      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventByCodeOrSlug(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.getEventByCodeOrSlug(req.params.identifier);
      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserEvents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const events = await eventsService.getUserEvents(req.userId!);
      res.json({
        success: true,
        data: events,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteEvent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await eventsService.deleteEvent(req.params.id, req.userId!);
      res.json({
        success: true,
        message: 'Event deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async updateSlug(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.updateSlug(req.params.id, req.userId!, req.body.customSlug);
      res.json({
        success: true,
        data: event,
        message: 'Slug updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async updateSharingPermissions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const event = await eventsService.updateSharingPermissions(
        req.params.id,
        req.userId!,
        req.body
      );
      res.json({
        success: true,
        data: {
          sharingPermissions: event.sharingPermissions,
        },
        message: 'Sharing permissions updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async uploadGuestListFile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
        return;
      }

      const guestListFile = await eventsService.uploadGuestListFile(
        req.params.id,
        req.userId!,
        req.file
      );

      res.status(201).json({
        success: true,
        data: guestListFile,
        message: 'Guest list file uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteGuestListFile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await eventsService.deleteGuestListFile(req.params.id, req.userId!);
      res.json({
        success: true,
        message: 'Guest list file deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getGuestListFile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const guestListFile = await eventsService.getGuestListFile(req.params.id, req.userId!);
      res.json({
        success: true,
        data: guestListFile,
      });
    } catch (error) {
      next(error);
    }
  }

  /** Public, unauthenticated: free פלאש signup (top of the lead funnel). */
  async registerFreeFlash(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { coupleName, weddingDate, phoneNumber, email } = req.body || {};
      if (!coupleName || !String(coupleName).trim()) {
        res.status(400).json({ success: false, error: 'שם הזוג נדרש' });
        return;
      }
      if (String(coupleName).trim().length < 2) {
        res.status(400).json({ success: false, error: 'שם הזוג קצר מדי' });
        return;
      }
      if (!phoneNumber || !String(phoneNumber).trim()) {
        res.status(400).json({ success: false, error: 'מספר טלפון נדרש' });
        return;
      }
      // Format matters here: the phone is the couple's login to the album, so a
      // typo means they can never reach it — and the number is also the key
      // registration is idempotent on.
      if (!isValidIsraeliMobile(String(phoneNumber))) {
        res.status(400).json({ success: false, error: 'מספר טלפון לא תקין — נסו בפורמט 050-0000000' });
        return;
      }
      // Email is required, not optional: the entire pre-wedding upsell sequence
      // is delivered by mail, so a signup without one is a lead we can never
      // reach — the funnel would fail silently.
      if (!email || !String(email).trim()) {
        res.status(400).json({ success: false, error: 'אימייל נדרש' });
        return;
      }
      if (!isValidEmail(String(email))) {
        res.status(400).json({ success: false, error: 'כתובת אימייל לא תקינה' });
        return;
      }
      const date = new Date(weddingDate);
      if (!weddingDate || isNaN(date.getTime())) {
        res.status(400).json({ success: false, error: 'תאריך חתונה נדרש' });
        return;
      }
      // A past date would expire the event on creation and make it invisible to
      // the upsell sweep, which only looks forward. The upper bound catches
      // mistyped years (2062 instead of 2026) that would park a lead forever.
      if (!isValidWeddingDate(date)) {
        res.status(400).json({ success: false, error: 'תאריך החתונה חייב להיות בעתיד (ועד 4 שנים קדימה)' });
        return;
      }

      const { event, isNew } = await eventsService.registerFreeFlash({
        coupleName: String(coupleName).trim(),
        weddingDate: date,
        phoneNumber: String(phoneNumber).trim(),
        email: String(email).trim(),
      });

      res.status(isNew ? 201 : 200).json({
        success: true,
        data: {
          eventCode: event.eventCode,
          cameraUrl: `${env.FRONTEND_URL}/camera/${event.eventCode}`,
          weddingDate: event.weddingDate,
          shotLimit: rollLengthFor(event),
          isNew,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const eventsController = new EventsController();
