import { Request, Response, NextFunction } from 'express';
import { reviewService } from './review.service';
import { ReviewStatus } from './review.model';
import { AuthRequest } from '@/shared/middleware/auth.middleware';

export class ReviewController {
  async submit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { rating, text } = req.body;
      const review = await reviewService.create({
        rating,
        text,
        userId: req.userId,
      });

      res.status(201).json({
        success: true,
        message: 'Review submitted successfully.',
        data: {
          id: review._id,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getApproved(_req: Request, res: Response, next: NextFunction) {
    try {
      const reviews = await reviewService.getApproved();
      res.json({
        success: true,
        data: reviews,
      });
    } catch (error) {
      next(error);
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as ReviewStatus | undefined;

      const result = await reviewService.getAll(page, limit, status);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { status } = req.body;
      const review = await reviewService.updateStatus(req.params.reviewId, status);
      res.json({
        success: true,
        data: review,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const reviewController = new ReviewController();
