import { Coupon, ICoupon } from './coupon.model';
import { CouponDefaults, ICouponDefaults } from './couponDefaults.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { customAlphabet } from 'nanoid';

const PERSONAL_COUPON_DISCOUNT_AMOUNT = 100;
const PERSONAL_COUPON_MAX_USES = 3;
const personalCodeNano = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const giftCodeNano = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

interface CreateCouponData {
  code: string;
  discountPercent: number;
  discountAmount?: number;
  maxUses?: number;
  expiresAt?: Date;
  affiliateId?: string;
  type?: 'standard' | 'affiliate' | 'prepaid';
  packageName?: string;
}

interface EventCouponDefaultsInput {
  discountType?: 'percent' | 'fixed';
  discountValue?: number;
  maxUses?: number;
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
      discountAmount: data.discountAmount,
      maxUses: data.maxUses || 0,
      expiresAt: data.expiresAt,
      createdBy: userId,
      affiliateId: data.affiliateId,
      type: data.type || (data.affiliateId ? 'affiliate' : 'standard'),
      packageName: data.packageName || undefined,
    });

    logger.info(`Coupon created: ${coupon.code} (${coupon.type}) with ${coupon.discountPercent}% discount`);
    return coupon;
  }

  async validate(code: string, packageName?: string): Promise<ValidateCouponResult> {
    const coupon = await Coupon.findOne({ code: code.toUpperCase() });

    if (!coupon) {
      return { valid: false, message: 'Invalid coupon code' };
    }

    if (!coupon.isActive) {
      return { valid: false, message: 'Coupon is no longer active' };
    }

    // Package-restricted coupon: only valid for its package.
    if (coupon.packageName && coupon.packageName !== packageName) {
      return { valid: false, message: 'הקופון תקף לחבילה אחרת בלבד' };
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

  // ---- Per-event gift coupons + editable defaults ----

  async getEventDefaults(): Promise<ICouponDefaults> {
    let defaults = await CouponDefaults.findOne({ key: 'event-coupon' });
    if (!defaults) {
      defaults = await CouponDefaults.create({ key: 'event-coupon' });
    }
    return defaults;
  }

  async updateEventDefaults(data: EventCouponDefaultsInput): Promise<ICouponDefaults> {
    const defaults = await this.getEventDefaults();
    if (data.discountType !== undefined) {
      if (data.discountType !== 'percent' && data.discountType !== 'fixed') {
        throw new ValidationError('discountType must be "percent" or "fixed"');
      }
      defaults.discountType = data.discountType;
    }
    if (data.discountValue !== undefined) {
      if (typeof data.discountValue !== 'number' || data.discountValue < 0) {
        throw new ValidationError('discountValue must be a positive number');
      }
      if (defaults.discountType === 'percent' && data.discountValue > 100) {
        throw new ValidationError('Percentage discount cannot exceed 100');
      }
      defaults.discountValue = data.discountValue;
    }
    if (data.maxUses !== undefined) {
      if (typeof data.maxUses !== 'number' || data.maxUses < 0) {
        throw new ValidationError('maxUses must be 0 or more');
      }
      defaults.maxUses = data.maxUses;
    }
    await defaults.save();
    return defaults;
  }

  private discountFromDefaults(defaults: Pick<ICouponDefaults, 'discountType' | 'discountValue'>) {
    return defaults.discountType === 'fixed'
      ? { discountPercent: 0, discountAmount: defaults.discountValue }
      : { discountPercent: defaults.discountValue, discountAmount: 0 };
  }

  async getOrCreateEventCoupon(eventId: string): Promise<ICoupon> {
    const existing = await Coupon.findOne({ ownerEventId: eventId, type: 'event' });
    if (existing) return existing;

    const defaults = await this.getEventDefaults();

    let code = '';
    let attempts = 0;
    while (attempts < 10) {
      code = `GIFT-${giftCodeNano()}`;
      const clash = await Coupon.findOne({ code });
      if (!clash) break;
      attempts++;
    }
    if (attempts >= 10) {
      throw new Error('Failed to generate unique event coupon code');
    }

    const discount = this.discountFromDefaults(defaults);
    const coupon = await Coupon.create({
      code,
      discountPercent: discount.discountPercent,
      discountAmount: discount.discountAmount,
      maxUses: defaults.maxUses,
      ownerEventId: eventId,
      type: 'event',
      isActive: true,
      customized: false,
    });

    logger.info(`Event gift coupon created: ${code} for event ${eventId}`);
    return coupon;
  }

  /**
   * A one-time fixed-ILS coupon bought as a gift. packageName restricts it to a
   * single package (a full-package gift lands the couple at ₪0); left empty it
   * works on any package as a plain gift-card of `amount` ILS.
   */
  async createGiftCoupon(amount: number, packageName?: string): Promise<ICoupon> {
    let code = '';
    let attempts = 0;
    while (attempts < 10) {
      code = `GIFT-${giftCodeNano()}`;
      const clash = await Coupon.findOne({ code });
      if (!clash) break;
      attempts++;
    }
    if (attempts >= 10) throw new Error('Failed to generate unique gift coupon code');

    const coupon = await Coupon.create({
      code,
      discountPercent: 0,
      discountAmount: amount,
      maxUses: 1,
      packageName: packageName || undefined,
      type: 'gift',
      isActive: true,
    });
    logger.info(`Gift coupon created: ${code} (₪${amount}${packageName ? `, ${packageName}` : ''})`);
    return coupon;
  }

  async getEventCoupon(eventId: string): Promise<ICoupon | null> {
    return Coupon.findOne({ ownerEventId: eventId, type: 'event' });
  }

  async updateEventCoupon(
    couponId: string,
    data: EventCouponDefaultsInput & { isActive?: boolean }
  ): Promise<ICoupon> {
    const coupon = await Coupon.findById(couponId);
    if (!coupon) {
      throw new NotFoundError('Coupon');
    }
    if (data.discountType !== undefined && data.discountValue !== undefined) {
      const discount = this.discountFromDefaults({ discountType: data.discountType, discountValue: data.discountValue });
      coupon.discountPercent = discount.discountPercent;
      coupon.discountAmount = discount.discountAmount;
    }
    if (data.maxUses !== undefined) coupon.maxUses = data.maxUses;
    if (data.isActive !== undefined) coupon.isActive = data.isActive;
    coupon.customized = true;
    await coupon.save();
    return coupon;
  }

  // Apply the current defaults to existing event coupons, skipping any that were
  // individually customized or have already been redeemed.
  async applyDefaultsToExisting(): Promise<{ updated: number }> {
    const defaults = await this.getEventDefaults();
    const discount = this.discountFromDefaults(defaults);
    const result = await Coupon.updateMany(
      { type: 'event', customized: { $ne: true }, usedCount: { $lte: 0 } },
      {
        $set: {
          discountPercent: discount.discountPercent,
          discountAmount: discount.discountAmount,
          maxUses: defaults.maxUses,
        },
      }
    );
    const updated = (result as { modifiedCount?: number }).modifiedCount ?? 0;
    logger.info(`Applied event coupon defaults to ${updated} existing coupons`);
    return { updated };
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
