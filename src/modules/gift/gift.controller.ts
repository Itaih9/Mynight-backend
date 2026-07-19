import { Request, Response, NextFunction } from 'express';
import { giftService } from './gift.service';

export class GiftController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { amount, packageName, coupleName, gifterEmail, message } = req.body;
      const result = await giftService.createGift({ amount, packageName, coupleName, gifterEmail, message });
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async charge(req: Request, res: Response, next: NextFunction) {
    try {
      const { giftId, token } = req.body;
      const result = await giftService.chargeGift(giftId, token);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async beginRedirect(req: Request, res: Response, next: NextFunction) {
    try {
      const { giftId } = req.body;
      const result = await giftService.beginGiftRedirect(giftId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async verifyRedirect(req: Request, res: Response, next: NextFunction) {
    try {
      const { giftId } = req.body;
      const result = await giftService.verifyGiftRedirect(giftId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async completeFree(req: Request, res: Response, next: NextFunction) {
    try {
      const { giftId } = req.body;
      const result = await giftService.completeFreeGift(giftId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getByCode(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await giftService.getGiftByCode(req.params.code);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const giftController = new GiftController();
