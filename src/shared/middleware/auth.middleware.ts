import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../utils/errors';

export interface AuthRequest extends Request {
  userId?: string;
  /**
   * Set from the token's `scope` claim. 'gallery' means the session came from
   * /gallery-login, which asks for an identifier and no proof of anything.
   */
  tokenScope?: string;
}

export const protect = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; scope?: string };

    req.userId = decoded.userId;
    req.tokenScope = decoded.scope;
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

/**
 * Bars sessions minted by /gallery-login from anything that changes the account
 * or reveals money.
 *
 * That endpoint takes a phone number or an email and returns a session — no OTP,
 * no password. It has always stamped the token `scope: 'gallery'` and the code
 * around it has always claimed the token was therefore harmless, but nothing
 * ever read the claim, so it was an ordinary full session: it could set a
 * password, move the account to another phone number and read payment history.
 *
 * This is the enforcement that comment described. It is a stopgap, not the fix —
 * the fix is that gallery login proves possession of the number (the OTP flow
 * already exists). Until then a stranger who knows a couple's phone number can
 * still SEE their gallery; they just can no longer take the account.
 */
export const requireFullSession = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.tokenScope === 'gallery') {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'יש להתחבר עם קוד אימות כדי לבצע פעולה זו',
      statusCode: 403,
    });
    return;
  }
  next();
};
