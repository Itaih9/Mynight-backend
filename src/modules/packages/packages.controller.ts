import { Request, Response, NextFunction } from 'express';
import { packagesService } from './packages.service';

class PackagesController {
  async getPublic(_req: Request, res: Response, next: NextFunction) {
    try {
      const packages = await packagesService.getAll();
      res.json({ success: true, data: packages });
    } catch (error) {
      next(error);
    }
  }

  async getAllAdmin(_req: Request, res: Response, next: NextFunction) {
    try {
      const packages = await packagesService.getAllForAdmin();
      res.json({ success: true, data: packages });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { title, englishTitle, price, order, isActive } = req.body;
      const updated = await packagesService.update(key, { title, englishTitle, price, order, isActive });
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
}

export const packagesController = new PackagesController();
