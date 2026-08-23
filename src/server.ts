import { createApp } from './app';
import { connectDatabase } from './shared/config/database';
import { env } from './shared/config/env';
import logger from './shared/utils/logger';
import { packagesService } from './modules/packages/packages.service';
import { emailCampaignService } from './modules/emailCampaign/emailCampaign.service';

const startServer = async () => {
  try {
    await connectDatabase();

    await packagesService.seedDefaults();

    const app = createApp();

    const PORT = env.PORT || 5000;

    // Loopback only: nginx proxies to localhost, so nothing else needs to reach
    // this port. Bound to 0.0.0.0 it was one security-group rule away from being
    // public — and a direct caller can set their own X-Forwarded-For, which with
    // `trust proxy` defeats every per-IP limit in the app, including the OTP ones.
    const server = app.listen(PORT, '127.0.0.1', () => {
      logger.info(`Server running on port ${PORT} in ${env.NODE_ENV} mode`);
      logger.info(`Health check available at http://localhost:${PORT}/health`);
    });

    // Admin-editable promotional emails. Idempotency lives in EmailSendLog, so
    // a restart never re-sends.
    await emailCampaignService.seedDefaults();
    emailCampaignService.startScheduler();

    const gracefulShutdown = (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);
      server.close(() => {
        logger.info('Server closed. Exiting process.');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forcefully shutting down after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason: Error) => {
      logger.error('Unhandled Rejection:', reason);
      gracefulShutdown('unhandledRejection');
    });

    process.on('uncaughtException', (error: Error) => {
      logger.error('Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
