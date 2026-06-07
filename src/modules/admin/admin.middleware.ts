import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/shared/config/env';

export interface AdminRequest extends Request {
  adminId?: string;
  adminEmail?: string;
}

interface AdminTokenPayload {
  adminId: string;
  email: string;
  role: string;
}

export const adminProtect = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'No token provided',
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, env.JWT_SECRET) as AdminTokenPayload;

    if (decoded.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required',
      });
      return;
    }

    req.adminId = decoded.adminId;
    req.adminEmail = decoded.email;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid token',
    });
  }
};
