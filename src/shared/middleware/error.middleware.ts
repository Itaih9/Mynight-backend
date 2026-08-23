import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof AppError) {
    logger.error(`${err.statusCode} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      statusCode: err.statusCode,
    });
  }

  // A malformed id or a body missing required fields is the caller's mistake,
  // not ours. These used to fall through to the 500 branch, which meant any
  // client could turn a typo into an error-log line and a five-hundred — and it
  // hid genuine faults among the noise.
  const anyErr = err as Error & { name?: string; path?: string; errors?: Record<string, { message: string }> };
  if (anyErr.name === 'CastError') {
    logger.warn(`400 - malformed ${anyErr.path ?? 'id'} - ${req.originalUrl} - ${req.method}`);
    return res.status(400).json({ success: false, error: 'Invalid identifier', statusCode: 400 });
  }
  if (anyErr.name === 'ValidationError' && anyErr.errors) {
    const detail = Object.values(anyErr.errors).map((e) => e.message).join(', ');
    logger.warn(`400 - ${detail} - ${req.originalUrl} - ${req.method}`);
    return res.status(400).json({ success: false, error: detail, statusCode: 400 });
  }

  logger.error(`500 - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);
  logger.error(err.stack);

  return res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    statusCode: 500,
  });
};

export const notFound = (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    statusCode: 404,
  });
};
