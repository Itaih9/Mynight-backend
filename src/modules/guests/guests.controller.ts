import { Response, NextFunction } from 'express';
import { guestsService } from './guests.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

export class GuestsController {
  async addGuest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const guest = await guestsService.addGuest(
        req.params.eventId,
        req.userId!,
        req.body
      );
      res.status(201).json({
        success: true,
        data: guest,
        message: 'Guest added successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async addGuestsBulk(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await guestsService.addGuestsBulk(
        req.params.eventId,
        req.userId!,
        req.body.guests
      );
      res.status(201).json({
        success: true,
        data: result,
        message: `${result.added} guests added, ${result.skipped} skipped`,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventGuests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const guests = await guestsService.getEventGuests(
        req.params.eventId,
        req.userId!
      );
      res.json({
        success: true,
        data: guests,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateGuest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const guest = await guestsService.updateGuest(
        req.params.guestId,
        req.params.eventId,
        req.userId!,
        req.body
      );
      res.json({
        success: true,
        data: guest,
        message: 'Guest updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteGuest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await guestsService.deleteGuest(
        req.params.guestId,
        req.params.eventId,
        req.userId!
      );
      res.json({
        success: true,
        message: 'Guest deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteAllGuests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const count = await guestsService.deleteAllGuests(
        req.params.eventId,
        req.userId!
      );
      res.json({
        success: true,
        message: `${count} guests deleted`,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const guestsController = new GuestsController();
