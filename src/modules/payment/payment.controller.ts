import { Response, NextFunction } from 'express';
import { paymentService } from './payment.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

export class PaymentController {
  async payWithCoupon(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { eventId, couponCode, amount } = req.body;
      const result = await paymentService.payWithCoupon(
        req.userId!,
        eventId,
        couponCode,
        amount
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
      const { eventId, amount, couponCode } = req.body;
      const result = await paymentService.createSumitPayment(
        req.userId!,
        eventId,
        amount,
        couponCode
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
