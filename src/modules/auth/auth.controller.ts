import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { AuthRequest } from '@/shared/middleware/auth.middleware';
import { env } from '@/shared/config/env';

export class AuthController {
  /**
   * Phone-login slug link: GET /api/auth/phone-login/:phone
   * Logs into the account owning that (Israeli) phone number and redirects into
   * the couple's own gallery view. The token is passed in the URL fragment so it
   * isn't sent to servers/logs/Referer.
   */
  async phoneLoginRedirect(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginByPhone(req.params.phone);
      const base = env.FRONTEND_URL.replace(/\/+$/, '');
      res.redirect(`${base}/gallery#authToken=${encodeURIComponent(result.token)}`);
    } catch (error) {
      next(error);
    }
  }

  async loginSendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginSendOTP(req.body);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async loginVerifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginVerifyOTP(req.body);
      res.json({
        success: true,
        data: result,
        message: 'Login successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async loginWithPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginWithPassword(req.body);
      res.json({
        success: true,
        data: result,
        message: 'Login successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async registerSendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.registerSendOTP(req.body);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async registerVerifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.registerVerifyOTP(req.body);
      res.json({
        success: true,
        data: result,
        message: 'Registration successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async registerDirect(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.registerDirect(req.body);
      res.json({
        success: true,
        data: result,
        message: 'Registration successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async setPassword(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await authService.setPassword(req.userId!, req.body);
      res.json({
        success: true,
        data: user,
        message: 'Password set successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await authService.getProfile(req.userId!);
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await authService.updateProfile(req.userId!, req.body);
      res.json({
        success: true,
        data: user,
        message: 'Profile updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
