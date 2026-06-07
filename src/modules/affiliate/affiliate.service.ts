import { Referral } from './referral.model';
import { Affiliate, IAffiliate } from './affiliate.model';
import { Withdrawal, IWithdrawal } from './withdrawal.model';
import { PrepaidUsage, IPrepaidUsage } from './prepaidUsage.model';
import { Coupon } from '../coupon/coupon.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/shared/config/env';

const MIN_WITHDRAWAL_AMOUNT = 100;

interface AffiliateRegistration {
  email: string;
  password: string;
  phone: string;
  category: string;
  intent: string;
}

interface AffiliateStats {
  totalReferrals: number;
  convertedReferrals: number;
  pendingReferrals: number;
  totalEarnings: number;
  pendingEarnings: number;
  paidEarnings: number;
  referralCode: string;
}

interface AffiliateReferral {
  id: string;
  status: string;
  commissionAmount: number;
  paymentAmount?: number;
  convertedAt?: Date;
  createdAt: Date;
}

class AffiliateService {
  async register(data: AffiliateRegistration): Promise<IAffiliate> {
    const existingAffiliate = await Affiliate.findOne({ email: data.email });
    if (existingAffiliate) {
      throw new ValidationError('Email already registered as affiliate');
    }

    const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

    const affiliate = await Affiliate.create({
      email: data.email,
      password: data.password,
      phone: data.phone,
      category: data.category,
      intent: data.intent,
      referralCode,
      status: 'pending',
    });

    logger.info(`New affiliate registered: ${data.email}`);

    return affiliate;
  }

  async getAffiliateByEmail(email: string): Promise<IAffiliate | null> {
    return Affiliate.findOne({ email: email.toLowerCase() });
  }

