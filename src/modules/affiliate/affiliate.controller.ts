import { Request, Response, NextFunction } from 'express';
import { affiliateService } from './affiliate.service';

export interface AffiliateRequest extends Request {
  affiliateId?: string;
}

function serializeAffiliate(affiliate: any) {
  return {
    _id: affiliate._id,
    name: affiliate.name,
    email: affiliate.email,
    phone: affiliate.phone,
    paypalEmail: affiliate.paypalEmail,
    bankDetails: affiliate.bankDetails,
    bankName: affiliate.bankName,
    bankBranch: affiliate.bankBranch,
    bankAccountNumber: affiliate.bankAccountNumber,
    bankAccountHolder: affiliate.bankAccountHolder,
    category: affiliate.category,
    intent: affiliate.intent,
    status: affiliate.status,
    referralCode: affiliate.referralCode,
    totalEarnings: affiliate.totalEarnings,
    pendingEarnings: affiliate.pendingEarnings,
    paidEarnings: affiliate.paidEarnings,
    totalReferrals: affiliate.totalReferrals,
    prepaidBalance: affiliate.prepaidBalance || 0,
    prepaidUsed: affiliate.prepaidUsed || 0,
    prepaidCouponCode: affiliate.prepaidCouponCode,
    createdAt: affiliate.createdAt,
    updatedAt: affiliate.updatedAt,
  };
}

export class AffiliateController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, phone, category, intent } = req.body;
      const affiliate = await affiliateService.register({ email, password, phone, category, intent });
      res.status(201).json({
        success: true,
        data: {
          _id: affiliate._id,
          email: affiliate.email,
          phone: affiliate.phone,
          category: affiliate.category,
          intent: affiliate.intent,
          status: affiliate.status,
          referralCode: affiliate.referralCode,
        },
        message: 'Affiliate registration successful. Your application is pending approval.',
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const { affiliate, token } = await affiliateService.loginAffiliate(email, password);
      res.json({
        success: true,
        data: {
          token,
          affiliate: serializeAffiliate(affiliate),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getMe(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const affiliate = await affiliateService.getMe(req.affiliateId!);
      res.json({ success: true, data: serializeAffiliate(affiliate) });
    } catch (error) {
      next(error);
    }
  }

  async updateProfile(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const updates = {
        name: req.body.name,
        phone: req.body.phone,
        paypalEmail: req.body.paypalEmail,
        bankDetails: req.body.bankDetails,
        bankName: req.body.bankName,
        bankBranch: req.body.bankBranch,
        bankAccountNumber: req.body.bankAccountNumber,
        bankAccountHolder: req.body.bankAccountHolder,
      };
      const affiliate = await affiliateService.updateProfile(req.affiliateId!, updates);
      res.json({ success: true, data: serializeAffiliate(affiliate) });
    } catch (error) {
      next(error);
    }
  }

  async requestWithdrawal(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const { amount, note } = req.body;
      const withdrawal = await affiliateService.requestWithdrawal(req.affiliateId!, Number(amount), note);
      res.status(201).json({ success: true, data: withdrawal });
    } catch (error) {
      next(error);
    }
  }

  async getWithdrawals(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const withdrawals = await affiliateService.getWithdrawals(req.affiliateId!);
      res.json({ success: true, data: withdrawals });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const stats = await affiliateService.getStats(affiliateId);
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  async getReferrals(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const referrals = await affiliateService.getReferrals(affiliateId);
      res.json({
        success: true,
        data: referrals,
      });
    } catch (error) {
      next(error);
    }
  }

  async getMyPrepaid(req: AffiliateRequest, res: Response, next: NextFunction) {
    try {
      const summary = await affiliateService.getPrepaidSummary(req.affiliateId!);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  }
}

export const affiliateController = new AffiliateController();
