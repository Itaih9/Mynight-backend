import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AffiliateRequest } from './affiliate.controller';
import { UnauthorizedError } from '@/shared/utils/errors';

export const protectAffiliate = async (req: AffiliateRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { affiliateId: string };

    req.affiliateId = decoded.affiliateId;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new UnauthorizedError('Invalid token'));
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new UnauthorizedError('Token expired'));
    } else {
      next(error);
    }
  }
};
