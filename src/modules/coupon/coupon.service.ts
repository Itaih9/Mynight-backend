import { Coupon, ICoupon } from './coupon.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { customAlphabet } from 'nanoid';

const PERSONAL_COUPON_DISCOUNT_AMOUNT = 100;
const PERSONAL_COUPON_MAX_USES = 3;
const personalCodeNano = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

interface CreateCouponData {
  code: string;
  discountPercent: number;
  maxUses?: number;
  expiresAt?: Date;
  affiliateId?: string;
  type?: 'standard' | 'affiliate' | 'prepaid';
}

interface ValidateCouponResult {
  valid: boolean;
  coupon?: ICoupon;
  discountPercent?: number;
  discountAmount?: number;
  message: string;
}

class CouponService {
  async create(data: CreateCouponData, userId?: string): Promise<ICoupon> {
    const existingCoupon = await Coupon.findOne({ code: data.code.toUpperCase() });
    if (existingCoupon) {
      throw new ValidationError('Coupon code already exists');
    }

    if (data.affiliateId) {
      const affiliate = await Affiliate.findById(data.affiliateId);
      if (!affiliate) {
        throw new ValidationError('Affiliate not found');
      }
    }

    const coupon = await Coupon.create({
      code: data.code.toUpperCase(),
      discountPercent: data.discountPercent,
      maxUses: data.maxUses || 0,
      expiresAt: data.expiresAt,
      createdBy: userId,
      affiliateId: data.affiliateId,
      type: data.type || (data.affiliateId ? 'affiliate' : 'standard'),
    });

    logger.info(`Coupon created: ${coupon.code} (${coupon.type}) with ${coupon.discountPercent}% discount`);
    return coupon;
  }

  async validate(code: string): Promise<ValidateCouponResult> {
    const coupon = await Coupon.findOne({ code: code.toUpperCase() });

    if (!coupon) {
      return { valid: false, message: 'Invalid coupon code' };
    }

    if (!coupon.isActive) {
      return { valid: false, message: 'Coupon is no longer active' };
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return { valid: false, message: 'Coupon has expired' };
    }

    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) {
      return { valid: false, message: 'Coupon usage limit reached' };
    }

    if (coupon.type === 'prepaid' && coupon.affiliateId) {
      const affiliate = await Affiliate.findById(coupon.affiliateId);
      if (!affiliate || (affiliate.prepaidBalance || 0) <= 0) {
        return { valid: false, message: 'Prepaid coupon balance exhausted' };
      }
    }

    const message = coupon.discountAmount && coupon.discountAmount > 0
      ? `${coupon.discountAmount} NIS discount applied`
      : `${coupon.discountPercent}% discount applied`;

    return {
      valid: true,
      coupon,
      discountPercent: coupon.discountPercent,
      discountAmount: coupon.discountAmount,
      message,
    };
  }

  async getOrCreatePersonal(userId: string): Promise<ICoupon> {
    let coupon = await Coupon.findOne({ ownerUserId: userId, type: 'personal' });
    if (coupon) return coupon;

    let code = '';
    let attempts = 0;
    while (attempts < 10) {
      code = `MYNIGHT-${personalCodeNano()}`;
      const existing = await Coupon.findOne({ code });
      if (!existing) break;
      attempts++;
    }
    if (attempts >= 10) {
      throw new Error('Failed to generate unique personal coupon code');
    }

    coupon = await Coupon.create({
      code,
      discountPercent: 0,
      discountAmount: PERSONAL_COUPON_DISCOUNT_AMOUNT,
      maxUses: PERSONAL_COUPON_MAX_USES,
      ownerUserId: userId,
      type: 'personal',
      isActive: true,
    });

    logger.info(`Personal coupon created: ${coupon.code} for user ${userId}`);
    return coupon;
  }

  async use(code: string): Promise<ICoupon> {
    const coupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (!coupon) {
      throw new NotFoundError('Coupon');
    }

    coupon.usedCount += 1;
    await coupon.save();

    logger.info(`Coupon used: ${coupon.code}, total uses: ${coupon.usedCount}`);
    return coupon;
  }

  async getAll(): Promise<ICoupon[]> {
    return Coupon.find().sort({ createdAt: -1 });
  }

  async getActiveStandard(): Promise<Pick<ICoupon, 'code' | 'discountPercent'> | null> {
    const coupon = await Coupon.findOne({
      isActive: true,
      affiliateId: { $in: [null, undefined] },
      $or: [{ type: 'standard' }, { type: { $exists: false } }],
    })
      .sort({ createdAt: -1 })
      .select('code discountPercent')
      .lean();

    if (!coupon) return null;
    return { code: coupon.code, discountPercent: coupon.discountPercent };
  }

  async deactivate(couponId: string): Promise<ICoupon> {
    const coupon = await Coupon.findByIdAndUpdate(
      couponId,
      { isActive: false },
      { new: true }
    );
    if (!coupon) {
      throw new NotFoundError('Coupon');
    }
    return coupon;
  }
}

export const couponService = new CouponService();
