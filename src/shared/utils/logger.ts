import winston from 'winston';
import dotenv from 'dotenv';

/**
 * Load .env HERE rather than relying on someone else having done it.
 *
 * The level is read once, when this module is first imported — and server.ts
 * imports ./app on its first line, which reaches this file through the route
 * and service graph well before shared/config/env runs dotenv.config(). So
 * LOG_LEVEL from .env was never in process.env in time: setting it changed
 * nothing, and the logger stayed pinned at the 'warn' fallback with every
 * logger.info in the codebase silently discarded.
 *
 * dotenv does not overwrite variables that are already set, so calling it a
 * second time from config/env is harmless.
 */
dotenv.config();

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'warn',
  format: logFormat,
  defaultMeta: { service: 'eventmatch-api' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

export default logger;
