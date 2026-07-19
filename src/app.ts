import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler } from './shared/middleware/error.middleware';
import { apiLimiter } from './shared/middleware/rateLimit.middleware';
import authRoutes from './modules/auth/auth.routes';
import eventsRoutes from './modules/events/events.routes';
import photosRoutes from './modules/photos/photos.routes';
import facesRoutes from './modules/faces/faces.routes';
import paymentRoutes from './modules/payment/payment.routes';
import affiliateRoutes from './modules/affiliate/affiliate.routes';
import couponRoutes from './modules/coupon/coupon.routes';
import giftRoutes from './modules/gift/gift.routes';
import adminRoutes from './modules/admin/admin.routes';
import contactRoutes from './modules/contact/contact.routes';
import guestsRoutes from './modules/guests/guests.routes';
import reviewRoutes from './modules/review/review.routes';
import packagesRoutes from './modules/packages/packages.routes';

export const createApp = (): Application => {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    })
  );

  app.use(helmet());

  // Special raw body handling for specific endpoints
  app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/photos/upload-raw', express.raw({ type: '*/*', limit: '10mb' }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  if (process.env.NODE_ENV === 'production') {
    app.use('/api', apiLimiter);
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/events', eventsRoutes);
  app.use('/api/photos', photosRoutes);

  app.use('/api/faces', facesRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use('/api/affiliate', affiliateRoutes);
  app.use('/api/coupons', couponRoutes);
  app.use('/api/gifts', giftRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/guests', guestsRoutes);
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/packages', packagesRoutes);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Not Found',
      message: 'The requested resource does not exist',
    });
  });

  app.use(errorHandler);

  return app;
};
