import { createApp } from './app';
import { connectDatabase } from './shared/config/database';
import { env } from './shared/config/env';
import logger from './shared/utils/logger';
import { packagesService } from './modules/packages/packages.service';

const startServer = async () => {
  try {
    await connectDatabase();

    await packagesService.seedDefaults();

    const app = createApp();

    const PORT = env.PORT || 5000;

    const server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} in ${env.NODE_ENV} mode`);
      logger.info(`Health check available at http://localhost:${PORT}/health`);
    });

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
