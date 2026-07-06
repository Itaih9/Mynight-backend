import jwt from 'jsonwebtoken';
import { User, IUser } from './user.model';
import { Referral } from '../affiliate/referral.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { Event } from '../events/events.model';
import { eventsService } from '../events/events.service';
import { couponService } from '../coupon/coupon.service';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import { generateOTP, generateReferralCode, formatPhoneNumber, generateCustomSlug } from '@/shared/utils/helpers';
import logger from '@/shared/utils/logger';
import { emailService } from '@/shared/services/email.service';
import bcrypt from 'bcryptjs';
import {
  LoginSendOTPRequest,
  LoginVerifyOTPRequest,
  LoginWithPasswordRequest,
  RegisterSendOTPRequest,
  RegisterVerifyOTPRequest,
  RegisterDirectRequest,
  SetPasswordRequest,
  AuthResponse
} from './auth.types';

const otpStore = new Map<string, { otp: string; expiresAt: Date }>();

class AuthService {
  async loginSendOTP(data: LoginSendOTPRequest): Promise<{ success: boolean; message: string }> {
    const phoneNumber = formatPhoneNumber(data.phoneNumber);

    const user = await User.findOne({ phoneNumber });

    if (!user) {
      throw new NotFoundError('User not found. Please register first.');
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    otpStore.set(phoneNumber, { otp, expiresAt });

    if (user.email) {
      await emailService.sendOTPEmail(user.email, otp);
    }

    setTimeout(() => otpStore.delete(phoneNumber), 10 * 60 * 1000);

    return {
      success: true,
      message: 'OTP sent successfully',
    };
  }

  async loginVerifyOTP(data: LoginVerifyOTPRequest): Promise<AuthResponse> {
    const phoneNumber = formatPhoneNumber(data.phoneNumber);

    const storedOTP = otpStore.get(phoneNumber);

    if (!storedOTP) {
      throw new ValidationError('OTP expired or not found');
    }

    if (storedOTP.expiresAt < new Date()) {
      otpStore.delete(phoneNumber);
      throw new ValidationError('OTP expired');
    }

    if (storedOTP.otp !== data.otp) {
      throw new ValidationError('Invalid OTP');
    }

    otpStore.delete(phoneNumber);

    const user = await User.findOne({ phoneNumber });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    const token = this.generateToken(user._id.toString());

    const userEvent = await Event.findOne({ userId: user._id }).sort({ createdAt: -1 });

    const response: AuthResponse = {
      user: {
        id: user._id.toString(),
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
        partnerName1: user.partnerName1,
        partnerName2: user.partnerName2,
        weddingDate: user.weddingDate?.toISOString(),
        referralCode: user.referralCode,
      },
      token,
    };

    if (userEvent) {
      response.event = {
        id: userEvent._id.toString(),
        eventCode: userEvent.eventCode,
        customSlug: userEvent.customSlug,
        isPaid: userEvent.isPaid,
        packageName: userEvent.packageName,
        sharingPermissions: userEvent.sharingPermissions,
      };
    }

    return response;
  }

  async loginWithPassword(data: LoginWithPasswordRequest): Promise<AuthResponse> {
    let user;
    if (data.email) {
      user = await User.findOne({ email: data.email.toLowerCase().trim() }).select('+password');
    } else {
      const phoneNumber = formatPhoneNumber(data.phoneNumber!);
      user = await User.findOne({ phoneNumber }).select('+password');
    }

    if (!user) {
      throw new NotFoundError('User not found. Please register first.');
    }

    const isValidPassword = user.password && await bcrypt.compare(data.password, user.password);

    if (!isValidPassword) {
      throw new ValidationError('Invalid password');
    }

    const token = this.generateToken(user._id.toString());

    const userEvent = await Event.findOne({ userId: user._id }).sort({ createdAt: -1 });

    const response: AuthResponse = {
      user: {
        id: user._id.toString(),
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
        partnerName1: user.partnerName1,
        partnerName2: user.partnerName2,
        weddingDate: user.weddingDate?.toISOString(),
        referralCode: user.referralCode,
      },
      token,
    };

    if (userEvent) {
      response.event = {
        id: userEvent._id.toString(),
        eventCode: userEvent.eventCode,
        customSlug: userEvent.customSlug,
        isPaid: userEvent.isPaid,
        packageName: userEvent.packageName,
        sharingPermissions: userEvent.sharingPermissions,
      };
    }

    return response;
  }

  async registerSendOTP(data: RegisterSendOTPRequest): Promise<{ success: boolean; message: string; isNewUser: boolean }> {
    const phoneNumber = formatPhoneNumber(data.phoneNumber);

    let user = await User.findOne({ phoneNumber });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const referralCode = generateReferralCode();
      user = await User.create({
        phoneNumber,
        referralCode,
        referredBy: data.referralCode,
      });

      if (data.referralCode) {
        const affiliate = await Affiliate.findOne({
          referralCode: data.referralCode.toUpperCase(),
          status: 'approved'
        });
        if (affiliate) {
          await Referral.create({
            affiliateId: affiliate._id,
            referredUserId: user._id,
            referralCode: data.referralCode.toUpperCase(),
          });
          await Affiliate.findByIdAndUpdate(affiliate._id, {
            $inc: { totalReferrals: 1 }
          });
          logger.info(`Referral tracked: user ${user._id} referred by affiliate ${affiliate._id}`);
        }
      }
    } else {
      const existingEvent = await Event.findOne({ userId: user._id });
      if (existingEvent) {
        throw new ValidationError('User already registered. Please login instead.');
      }
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    otpStore.set(phoneNumber, { otp, expiresAt });

    if (data.email) {
      await emailService.sendOTPEmail(data.email, otp);
    }

    setTimeout(() => otpStore.delete(phoneNumber), 10 * 60 * 1000);

    return {
      success: true,
      isNewUser,
      message: 'OTP sent successfully',
    };
  }

  async registerVerifyOTP(data: RegisterVerifyOTPRequest): Promise<AuthResponse> {
    const phoneNumber = formatPhoneNumber(data.phoneNumber);

    const storedOTP = otpStore.get(phoneNumber);

    if (!storedOTP) {
      throw new ValidationError('OTP expired or not found');
    }

    if (storedOTP.expiresAt < new Date()) {
      otpStore.delete(phoneNumber);
      throw new ValidationError('OTP expired');
    }

    if (storedOTP.otp !== data.otp) {
      throw new ValidationError('Invalid OTP');
    }

    otpStore.delete(phoneNumber);

    let user = await User.findOne({ phoneNumber });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    user = await User.findByIdAndUpdate(
      user._id,
      {
        partnerName1: data.partnerName1,
        partnerName2: data.partnerName2,
        weddingDate: new Date(data.weddingDate),
      },
      { new: true }
    );

    const token = this.generateToken(user!._id.toString());

    let userEvent = await Event.findOne({ userId: user!._id });

    if (!userEvent) {
      const eventName = `${data.partnerName1} & ${data.partnerName2}`;
      const weddingDate = new Date(data.weddingDate);
      const customSlug = generateCustomSlug(data.partnerName1, data.partnerName2, weddingDate);

      userEvent = await eventsService.createEventWithSlug(
        user!._id.toString(),
        eventName,
        customSlug,
        weddingDate,
        data.packageName
      ) as any;

      logger.info(`Event created for user ${user!._id}: ${userEvent!.eventCode}`);

      try {
        await couponService.getOrCreatePersonal(user!._id.toString());
      } catch (err: any) {
        logger.warn(`Personal coupon creation failed for ${user!._id}: ${err.message}`);
      }

      if (user!.email) {
        try {
          await emailService.sendWelcomeEmail(user!.email, user!.name || user!.partnerName1);
        } catch (err: any) {
          logger.warn(`Welcome email failed for ${user!.email}: ${err.message}`);
        }
      }
    }

    const response: AuthResponse = {
      user: {
        id: user!._id.toString(),
        phoneNumber: user!.phoneNumber,
        name: user!.name,
        email: user!.email,
        partnerName1: user!.partnerName1,
        partnerName2: user!.partnerName2,
        weddingDate: user!.weddingDate?.toISOString(),
        referralCode: user!.referralCode,
      },
      token,
    };

    if (userEvent) {
      response.event = {
        id: userEvent._id.toString(),
        eventCode: userEvent.eventCode,
        customSlug: userEvent.customSlug,
        isPaid: userEvent.isPaid,
        packageName: userEvent.packageName,
        sharingPermissions: userEvent.sharingPermissions,
      };
    }

    return response;
  }

  async registerDirect(data: RegisterDirectRequest): Promise<AuthResponse> {
    const phoneNumber = data.phoneNumber
      ? formatPhoneNumber(data.phoneNumber)
      : `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let user = data.phoneNumber ? await User.findOne({ phoneNumber }) : null;

    if (user) {
      const existingEvent = await Event.findOne({ userId: user._id });
      if (existingEvent) {
        throw new ValidationError('User already registered. Please login instead.');
      }
      user = await User.findByIdAndUpdate(
        user._id,
        {
          partnerName1: data.partnerName1,
          partnerName2: data.partnerName2,
          weddingDate: new Date(data.weddingDate),
        },
        { new: true }
      );
    } else {
      const referralCode = generateReferralCode();
      user = await User.create({
        phoneNumber,
        referralCode,
        referredBy: data.referralCode,
        partnerName1: data.partnerName1,
        partnerName2: data.partnerName2,
        weddingDate: new Date(data.weddingDate),
      });

      if (data.referralCode) {
        const affiliate = await Affiliate.findOne({
          referralCode: data.referralCode.toUpperCase(),
          status: 'approved'
        });
        if (affiliate) {
          await Referral.create({
            affiliateId: affiliate._id,
            referredUserId: user._id,
            referralCode: data.referralCode.toUpperCase(),
          });
          await Affiliate.findByIdAndUpdate(affiliate._id, {
            $inc: { totalReferrals: 1 }
          });
          logger.info(`Referral tracked: user ${user._id} referred by affiliate ${affiliate._id}`);
        }
      }
    }

    const token = this.generateToken(user!._id.toString());

    let userEvent = await Event.findOne({ userId: user!._id });

    if (!userEvent) {
      const eventName = `${data.partnerName1} & ${data.partnerName2}`;
      const weddingDate = new Date(data.weddingDate);
      const customSlug = generateCustomSlug(data.partnerName1, data.partnerName2, weddingDate);

      userEvent = await eventsService.createEventWithSlug(
        user!._id.toString(),
        eventName,
        customSlug,
        weddingDate,
        data.packageName
      ) as any;

      logger.info(`Event created for user ${user!._id}: ${userEvent!.eventCode}`);

      try {
        await couponService.getOrCreatePersonal(user!._id.toString());
      } catch (err: any) {
        logger.warn(`Personal coupon creation failed for ${user!._id}: ${err.message}`);
      }

      if (user!.email) {
        try {
          await emailService.sendWelcomeEmail(user!.email, user!.name || user!.partnerName1);
        } catch (err: any) {
          logger.warn(`Welcome email failed for ${user!.email}: ${err.message}`);
        }
      }
    }

    const response: AuthResponse = {
      user: {
        id: user!._id.toString(),
        phoneNumber: user!.phoneNumber,
        name: user!.name,
        email: user!.email,
        partnerName1: user!.partnerName1,
        partnerName2: user!.partnerName2,
        weddingDate: user!.weddingDate?.toISOString(),
        referralCode: user!.referralCode,
      },
      token,
    };

    if (userEvent) {
      response.event = {
        id: userEvent._id.toString(),
        eventCode: userEvent.eventCode,
        customSlug: userEvent.customSlug,
        isPaid: userEvent.isPaid,
        packageName: userEvent.packageName,
        sharingPermissions: userEvent.sharingPermissions,
      };
    }

    return response;
  }

  async setPassword(userId: string, data: SetPasswordRequest): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const hadEmailBefore = Boolean(user.email);

    user.password = data.password;

    if (data.phoneNumber) {
      const formatted = formatPhoneNumber(data.phoneNumber);
      const existing = await User.findOne({ phoneNumber: formatted, _id: { $ne: userId } });
      if (existing) {
        throw new ValidationError('Phone number already in use');
      }
      user.phoneNumber = formatted;
    }

    if (data.email) {
      user.email = data.email.trim().toLowerCase();
    }

    await user.save();
    logger.info(`Password set for user ${userId}`);

    const displayName = user.name || user.partnerName1;

    if (user.email && !hadEmailBefore) {
      try {
        await emailService.sendWelcomeEmail(user.email, displayName);
      } catch (err: any) {
        logger.warn(`Welcome email failed for ${user.email}: ${err.message}`);
      }

      try {
        const paidEvent = await Event.findOne({ userId, isPaid: true }).select('name paymentId').lean();
        if (paidEvent) {
          let amount = 0;
          if (paidEvent.paymentId) {
            const { Payment } = await import('../payment/payment.model');
            const payment = await Payment.findById(paidEvent.paymentId).select('amount').lean();
            amount = payment?.amount ?? 0;
          }
          await emailService.sendPaymentConfirmationEmail(user.email, paidEvent.name, amount);
        }
      } catch (err: any) {
        logger.warn(`Payment confirmation backfill failed for ${user.email}: ${err.message}`);
      }
    }

    if (user.email) {
      try {
        await emailService.sendPasswordConfirmationEmail(user.email, displayName);
      } catch (err) {
        logger.warn(`Failed to send password confirmation email to ${user.email}: ${err}`);
      }
    }

    return user;
  }

  async getProfile(userId: string): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User');
    }
    return user;
  }

  async updateProfile(userId: string, updates: { name?: string; email?: string; partnerName1?: string; partnerName2?: string; weddingDate?: string; phoneNumber?: string }): Promise<IUser> {
    if (updates.phoneNumber) {
      const existing = await User.findOne({ phoneNumber: updates.phoneNumber, _id: { $ne: userId } });
      if (existing) {
        throw new Error('Phone number already in use');
      }
    }

    const before = await User.findById(userId);
    if (!before) {
      throw new NotFoundError('User');
    }
    const hadEmailBefore = Boolean(before.email);

    const user = await User.findByIdAndUpdate(userId, updates, { new: true });
    if (!user) {
      throw new NotFoundError('User');
    }

    if (updates.weddingDate) {
      const newDate = new Date(updates.weddingDate);
      if (!isNaN(newDate.getTime())) {
        await Event.updateMany({ userId }, { weddingDate: newDate });
        logger.info(`Synced weddingDate ${newDate.toISOString()} to events for user ${userId} (expiry untouched)`);
      }
    }

    const partnerNameChanged =
      (typeof updates.partnerName1 === 'string' && updates.partnerName1 !== before.partnerName1) ||
      (typeof updates.partnerName2 === 'string' && updates.partnerName2 !== before.partnerName2);

    if (partnerNameChanged) {
      const p1 = (user.partnerName1 || '').trim();
      const p2 = (user.partnerName2 || '').trim();
      const newEventName = [p1, p2].filter(Boolean).join(' & ');
      if (newEventName) {
        await Event.updateMany({ userId }, { name: newEventName });
        logger.info(`Synced event name "${newEventName}" to events for user ${userId} (slug untouched)`);
      }
    }

    if (!hadEmailBefore && user.email) {
      const displayName = user.name || user.partnerName1;
      try {
        await emailService.sendWelcomeEmail(user.email, displayName);
      } catch (err: any) {
        logger.warn(`Welcome email failed for ${user.email}: ${err.message}`);
      }

      try {
        const paidEvent = await Event.findOne({ userId, isPaid: true }).select('name paymentId').lean();
        if (paidEvent) {
          let amount = 0;
          if (paidEvent.paymentId) {
            const { Payment } = await import('../payment/payment.model');
            const payment = await Payment.findById(paidEvent.paymentId).select('amount').lean();
            amount = payment?.amount ?? 0;
          }
          await emailService.sendPaymentConfirmationEmail(user.email, paidEvent.name, amount);
        }
      } catch (err: any) {
        logger.warn(`Backfill payment confirmation email failed for ${user.email}: ${err.message}`);
      }
    }

    return user;
  }

  /**
   * Direct login by identifier only (no OTP/password) — used by the couple
   * gallery-login screen/link to drop into a couple's own gallery view. The
   * identifier is a phone number or an email. Israeli numbers are matched
   * flexibly: 0XXXXXXXXX, +972XXXXXXXXX and +9720XXXXXXXXX (and bare variants)
   * all resolve to the same account, regardless of how the stored phone is
   * formatted.
   */
  async loginByIdentifier(identifier: string): Promise<AuthResponse> {
    const id = (identifier || '').trim();
    const isEmail = id.includes('@');
    let user = isEmail
      ? await User.findOne({ email: id.toLowerCase() })
      : await User.findOne({ phoneNumber: { $in: israeliPhoneCandidates(id) } });

    if (!user && !isEmail) {
      // Fallback: match any stored phone that ends with the 9-digit core, so
      // unusual stored formats still resolve (the core is unique per number).
      let digits = id.replace(/\D/g, '');
      if (digits.startsWith('972')) digits = digits.slice(3);
      digits = digits.replace(/^0+/, '');
      if (digits) {
        user = await User.findOne({ phoneNumber: new RegExp(`${digits}$`) });
      }
    }

    if (!user) {
      logger.warn(`Gallery-login: no account for identifier "${id}"`);
      throw new NotFoundError('User');
    }

    // Scope the token to the gallery so it can't reach the event-management page.
    const token = this.generateToken(user._id.toString(), 'gallery');
    const userEvent = await Event.findOne({ userId: user._id }).sort({ createdAt: -1 });

    const response: AuthResponse = {
      user: {
        id: user._id.toString(),
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
        partnerName1: user.partnerName1,
        partnerName2: user.partnerName2,
        weddingDate: user.weddingDate?.toISOString(),
        referralCode: user.referralCode,
      },
      token,
    };

    if (userEvent) {
      response.event = {
        id: userEvent._id.toString(),
        eventCode: userEvent.eventCode,
        customSlug: userEvent.customSlug,
        isPaid: userEvent.isPaid,
        packageName: userEvent.packageName,
        sharingPermissions: userEvent.sharingPermissions,
      };
    }

    logger.info(`Phone-login for user ${user._id} (${user.phoneNumber})`);
    return response;
  }

  private generateToken(userId: string, scope?: string): string {
    const payload: Record<string, unknown> = { userId };
    if (scope) payload.scope = scope;
    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as string,
    } as jwt.SignOptions);
  }
}

/**
 * All plausible stored formats of an Israeli phone number, derived from any
 * input. Stored numbers are `+` + digits (see formatPhoneNumber), and the digits
 * vary by how the user typed it (local 0-prefixed, +972, or +9720). We reduce
 * the input to its 9-digit core and expand back to every stored variant.
 */
function israeliPhoneCandidates(raw: string): string[] {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  const core = d;
  if (!core) return [];
  return Array.from(new Set([
    `+972${core}`,
    `+9720${core}`,
    `+0${core}`,
    `+${core}`,
    `972${core}`,
    `0${core}`,
    core,
  ]));
}

export const authService = new AuthService();
