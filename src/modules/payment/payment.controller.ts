import { Request, Response, NextFunction } from 'express';
import { paymentService } from './payment.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

export class PaymentController {
  async payWithCoupon(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // `amount` may still arrive in the body from older clients; it is
      // deliberately not forwarded — the service prices the event itself.
      const { eventId, couponCode } = req.body;
      const result = await paymentService.payWithCoupon(
        req.userId!,
        eventId,
        couponCode
      );
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async createPayment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { eventId, amount, couponCode, product } = req.body;
      const result = await paymentService.createSumitPayment(
        req.userId!,
        eventId,
        amount,
        couponCode,
        product
      );
      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async chargeSumit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { paymentId, token } = req.body;
      const payment = await paymentService.chargeSumit(paymentId, token, req.userId!);
      res.json({
        success: true,
        data: payment,
        message: 'Payment completed successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async beginSumitRedirect(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { paymentId } = req.body;
      const result = await paymentService.beginSumitRedirect(paymentId, req.userId!);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async verifySumitRedirect(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { paymentId } = req.body;
      const result = await paymentService.verifySumitRedirect(paymentId, req.userId!);
      res.json({
        success: result.success,
        data: result.payment,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  // Public — code-in-link Flash+ upgrade (couple not logged in)
  async beginFlashPlus(req: Request, res: Response, next: NextFunction) {
    try {
      const { code } = req.body;
      const result = await paymentService.beginFlashPlusByCode(code);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async verifyFlashPlus(req: Request, res: Response, next: NextFunction) {
    try {
      const { paymentId } = req.body;
      const result = await paymentService.verifyFlashPlusByPayment(paymentId);
      res.json({ success: result.success, data: result, message: result.message });
    } catch (error) {
      next(error);
    }
  }

  async getPayment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const payment = await paymentService.getPayment(req.params.paymentId, req.userId!);
      res.json({
        success: true,
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserPayments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const payments = await paymentService.getUserPayments(req.userId!);
      res.json({
        success: true,
        data: payments,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventPaymentStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const status = await paymentService.getEventPaymentStatus(eventId, req.userId!);
      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const paymentController = new PaymentController();
