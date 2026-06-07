import { Request, Response, NextFunction } from 'express';
import { eventsService } from './events.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

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
}

export const eventsController = new EventsController();
