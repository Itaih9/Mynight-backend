import { Request, Response, NextFunction } from 'express';
import { contactService } from './contact.service';
import { ContactStatus } from './contact.model';

export class ContactController {
  // Public endpoint - anyone can submit
  async submit(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, email, phone, subject, message } = req.body;
      const contact = await contactService.create({
        name,
        email,
        phone,
        subject,
        message,
      });

      res.status(201).json({
        success: true,
        message: 'Your message has been sent successfully. We will get back to you soon.',
        data: {
          id: contact._id,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Admin endpoints
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as ContactStatus | undefined;

      const result = await contactService.getAll(page, limit, status);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const contact = await contactService.getById(req.params.contactId);
      res.json({
        success: true,
        data: contact,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { status } = req.body;
      const contact = await contactService.updateStatus(req.params.contactId, status);
      res.json({
        success: true,
        data: contact,
      });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await contactService.delete(req.params.contactId);
      res.json({
        success: true,
        message: 'Contact deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getStats(_req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await contactService.getStats();
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const contactController = new ContactController();