  async getStats(affiliateId: string): Promise<AffiliateStats> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }

    const referrals = await Referral.find({ affiliateId });

    const stats: AffiliateStats = {
      totalReferrals: affiliate.totalReferrals,
      convertedReferrals: referrals.filter((r) => r.status === 'converted' || r.status === 'paid').length,
      pendingReferrals: referrals.filter((r) => r.status === 'pending').length,
      totalEarnings: affiliate.totalEarnings,
      pendingEarnings: affiliate.pendingEarnings,
      paidEarnings: affiliate.paidEarnings,
      referralCode: affiliate.referralCode,
    };

    return stats;
  }

  async getReferrals(affiliateId: string): Promise<AffiliateReferral[]> {
    const referrals = await Referral.find({ affiliateId })
      .sort({ createdAt: -1 });

    return referrals.map((r) => ({
      id: r._id.toString(),
      status: r.status,
      commissionAmount: r.commissionAmount,
      paymentAmount: r.paymentAmount,
      convertedAt: r.convertedAt,
      createdAt: r.createdAt,
    }));
  }

  async loginAffiliate(email: string, password: string): Promise<{ affiliate: IAffiliate; token: string }> {
    const affiliate = await Affiliate.findOne({
      email: email.toLowerCase(),
    });

    if (!affiliate) {
      throw new ValidationError('Invalid email or password');
    }

    if (!affiliate.password) {
      throw new ValidationError('Invalid email or password');
    }

    const isMatch = await affiliate.comparePassword(password);
    if (!isMatch) {
      throw new ValidationError('Invalid email or password');
    }

    if (affiliate.status !== 'approved') {
      throw new ValidationError('Your account is not approved yet');
    }

    const token = jwt.sign(
      { affiliateId: affiliate._id },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as string } as jwt.SignOptions
    );

    return { affiliate, token };
  }

  async updateProfile(
    affiliateId: string,
    updates: {
      name?: string;
      phone?: string;
      paypalEmail?: string;
      bankDetails?: string;
      bankName?: string;
      bankBranch?: string;
      bankAccountNumber?: string;
      bankAccountHolder?: string;
    }
  ): Promise<IAffiliate> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }

    if (updates.name !== undefined) affiliate.name = updates.name.trim();
    if (updates.phone !== undefined) affiliate.phone = updates.phone.trim();
    if (updates.paypalEmail !== undefined) affiliate.paypalEmail = updates.paypalEmail.trim().toLowerCase();
    if (updates.bankDetails !== undefined) affiliate.bankDetails = updates.bankDetails.trim();
    if (updates.bankName !== undefined) {
      const v = updates.bankName.trim().slice(0, 30);
      affiliate.bankName = v;
    }
    if (updates.bankBranch !== undefined) {
      const v = updates.bankBranch.replace(/\D/g, '').slice(0, 4);
      if (v && (v.length < 1 || v.length > 4)) {
        throw new ValidationError('מספר סניף חייב להכיל 1-4 ספרות');
      }
      affiliate.bankBranch = v;
    }
    if (updates.bankAccountNumber !== undefined) {
      const v = updates.bankAccountNumber.replace(/\D/g, '').slice(0, 9);
      if (v && (v.length < 4 || v.length > 9)) {
        throw new ValidationError('מספר חשבון חייב להכיל 4-9 ספרות');
      }
      affiliate.bankAccountNumber = v;
    }
    if (updates.bankAccountHolder !== undefined) {
      affiliate.bankAccountHolder = updates.bankAccountHolder.trim().slice(0, 60);
    }

    await affiliate.save({ validateModifiedOnly: true });
    return affiliate;
  }

  private buildBankSnapshot(affiliate: IAffiliate): string {
    const parts: string[] = [];
    if (affiliate.bankName) parts.push(`בנק: ${affiliate.bankName}`);
    if (affiliate.bankBranch) parts.push(`סניף: ${affiliate.bankBranch}`);
    if (affiliate.bankAccountNumber) parts.push(`חשבון: ${affiliate.bankAccountNumber}`);
    if (affiliate.bankAccountHolder) parts.push(`בעל החשבון: ${affiliate.bankAccountHolder}`);
    return parts.join(' · ') || affiliate.bankDetails || '';
  }

  private hasCompleteBankDetails(affiliate: IAffiliate): boolean {
    return Boolean(
      affiliate.bankName?.trim() &&
      affiliate.bankBranch?.trim() &&
      affiliate.bankAccountNumber?.trim() &&
      affiliate.bankAccountHolder?.trim()
    );
  }

  async getMe(affiliateId: string): Promise<IAffiliate> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    return affiliate;
  }

  async requestWithdrawal(affiliateId: string, amount: number, note?: string): Promise<IWithdrawal> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    if (affiliate.status !== 'approved') {
      throw new ValidationError('Your account is not approved');
    }
    if (!this.hasCompleteBankDetails(affiliate)) {
      throw new ValidationError('יש למלא את פרטי הבנק (בנק, סניף, מספר חשבון, שם בעל החשבון) לפני שליחת בקשה');
    }
    if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL_AMOUNT) {
      throw new ValidationError(`Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT} ILS`);
    }
    if (amount > affiliate.pendingEarnings) {
      throw new ValidationError('Amount exceeds available balance');
    }

    const pending = await Withdrawal.findOne({ affiliateId, status: 'pending' });
    if (pending) {
      throw new ValidationError('You already have a pending withdrawal request');
    }

    const withdrawal = await Withdrawal.create({
      affiliateId,
      amount,
      status: 'pending',
      note,
      bankDetailsSnapshot: this.buildBankSnapshot(affiliate),
    });

    logger.info(`Withdrawal requested: ${amount} ILS by affiliate ${affiliate.email}`);
    return withdrawal;
  }

  async getWithdrawals(affiliateId: string): Promise<IWithdrawal[]> {
    return Withdrawal.find({ affiliateId }).sort({ createdAt: -1 });
  }

  async listAllWithdrawals(filter?: { status?: 'pending' | 'paid' | 'rejected' }): Promise<any[]> {
    const query: any = {};
    if (filter?.status) query.status = filter.status;
    const withdrawals = await Withdrawal.find(query)
      .sort({ createdAt: -1 })
      .populate('affiliateId', 'email name phone paypalEmail bankDetails referralCode');
    return withdrawals;
  }

  async markWithdrawalPaid(withdrawalId: string, adminNote?: string): Promise<IWithdrawal> {
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) {
      throw new NotFoundError('Withdrawal');
    }
    if (withdrawal.status === 'paid') {
      throw new ValidationError('Withdrawal already marked as paid');
    }

    const affiliate = await Affiliate.findById(withdrawal.affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }

    affiliate.pendingEarnings = Math.max(0, affiliate.pendingEarnings - withdrawal.amount);
    affiliate.paidEarnings = (affiliate.paidEarnings || 0) + withdrawal.amount;
    await affiliate.save({ validateModifiedOnly: true });

    withdrawal.status = 'paid';
    withdrawal.paidAt = new Date();
    if (adminNote) withdrawal.adminNote = adminNote;
    await withdrawal.save();

    logger.info(`Withdrawal ${withdrawalId} marked paid (${withdrawal.amount} ILS) for ${affiliate.email}`);
    return withdrawal;
  }

  async adminPayoutAffiliate(affiliateId: string, amount: number, adminNote?: string): Promise<IWithdrawal> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError('Amount must be greater than 0');
    }
    if (amount > affiliate.pendingEarnings) {
      throw new ValidationError('Amount exceeds available balance');
    }

    affiliate.pendingEarnings = Math.max(0, affiliate.pendingEarnings - amount);
    affiliate.paidEarnings = (affiliate.paidEarnings || 0) + amount;
    await affiliate.save({ validateModifiedOnly: true });

    const withdrawal = await Withdrawal.create({
      affiliateId,
      amount,
      status: 'paid',
      adminNote: adminNote || 'Direct payout by admin',
      bankDetailsSnapshot: this.buildBankSnapshot(affiliate),
      paidAt: new Date(),
    });

    logger.info(`Direct admin payout: ${amount} ILS to ${affiliate.email}`);
    return withdrawal;
  }

  async ensurePrepaidCoupon(affiliateId: string): Promise<string> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    if (affiliate.prepaidCouponCode) {
      const existing = await Coupon.findOne({ code: affiliate.prepaidCouponCode });
      if (existing) return affiliate.prepaidCouponCode;
    }

    let code: string;
    let attempts = 0;
    while (true) {
      code = `PRE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const exists = await Coupon.findOne({ code });
      if (!exists) break;
      if (++attempts > 10) throw new Error('Failed to generate unique prepaid code');
    }

    await Coupon.create({
      code,
      discountPercent: 100,
      maxUses: 0,
      isActive: true,
      affiliateId: affiliate._id,
      type: 'prepaid',
    });

    affiliate.prepaidCouponCode = code;
    await affiliate.save({ validateModifiedOnly: true });

    logger.info(`Generated prepaid coupon ${code} for affiliate ${affiliate.email}`);
    return code;
  }

  async topUpPrepaid(affiliateId: string, eventsToAdd: number, adminNote?: string): Promise<IAffiliate> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    if (!Number.isFinite(eventsToAdd) || eventsToAdd <= 0) {
      throw new ValidationError('Events to add must be greater than 0');
    }
    affiliate.prepaidBalance = (affiliate.prepaidBalance || 0) + Math.floor(eventsToAdd);
    await affiliate.save({ validateModifiedOnly: true });

    await this.ensurePrepaidCoupon(String(affiliate._id));

    logger.info(`Admin topped up ${eventsToAdd} events for affiliate ${affiliate.email}${adminNote ? ` (note: ${adminNote})` : ''}`);
    return affiliate;
  }

  async getPrepaidSummary(affiliateId: string): Promise<{
    balance: number;
    used: number;
    couponCode?: string;
    usages: IPrepaidUsage[];
    linkedCoupons: any[];
  }> {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    const usages = await PrepaidUsage.find({ affiliateId })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('eventId', 'name eventCode customSlug');

    const linkedCoupons = await Coupon.find({
      affiliateId,
      type: 'affiliate',
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    return {
      balance: affiliate.prepaidBalance || 0,
      used: affiliate.prepaidUsed || 0,
      couponCode: affiliate.prepaidCouponCode,
      usages,
      linkedCoupons,
    };
  }

  async recordPrepaidUsage(input: {
    affiliateId: string;
    eventId: string;
    userId: string;
    couponCode: string;
    eventName: string;
    coupleName?: string;
  }): Promise<void> {
    const affiliate = await Affiliate.findById(input.affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }
    if ((affiliate.prepaidBalance || 0) <= 0) {
      throw new ValidationError('Prepaid balance exhausted');
    }
    affiliate.prepaidBalance = Math.max(0, (affiliate.prepaidBalance || 0) - 1);
    affiliate.prepaidUsed = (affiliate.prepaidUsed || 0) + 1;
    await affiliate.save({ validateModifiedOnly: true });

    await PrepaidUsage.create({
      affiliateId: input.affiliateId,
      eventId: input.eventId,
      userId: input.userId,
      couponCode: input.couponCode,
      eventName: input.eventName,
      coupleName: input.coupleName,
    });

    logger.info(`Prepaid usage recorded for ${affiliate.email}: event ${input.eventId}`);
  }

  async rejectWithdrawal(withdrawalId: string, adminNote?: string): Promise<IWithdrawal> {
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) {
      throw new NotFoundError('Withdrawal');
    }
    if (withdrawal.status !== 'pending') {
      throw new ValidationError('Only pending withdrawals can be rejected');
    }
    withdrawal.status = 'rejected';
    if (adminNote) withdrawal.adminNote = adminNote;
    await withdrawal.save();
    return withdrawal;
  }
}

export const affiliateService = new AffiliateService();
