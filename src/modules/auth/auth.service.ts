import jwt from 'jsonwebtoken';
import { User, IUser } from './user.model';
import { Referral } from '../affiliate/referral.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { Event } from '../events/events.model';
import { eventsService } from '../events/events.service';
import { couponService } from '../coupon/coupon.service';
import { env } from '@/shared/config/env';
import { AppError, NotFoundError, ValidationError } from '@/shared/utils/errors';
import { whatsappService } from '@/shared/services/whatsapp.service';
import { generateOTP, generateReferralCode, formatPhoneNumber, generateCustomSlug, isValidEmail, israeliPhoneCandidates } from '@/shared/utils/helpers';
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
  /**
   * Deliver a login/registration code: email first, WhatsApp as the fallback.
   *
   * The fallback exists because an email outage locks every customer out of
   * their own album. SendGrid ran out of credits on 2026-08-04 and SES is still
   * sandboxed — so no customer address can be delivered to — and this send used
   * to be awaited bare, which threw straight out of loginSendOTP and 500'd the
   * request. A paying couple could not reach the album they had just bought.
   *
   * A phone number is the one contact detail we always have (it IS the login
   * identifier), so WhatsApp is the natural second channel here. It stays off
   * until WATI_API_ENDPOINT/WATI_ACCESS_TOKEN and an approved WATI_OTP_TEMPLATE
   * are set, because WhatsApp only permits pre-approved templates.
   *
   * Throws only when every channel fails, and with a message the guest can act
   * on rather than a generic 500.
   */
  private async deliverOtp(otp: string, to: { email?: string; phoneNumber: string }): Promise<'email' | 'whatsapp'> {
    if (to.email) {
      try {
        await emailService.sendOTPEmail(to.email, otp);
        return 'email';
      } catch (error: any) {
        logger.error(`OTP email failed for ${to.email}: ${error.message}`);
      }
    }

    if (whatsappService.isConfigured && env.WATI_OTP_TEMPLATE) {
      try {
        await whatsappService.sendTemplate({
          to: to.phoneNumber,
          templateName: env.WATI_OTP_TEMPLATE,
          broadcastName: 'login-otp',
          parameters: [{ name: 'code', value: otp }],
        });
        logger.warn(`OTP delivered by WhatsApp to ${to.phoneNumber} (email unavailable)`);
        return 'whatsapp';
      } catch (error: any) {
        logger.error(`OTP WhatsApp failed for ${to.phoneNumber}: ${error.message}`);
      }
    }

    throw new AppError('לא הצלחנו לשלוח את קוד האימות כרגע. נסו שוב בעוד רגע, או פנו אלינו ונפתח לכם גישה.', 503);
  }

  async loginSendOTP(data: LoginSendOTPRequest): Promise<{ success: boolean; message: string }> {
    const phoneNumber = formatPhoneNumber(data.phoneNumber);

    const user = await User.findOne({ phoneNumber });

    if (!user) {
      throw new NotFoundError('User not found. Please register first.');
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    otpStore.set(phoneNumber, { otp, expiresAt });

    const via = await this.deliverOtp(otp, { email: user.email, phoneNumber });

    setTimeout(() => otpStore.delete(phoneNumber), 10 * 60 * 1000);

    return {
      success: true,
      message: via === 'whatsapp' ? 'OTP sent by WhatsApp' : 'OTP sent successfully',
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

    const via = await this.deliverOtp(otp, { email: data.email, phoneNumber });

    setTimeout(() => otpStore.delete(phoneNumber), 10 * 60 * 1000);

    return {
      success: true,
      isNewUser,
      message: via === 'whatsapp' ? 'OTP sent by WhatsApp' : 'OTP sent successfully',
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

    // Without a phone there is no natural key, so every call used to mint a
    // fresh user AND a fresh event. Anyone who refreshed, went back, or retried
    // a failed payment left another shell behind: one couple accumulated seven
    // events (four inside five minutes), and 55 of 94 users were temp_ records.
    // The random suffix on the generated slug meant they never collided, so
    // nothing ever surfaced it.
    //
    // Reuse the couple's own abandoned shell instead. Matching on names + date
    // alone would be too loose — two different couples could share both — so it
    // only ever recycles an event that is UNPAID and has NO photos, i.e. one
    // that demonstrably nobody has used. A real event is never touched.
    let reusedShell = false;
    if (!user && data.partnerName1 && data.partnerName2 && data.weddingDate) {
      const weddingDate = new Date(data.weddingDate);
      const candidates = await User.find({
        phoneNumber: /^temp_/,
        partnerName1: data.partnerName1,
        partnerName2: data.partnerName2,
        weddingDate,
      })
        .sort({ createdAt: -1 })
        .limit(10);

      for (const candidate of candidates) {
        const ev = await Event.findOne({ userId: candidate._id });
        if (!ev) continue;
        if (ev.isPaid || (ev.photoCount ?? 0) > 0) continue;
        user = candidate;
        reusedShell = true;
        logger.info(`registerDirect: reusing abandoned shell ${ev.eventCode} for ${data.partnerName1} & ${data.partnerName2}`);
        break;
      }
    }

    if (user) {
      const existingEvent = await Event.findOne({ userId: user._id });
      // A recycled shell HAS an event — that is the point of recycling it — so
      // this guard would otherwise reject the very case it was added to fix.
      // It still applies to a real returning user, who should log in instead.
      if (existingEvent && !reusedShell) {
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
    // `password` is select:false on the schema, so it has to be asked for by
    // name — without this the check below reads undefined and waves everyone
    // through, which is precisely the bug it exists to prevent.
    const user = await User.findById(userId).select('+password');
    if (!user) {
      throw new NotFoundError('User');
    }

    // Setting the FIRST password is onboarding — the welcome modal collects a
    // password, phone and email in one step and there is nothing to prove yet.
    // Changing an existing one is a different act: it locks the previous owner
    // out, and this route also rewrites the phone number the account is reached
    // by, so it has to cost the current password.
    if (user.password) {
      const matches = data.currentPassword && (await bcrypt.compare(data.currentPassword, user.password));
      if (!matches) {
        throw new ValidationError('הסיסמה הנוכחית שגויה');
      }
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
        // Only confirm a payment that actually happened. An admin-comped event
        // is isPaid with no paymentId, and the old guard mailed the couple a
        // receipt reading "Amount: 0.00 ILS" under a green tick.
        if (paidEvent?.paymentId) {
          const { Payment } = await import('../payment/payment.model');
          const payment = await Payment.findById(paidEvent.paymentId).select('amount').lean();
          await emailService.sendPaymentConfirmationEmail(user.email, paidEvent.name, payment?.amount ?? 0);
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
        // Only confirm a payment that actually happened. An admin-comped event
        // is isPaid with no paymentId, and the old guard mailed the couple a
        // receipt reading "Amount: 0.00 ILS" under a green tick.
        if (paidEvent?.paymentId) {
          const { Payment } = await import('../payment/payment.model');
          const payment = await Payment.findById(paidEvent.paymentId).select('amount').lean();
          await emailService.sendPaymentConfirmationEmail(user.email, paidEvent.name, payment?.amount ?? 0);
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

    // Nothing shorter than a whole number or a whole address can be a real
    // identifier here, and anything shorter is someone probing for accounts.
    // The route has no validate() schema, so this is where that is enforced.
    if (isEmail ? !isValidEmail(id) : id.replace(/\D/g, '').length < 9) {
      throw new NotFoundError('User');
    }
    let user = isEmail
      ? await User.findOne({ email: id.toLowerCase() })
      : await User.findOne({ phoneNumber: { $in: israeliPhoneCandidates(id) } });

    if (!user && !isEmail) {
      // Fallback: match any stored phone that ends with the 9-digit core, so
      // unusual stored formats still resolve (the core is unique per number).
      //
      // The core must be the WHOLE 9 digits. This regex used to be built from
      // whatever digits arrived, unanchored — so an identifier of "7" matched
      // any stored number ending in 7 and handed back that stranger's session.
      // A partial suffix is not "an unusual format", it's an enumeration probe.
      let digits = id.replace(/\D/g, '');
      if (digits.startsWith('972')) digits = digits.slice(3);
      digits = digits.replace(/^0+/, '');
      if (/^\d{9}$/.test(digits)) {
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

export const authService = new AuthService();
