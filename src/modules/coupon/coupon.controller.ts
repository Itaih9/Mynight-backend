import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { couponService } from './coupon.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

class CouponController {
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { code, discountPercent, maxUses, expiresAt } = req.body;
      const coupon = await couponService.create(
        { code, discountPercent, maxUses, expiresAt },
        req.userId
      );
      res.status(201).json({
        success: true,
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  }

  async validate(req: Request, res: Response, next: NextFunction) {
    try {
      const { code } = req.body;
      const result = await couponService.validate(code);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getAll(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const coupons = await couponService.getAll();
      res.json({
        success: true,
        data: coupons,
      });
    } catch (error) {
      next(error);
    }
  }

  async getActiveStandard(_req: Request, res: Response, next: NextFunction) {
    try {
      const coupon = await couponService.getActiveStandard();
      res.json({
        success: true,
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(eventId)) {
        res.json({ success: true, data: null });
        return;
      }
      const coupon = await couponService.getOrCreateEventCoupon(eventId);
      res.json({
        success: true,
        data: {
          code: coupon.code,
          discountAmount: coupon.discountAmount,
          discountPercent: coupon.discountPercent,
          maxUses: coupon.maxUses,
          usedCount: coupon.usedCount,
          isActive: coupon.isActive,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getMyPersonal(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const coupon = await couponService.getOrCreatePersonal(req.userId);
      res.json({
        success: true,
        data: {
          code: coupon.code,
          discountAmount: coupon.discountAmount,
          discountPercent: coupon.discountPercent,
          maxUses: coupon.maxUses,
          usedCount: coupon.usedCount,
          isActive: coupon.isActive,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async deactivate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { couponId } = req.params;
      const coupon = await couponService.deactivate(couponId);
      res.json({
        success: true,
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const couponController = new CouponController();
