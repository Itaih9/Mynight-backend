import jwt from 'jsonwebtoken';
import { Admin, IAdmin } from './admin.model';
import { User } from '../auth/user.model';
import { Event } from '../events/events.model';
import { Coupon } from '../coupon/coupon.model';
import { couponService } from '../coupon/coupon.service';
import { Referral } from '../affiliate/referral.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { Withdrawal } from '../affiliate/withdrawal.model';
import { Contact } from '../contact/contact.model';
import { Photo, IPhoto } from '../photos/photos.model';
import { Payment } from '../payment/payment.model';
import { ZipJob } from './zipjob.model';
import { rekognitionService } from '../rekognition/rekognition.service';
import { collectPhotoFaceIds, displayUrlFor, categoryFromPath } from '../photos/photos.service';
import { eventsService } from '../events/events.service';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';
import { nanoid } from 'nanoid';
import unzipper from 'unzipper';
import * as XLSX from 'xlsx';

const adminOtpStore = new Map<string, { otp: string; expiresAt: Date }>();

class AdminService {
  private async getExistingVideoPosterUrl(s3Key: string, mimeType?: string): Promise<string | undefined> {
    if (!mimeType?.startsWith('video/')) return undefined;

    const posterKey = `${s3Key}-poster.jpg`;
    try {
      await s3.headObject({ Bucket: env.S3_BUCKET_NAME, Key: posterKey }).promise();
      return `${env.CLOUDFRONT_URL}/${posterKey}`;
    } catch {
      return undefined;
    }
  }

  async login(email: string, password: string): Promise<{ email: string }> {
    const admin = await Admin.findOne({ email: email.toLowerCase(), isActive: true });
    if (!admin) {
      throw new ValidationError('Invalid email or password');
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      throw new ValidationError('Invalid email or password');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    adminOtpStore.set(email.toLowerCase(), { otp, expiresAt });
    setTimeout(() => adminOtpStore.delete(email.toLowerCase()), 10 * 60 * 1000);

    const { emailService } = await import('@/shared/services/email.service');
    await emailService.sendOTPEmail(admin.email, otp);

    return { email: admin.email };
  }

  async verifyOtp(email: string, otp: string): Promise<{ admin: IAdmin; token: string }> {
    const key = email.toLowerCase();
    const entry = adminOtpStore.get(key);
    if (!entry) {
      throw new ValidationError('OTP expired or not requested');
    }
    if (entry.expiresAt < new Date()) {
      adminOtpStore.delete(key);
      throw new ValidationError('OTP expired');
    }
    if (entry.otp !== otp.trim()) {
      throw new ValidationError('Invalid OTP');
    }

    adminOtpStore.delete(key);

    const admin = await Admin.findOne({ email: key, isActive: true });
    if (!admin) {
      throw new ValidationError('Admin not found');
    }

    const token = jwt.sign(
      { adminId: admin._id, email: admin.email, role: 'admin' },
      env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info(`Admin logged in via OTP: ${email}`);

    return { admin, token };
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new ValidationError('New password must be at least 8 characters');
    }

    const admin = await Admin.findById(adminId);
    if (!admin || !admin.isActive) {
      throw new ValidationError('Admin not found');
    }

    const isMatch = await admin.comparePassword(currentPassword);
    if (!isMatch) {
      throw new ValidationError('Current password is incorrect');
    }

    admin.password = newPassword;
    await admin.save();

    logger.info(`Admin password changed for ${admin.email}`);

    try {
      const { emailService } = await import('@/shared/services/email.service');
      await emailService.sendPasswordConfirmationEmail(admin.email, admin.name);
    } catch (err: any) {
      logger.warn(`Password confirmation email failed for ${admin.email}: ${err.message}`);
    }
  }

  async listAdmins() {
    return Admin.find()
      .select('_id email name isActive createdAt')
      .sort({ createdAt: 1 })
      .lean();
  }

  async createAdmin(data: { email: string; password: string; name: string }) {
    const email = (data.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      throw new ValidationError('A valid email is required');
    }
    if (!data.name?.trim()) {
      throw new ValidationError('Name is required');
    }
    if (!data.password || data.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      throw new ValidationError('An admin with that email already exists');
    }

    // The model's pre-save hook hashes the password.
    const admin = await Admin.create({ email, password: data.password, name: data.name.trim() });
    logger.info(`Admin created: ${admin.email}`);

    return { _id: admin._id, email: admin.email, name: admin.name, isActive: admin.isActive, createdAt: admin.createdAt };
  }

  async setAdminActive(adminId: string, isActive: boolean, actingAdminId: string) {
    if (adminId === actingAdminId && !isActive) {
      throw new ValidationError('You cannot deactivate yourself');
    }

    const admin = await Admin.findById(adminId);
    if (!admin) {
      throw new NotFoundError('Admin');
    }

    // Never leave the panel with no way in.
    if (!isActive) {
      const activeCount = await Admin.countDocuments({ isActive: true });
      if (activeCount <= 1) {
        throw new ValidationError('Cannot deactivate the last active admin');
      }
    }

    admin.isActive = isActive;
    await admin.save();
    logger.info(`Admin ${admin.email} ${isActive ? 'activated' : 'deactivated'}`);

    return { _id: admin._id, email: admin.email, name: admin.name, isActive: admin.isActive };
  }

  async deleteAdmin(adminId: string, actingAdminId: string) {
    if (adminId === actingAdminId) {
      throw new ValidationError('You cannot delete yourself');
    }

    const admin = await Admin.findById(adminId);
    if (!admin) {
      throw new NotFoundError('Admin');
    }

    const activeCount = await Admin.countDocuments({ isActive: true });
    if (admin.isActive && activeCount <= 1) {
      throw new ValidationError('Cannot delete the last active admin');
    }

    await admin.deleteOne();
    logger.info(`Admin deleted: ${admin.email}`);

    return { deleted: true };
  }

  async getUsers(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find()
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getEvents(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      Event.find()
        .populate('userId', 'name phoneNumber email referredBy')
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Event.countDocuments(),
    ]);

    const referralCodes = Array.from(new Set(
      events
        .map((e: any) => e.userId?.referredBy)
        .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        .map((c: string) => c.toUpperCase())
    ));

    const paymentIds = events
      .map((e: any) => e.paymentId)
      .filter((id: any) => !!id);

    const [affiliates, payments] = await Promise.all([
      referralCodes.length
        ? Affiliate.find({ referralCode: { $in: referralCodes } }).select('name email referralCode').lean()
        : Promise.resolve([]),
      paymentIds.length
        ? Payment.find({ _id: { $in: paymentIds } }).select('metadata provider').lean()
        : Promise.resolve([]),
    ]);

    const affiliateByCode = new Map<string, any>(
      (affiliates as any[]).map((a) => [String(a.referralCode).toUpperCase(), a])
    );
    const paymentById = new Map<string, any>(
      (payments as any[]).map((p) => [String(p._id), p])
    );

    const enriched = (events as any[]).map((e) => {
      const code = e.userId?.referredBy ? String(e.userId.referredBy).toUpperCase() : null;
      const affiliate = code ? affiliateByCode.get(code) : null;
      const payment = e.paymentId ? paymentById.get(String(e.paymentId)) : null;
      const couponCode = payment?.metadata?.couponCode || null;

      return {
        ...e,
        referredByAffiliate: affiliate
          ? { name: affiliate.name, email: affiliate.email, referralCode: affiliate.referralCode }
          : null,
        couponCode,
      };
    });

    return {
      events: enriched,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getCoupons(page: number = 1, limit: number = 20, filter: 'mine' | 'auto' | 'all' = 'mine') {
    const skip = (page - 1) * limit;

    // "mine" = coupons an admin created; "auto" = per-user/per-event coupons the
    // system generates for couples. Default stays "mine" so the existing view is
    // unchanged (it previously excluded only 'event').
    const ADMIN_TYPES = ['standard', 'affiliate', 'prepaid'];
    const AUTO_TYPES = ['personal', 'event'];
    const query =
      filter === 'auto'
        ? { type: { $in: AUTO_TYPES } }
        : filter === 'all'
        ? {}
        : { type: { $in: ADMIN_TYPES } };

    const [coupons, total] = await Promise.all([
      Coupon.find(query)
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Coupon.countDocuments(query),
    ]);

    const ownerIds = Array.from(
      new Set(coupons.map((c: any) => c.ownerUserId).filter(Boolean).map((id: any) => String(id)))
    );
    const eventIds = Array.from(
      new Set(coupons.map((c: any) => c.ownerEventId).filter(Boolean).map((id: any) => String(id)))
    );

    // Events referenced directly by event-type coupons.
    const eventsById = eventIds.length
      ? await Event.find({ _id: { $in: eventIds } }).select('_id userId name eventCode customSlug').lean()
      : [];
    const eventByIdMap = new Map(eventsById.map((e: any) => [String(e._id), e]));

    let userMap = new Map<string, any>();
    let eventByUserMap = new Map<string, any>();

    const allUserIds = Array.from(
      new Set([...ownerIds, ...eventsById.map((e: any) => String(e.userId))])
    );

    if (allUserIds.length) {
      const users = await User.find({ _id: { $in: allUserIds } }).select('_id partnerName1 partnerName2 name').lean();
      userMap = new Map(users.map((u: any) => [String(u._id), u]));
    }
    if (ownerIds.length) {
      const events = await Event.find({ userId: { $in: ownerIds } }).select('userId name eventCode customSlug').lean();
      eventByUserMap = new Map(events.map((e: any) => [String(e.userId), e]));
    }

    const coupleNameOf = (u: any) =>
      u ? [u.partnerName1, u.partnerName2].filter(Boolean).join(' & ') || u.name : '';

    const enriched = coupons.map((c: any) => {
      if (c.ownerEventId) {
        const e = eventByIdMap.get(String(c.ownerEventId));
        const u = e ? userMap.get(String(e.userId)) : null;
        return {
          ...c,
          ownerCoupleName: coupleNameOf(u) || undefined,
          ownerEventName: e?.name || undefined,
          ownerEventCode: e?.eventCode || undefined,
        };
      }
      const ownerId = c.ownerUserId ? String(c.ownerUserId) : '';
      const u = ownerId ? userMap.get(ownerId) : null;
      const e = ownerId ? eventByUserMap.get(ownerId) : null;
      return {
        ...c,
        ownerCoupleName: coupleNameOf(u) || undefined,
        ownerEventName: e?.name || undefined,
        ownerEventCode: e?.eventCode || undefined,
      };
    });

    return {
      coupons: enriched,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async createCoupon(data: {
    code: string;
    discountPercent?: number;
    discountAmount?: number;
    maxUses?: number;
    expiresAt?: Date;
    affiliateId?: string;
    ownerEventId?: string;
    packageName?: string;
  }) {
    const existing = await Coupon.findOne({ code: data.code.toUpperCase() });
    if (existing) {
      throw new ValidationError('Coupon code already exists');
    }

    const discountAmount = data.discountAmount && data.discountAmount > 0 ? data.discountAmount : undefined;
    const discountPercent = discountAmount ? 0 : data.discountPercent ?? 0;
    if (!discountAmount && !discountPercent) {
      throw new ValidationError('Provide a discount percent or a fixed amount');
    }
    if (discountPercent > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100');
    }

    if (data.affiliateId) {
      const affiliate = await Affiliate.findById(data.affiliateId);
      if (!affiliate) {
        throw new ValidationError('Affiliate not found');
      }
    }

    if (data.ownerEventId) {
      const ev = await Event.findById(data.ownerEventId);
      if (!ev) {
        throw new ValidationError('Event not found');
      }
    }

    const coupon = await Coupon.create({
      code: data.code.toUpperCase(),
      discountPercent,
      discountAmount,
      maxUses: data.maxUses || null,
      expiresAt: data.expiresAt || null,
      isActive: true,
      affiliateId: data.affiliateId,
      ownerEventId: data.ownerEventId || undefined,
      packageName: data.packageName || undefined,
      type: data.affiliateId ? 'affiliate' : 'standard',
    });

    logger.info(`Coupon created: ${coupon.code}${data.affiliateId ? ` (affiliate: ${data.affiliateId})` : ''}`);

    return coupon;
  }

  // ---- Event gift-coupon defaults (managed from the coupon dashboard) ----

  async getCouponDefaults() {
    return couponService.getEventDefaults();
  }

  async updateCouponDefaults(data: { discountType?: 'percent' | 'fixed'; discountValue?: number; maxUses?: number }) {
    return couponService.updateEventDefaults(data);
  }

  async applyCouponDefaultsToExisting() {
    return couponService.applyDefaultsToExisting();
  }

  async updateCoupon(couponId: string, data: { discountType?: 'percent' | 'fixed'; discountValue?: number; maxUses?: number; isActive?: boolean }) {
    return couponService.updateEventCoupon(couponId, data);
  }

  async deleteCoupon(couponId: string) {
    const coupon = await Coupon.findById(couponId);
    if (!coupon) {
      throw new NotFoundError('Coupon');
    }

    await Coupon.findByIdAndDelete(couponId);
    logger.info(`Coupon deleted: ${coupon.code}`);

    return { message: 'Coupon deleted successfully' };
  }

  async getDashboardStats() {
    const [
      totalUsers,
      totalEvents,
      paidEvents,
      totalCoupons,
      activeCoupons,
      totalReferrals,
      convertedReferrals,
      totalContacts,
      newContacts,
    ] = await Promise.all([
      User.countDocuments(),
      Event.countDocuments(),
      Event.countDocuments({ isPaid: true }),
      Coupon.countDocuments(),
      Coupon.countDocuments({ isActive: true }),
      Referral.countDocuments(),
      Referral.countDocuments({ status: 'converted' }),
      Contact.countDocuments(),
      Contact.countDocuments({ status: 'new' }),
    ]);

    return {
      users: { total: totalUsers },
      events: { total: totalEvents, paid: paidEvents, unpaid: totalEvents - paidEvents },
      coupons: { total: totalCoupons, active: activeCoupons },
      referrals: { total: totalReferrals, converted: convertedReferrals },
      contacts: { total: totalContacts, new: newContacts },
    };
  }

  async getReferrals(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const [referrals, total] = await Promise.all([
      Referral.find()
        .populate('affiliateId', 'name email referralCode')
        .populate('referredUserId', 'name phone email')
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Referral.countDocuments(),
    ]);

    return {
      referrals,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getPendingCounts() {
    const [pendingAffiliates, pendingWithdrawals] = await Promise.all([
      Affiliate.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
    ]);
    return { pendingAffiliates, pendingWithdrawals };
  }

  async getAffiliates(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const [affiliates, total] = await Promise.all([
      Affiliate.find()
        .select('-password -__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Affiliate.countDocuments(),
    ]);

    return {
      affiliates,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async updateEventPhotographer(
    eventId: string,
    data: { photographerName?: string; photographerInstagram?: string }
  ) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }
    // Store the IG handle bare (no @, no URL) so the frontend can build both the
    // display (@handle) and the link (instagram.com/handle) from one value.
    const handle = (data.photographerInstagram || '')
      .trim()
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
      .replace(/\/+$/, '')
      .split(/[/?]/)[0];

    event.photographerName = (data.photographerName || '').trim() || undefined;
    event.photographerInstagram = handle || undefined;
    await event.save();

    return {
      _id: event._id,
      photographerName: event.photographerName,
      photographerInstagram: event.photographerInstagram,
    };
  }

  async updateEventSlug(eventId: string, newSlug: string, resetCount: boolean = false) {
    const slug = newSlug.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,}$/.test(slug)) {
      throw new ValidationError('Slug must be at least 3 characters and contain only lowercase letters, numbers, and hyphens');
    }

    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const existing = await Event.findOne({ customSlug: slug, _id: { $ne: eventId } });
    if (existing) {
      throw new ValidationError('Slug already in use');
    }

    event.customSlug = slug;
    if (resetCount) {
      event.slugChangeCount = 0;
    }
    await event.save();

    logger.info(`Admin updated slug to ${slug} for event ${event.eventCode}${resetCount ? ' (count reset)' : ''}`);
    return event;
  }

  async extendEventUpload(eventId: string, days: number = 30) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const now = new Date();
    const currentUploadExpiry = event.uploadExpiresAt ? new Date(event.uploadExpiresAt) : now;
    const uploadBase = currentUploadExpiry > now ? currentUploadExpiry : now;
    const newUploadExpiresAt = new Date(uploadBase);
    newUploadExpiresAt.setDate(newUploadExpiresAt.getDate() + days);

    const currentExpiry = event.expiresAt ? new Date(event.expiresAt) : now;
    const expiryBase = currentExpiry > now ? currentExpiry : now;
    const newExpiresAt = new Date(expiryBase);
    newExpiresAt.setDate(newExpiresAt.getDate() + days);

    await Event.findByIdAndUpdate(eventId, {
      uploadExpiresAt: newUploadExpiresAt,
      expiresAt: newExpiresAt,
    });

    logger.info(`Event ${event.eventCode} extended by ${days} days, new upload expiry: ${newUploadExpiresAt.toISOString()}, new event expiry: ${newExpiresAt.toISOString()}`);

    return { message: `Event extended until ${newExpiresAt.toLocaleDateString()}` };
  }

  async getGuestListDownloadUrl(eventId: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }
    if (!event.guestListFile?.s3Key) {
      throw new ValidationError('No guest list file uploaded for this event');
    }

    const original = event.guestListFile.originalName || '';
    const ext = original.includes('.') ? original.split('.').pop() : 'xlsx';
    const downloadName = `${event.name}-${event.eventCode}-guest-list.${ext}`;
    const asciiFallback = `${event.eventCode}-guest-list.${ext}`.replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(downloadName);

    const url = s3.getSignedUrl('getObject', {
      Bucket: env.S3_BUCKET_NAME,
      Key: event.guestListFile.s3Key,
      Expires: 300,
      ResponseContentDisposition: `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    });

    return { url, fileName: downloadName };
  }

  async getGuestListData(eventId: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }
    if (!event.guestListFile?.s3Key) {
      throw new ValidationError('No guest list file uploaded for this event');
    }

    const fileName = event.guestListFile.originalName;
    if (/\.pdf$/i.test(fileName)) {
      throw new ValidationError('PDF guest lists cannot be displayed as a table. Please download the file instead.');
    }

    const obj = await s3
      .getObject({ Bucket: env.S3_BUCKET_NAME, Key: event.guestListFile.s3Key })
      .promise();

    const workbook = XLSX.read(obj.Body as Buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return { guests: [], total: 0, fileName };
    }

    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: '' });
    const guests = this.parseGuestRows(rows);

    return { guests, total: guests.length, fileName };
  }

  private parseGuestRows(rows: any[][]): { name: string; phone: string }[] {
    if (!rows || rows.length === 0) return [];

    const cell = (v: any) => String(v ?? '').trim();
    const nameKeys = ['שם', 'name', 'fullname'];
    const phoneKeys = ['טלפון', 'טל', 'נייד', 'phone', 'mobile', 'cell', 'tel', 'מספר'];

    let nameCol = -1;
    let phoneCol = -1;
    let headerIdx = -1;

    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const row = (rows[i] || []).map(cell);
      const n = row.findIndex((c) => nameKeys.some((k) => c.toLowerCase().includes(k.toLowerCase())));
      const p = row.findIndex((c) => phoneKeys.some((k) => c.toLowerCase().includes(k.toLowerCase())));
      if (n !== -1 || p !== -1) {
        nameCol = n;
        phoneCol = p;
        headerIdx = i;
        break;
      }
    }

    const dataRows = headerIdx >= 0 ? rows.slice(headerIdx + 1) : rows;

    if (phoneCol === -1) {
      phoneCol = this.detectPhoneColumn(dataRows);
    }
    if (nameCol === -1) {
      nameCol = this.detectNameColumn(dataRows, phoneCol);
    }

    const guests: { name: string; phone: string }[] = [];
    for (const row of dataRows) {
      const name = nameCol >= 0 ? cell(row[nameCol]) : '';
      const phone = (phoneCol >= 0 ? cell(row[phoneCol]) : '').replace(/[^\d+]/g, '');
      if (!name && !phone) continue;
      guests.push({ name, phone });
    }
    return guests;
  }

  private detectPhoneColumn(rows: any[][]): number {
    const maxCols = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    let bestCol = -1;
    let bestScore = 0;
    for (let c = 0; c < maxCols; c++) {
      let score = 0;
      for (const row of rows) {
        const digits = String(row?.[c] ?? '').replace(/\D/g, '');
        if (digits.length >= 7) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestCol = c;
      }
    }
    return bestScore > 0 ? bestCol : -1;
  }

  private detectNameColumn(rows: any[][], phoneCol: number): number {
    const maxCols = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    let bestCol = -1;
    let bestScore = 0;
    for (let c = 0; c < maxCols; c++) {
      if (c === phoneCol) continue;
      let score = 0;
      for (const row of rows) {
        const v = String(row?.[c] ?? '').trim();
        if (v && /\D/.test(v)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestCol = c;
      }
    }
    return bestCol;
  }

  async updateAffiliateStatus(affiliateId: string, status: 'pending' | 'approved' | 'rejected') {
    const affiliate = await Affiliate.findById(affiliateId);
    if (!affiliate) {
      throw new NotFoundError('Affiliate');
    }

    affiliate.status = status;
    await affiliate.save({ validateModifiedOnly: true });

    logger.info(`Affiliate ${affiliate.email} status updated to ${status}`);

    return affiliate;
  }

  async resetUserPassword(userId: string, newPassword: string) {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User');
    }
    if (newPassword.length < 6) {
      throw new ValidationError('Password must be at least 6 characters');
    }
    user.password = newPassword;
    await user.save({ validateModifiedOnly: true });
    logger.info(`Admin reset password for user ${user.phoneNumber}`);
    return { success: true };
  }

  async deleteUser(userId: string) {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const events = await Event.find({ userId }).select('_id');
    for (const event of events) {
      try {
        await eventsService.adminDeleteEvent(String(event._id));
      } catch (err: any) {
        logger.warn(`Failed to purge event ${event._id} while deleting user ${userId}: ${err.message}`);
      }
    }

    await Referral.deleteMany({ referredUserId: userId });

    await User.findByIdAndDelete(userId);

    logger.info(`Admin deleted user ${user.phoneNumber} (${userId}) and ${events.length} associated event(s)`);

    return { success: true };
  }

  async createInitialAdmin(email: string, password: string, name: string) {
    const existing = await Admin.findOne({ email });
    if (existing) {
      throw new ValidationError('Admin already exists');
    }

    const admin = await Admin.create({ email, password, name });
    logger.info(`Initial admin created: ${email}`);

    return admin;
  }

  async uploadPhotosToEvent(eventId: string, files: Express.Multer.File[]): Promise<IPhoto[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const uploadedPhotos: IPhoto[] = [];

    for (const file of files) {
      const s3Key = `events/${event.eventCode}/${nanoid()}-${file.originalname}`;

      await s3
        .putObject({
          Bucket: env.S3_BUCKET_NAME,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
        .promise();

      const url = `${env.CLOUDFRONT_URL}/${s3Key}`;
      const thumbnailUrl = `${env.CLOUDFRONT_URL}/thumbnails/${s3Key}`;

      const photo = await Photo.create({
        eventId,
        s3Key,
        url,
        thumbnailUrl,
        category: categoryFromPath(file.originalname),
        uploadedBy: 'owner',
        uploaderName: 'צלם האירוע',
        metadata: {
          size: file.size,
          mimeType: file.mimetype,
        },
      });

      try {
        const indexedFaces = await rekognitionService.indexEventPhoto({
          collectionId: event.collectionId,
          s3Key,
          eventId: String(eventId),
          photoId: String(photo._id),
        });
        if (indexedFaces.length > 0) {
          photo.indexedFaces = indexedFaces;
          photo.faceId = indexedFaces[0].faceId;
          await photo.save();
        }
      } catch (err) {
        logger.warn(`Failed to index face for ${s3Key}: ${err}`);
      }

      uploadedPhotos.push(photo);
    }

    await Event.findByIdAndUpdate(eventId, {
      $inc: { photoCount: files.length },
      lastPhotoUploadedAt: new Date(),
    });

    if (!event.uploadStartedAt) {
      const uploadStartedAt = new Date();
      const uploadExpiresAt = new Date(uploadStartedAt);
      uploadExpiresAt.setMonth(uploadExpiresAt.getMonth() + 6);
      await Event.findByIdAndUpdate(eventId, { uploadStartedAt, uploadExpiresAt });
    }

    logger.info(`Admin uploaded ${files.length} photos to event ${event.eventCode}`);

    return uploadedPhotos;
  }

  async getBatchPresignedUrls(
    eventId: string,
    files: { fileName: string; fileType: string }[]
  ): Promise<{ fileName: string; uploadUrl: string; key: string }[]> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const results = await Promise.all(
      files.map(async ({ fileName, fileType }) => {
        const key = `events/${event.eventCode}/${nanoid()}-${fileName}`;
        const uploadUrl = await s3.getSignedUrlPromise('putObject', {
          Bucket: env.S3_BUCKET_NAME,
          Key: key,
          Expires: 3600,
          ContentType: fileType,
        });
        return { fileName, uploadUrl, key };
      })
    );

    return results;
  }

  async batchCompleteUpload(
    eventId: string,
    uploads: { s3Key: string; size: number; mimeType: string; width?: number; height?: number; path?: string }[]
  ): Promise<{ created: number }> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const photoDocs = await Promise.all(uploads.map(async (upload) => {
      const posterUrl = await this.getExistingVideoPosterUrl(upload.s3Key, upload.mimeType);

      return {
        eventId,
        s3Key: upload.s3Key,
        url: `${env.CLOUDFRONT_URL}/${upload.s3Key}`,
        thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${upload.s3Key}`,
        ...(posterUrl ? { posterUrl } : {}),
        category: categoryFromPath(upload.path),
        uploadedBy: 'owner',
        uploaderName: 'צלם האירוע',
        metadata: {
          size: upload.size,
          mimeType: upload.mimeType,
          ...(upload.width ? { width: upload.width } : {}),
          ...(upload.height ? { height: upload.height } : {}),
        },
      };
    }));

    const insertedPhotos = await Photo.insertMany(photoDocs);

    await Event.findByIdAndUpdate(eventId, {
      $inc: { photoCount: uploads.length },
      lastPhotoUploadedAt: new Date(),
    });

    if (!event.uploadStartedAt) {
      const uploadStartedAt = new Date();
      const uploadExpiresAt = new Date(uploadStartedAt);
      uploadExpiresAt.setMonth(uploadExpiresAt.getMonth() + 6);
      await Event.findByIdAndUpdate(eventId, { uploadStartedAt, uploadExpiresAt });
    }

    const photosForIndexing = insertedPhotos.map((p) => ({
      _id: p._id,
      s3Key: p.s3Key,
    }));
    this.indexFacesInBackground(photosForIndexing, event.collectionId, String(eventId));

    logger.info(`Admin batch created ${uploads.length} photos for event ${event.eventCode}`);

    return { created: insertedPhotos.length };
  }

  private async indexFacesInBackground(photos: { _id: any; s3Key: string }[], collectionId: string, eventId?: string) {
    const CONCURRENCY = 8;
    let cursor = 0;

    const indexOne = async (photo: { _id: any; s3Key: string }) => {
      try {
        const indexedFaces = await rekognitionService.indexEventPhoto({
          collectionId,
          s3Key: photo.s3Key,
          eventId,
          photoId: String(photo._id),
        });
        if (indexedFaces.length > 0) {
          await Photo.findByIdAndUpdate(photo._id, {
            indexedFaces,
            faceId: indexedFaces[0].faceId,
          });
        }
      } catch (err) {
        logger.warn(`Background face indexing failed for ${photo.s3Key}: ${err}`);
      }
    };

    const worker = async () => {
      while (cursor < photos.length) {
        const i = cursor++;
        await indexOne(photos[i]);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, photos.length) }, () => worker())
    );

    logger.info(`Background face indexing finished for ${photos.length} photo(s) in event ${eventId}`);
  }

  async getEventPhotos(eventId: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const photos = await Photo.find({ eventId }).sort({ createdAt: -1 }).lean();

    const photosWithUrls = photos.map((photo) => ({
      ...photo,
      url: `${env.CLOUDFRONT_URL}/${photo.s3Key}`,
      thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photo.s3Key}`,
      displayUrl: displayUrlFor(photo.s3Key, (photo as any).metadata?.mimeType),
      category: (photo as any).category ?? null,
    }));

    return { event, photos: photosWithUrls };
  }

  async initiateZipMultipart(eventId: string, _fileName: string, fileSize: number) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const MAX_ZIP_SIZE = 5 * 1024 * 1024 * 1024;
    if (fileSize > MAX_ZIP_SIZE) {
      throw new ValidationError('ZIP file must be under 5GB');
    }

    const CHUNK_SIZE = 10 * 1024 * 1024;
    const s3Key = `zip-uploads/${event.eventCode}/${nanoid()}.zip`;
    const totalParts = Math.ceil(fileSize / CHUNK_SIZE);

    const multipart = await s3
      .createMultipartUpload({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        ContentType: 'application/zip',
      })
      .promise();

    return {
      uploadId: multipart.UploadId,
      s3Key,
      totalParts,
      chunkSize: CHUNK_SIZE,
    };
  }

  async getZipPartPresignedUrls(
    s3Key: string,
    uploadId: string,
    partNumbers: number[]
  ) {
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const uploadUrl = await s3.getSignedUrlPromise('uploadPart', {
          Bucket: env.S3_BUCKET_NAME,
          Key: s3Key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Expires: 7200,
        });
        return { partNumber, uploadUrl };
      })
    );
    return urls;
  }

  async completeZipMultipart(
    s3Key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[]
  ) {
    await s3
      .completeMultipartUpload({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
      .promise();
    return { s3Key };
  }

  async abortZipMultipart(s3Key: string, uploadId: string) {
    await s3
      .abortMultipartUpload({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        UploadId: uploadId,
      })
      .promise();
    return { message: 'Upload aborted' };
  }

  async getZipPresignedUrl(eventId: string, _fileName: string, fileSize: number) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const MAX_ZIP_SIZE = 5 * 1024 * 1024 * 1024;
    if (fileSize > MAX_ZIP_SIZE) {
      throw new ValidationError('ZIP file must be under 5GB');
    }

    const s3Key = `zip-uploads/${event.eventCode}/${nanoid()}.zip`;
    const uploadUrl = await s3.getSignedUrlPromise('putObject', {
      Bucket: env.S3_BUCKET_NAME,
      Key: s3Key,
      Expires: 7200,
      ContentType: 'application/zip',
    });

    return { uploadUrl, s3Key };
  }

  async startZipProcessing(eventId: string, s3Key: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const zipJob = await ZipJob.create({
      eventId,
      s3Key,
      status: 'pending',
    });

    this.processZipInBackground(
      zipJob._id.toString(),
      eventId,
      s3Key,
      event.eventCode,
      event.collectionId
    );

    return { jobId: zipJob._id };
  }

  private async processZipInBackground(
    jobId: string,
    eventId: string,
    s3Key: string,
    eventCode: string,
    collectionId: string
  ) {
    const SKIP_PATTERNS = ['__MACOSX', '.DS_Store', 'thumbs.db'];
    const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif'];
    const ZIP_CONCURRENCY = 10;
    const PROGRESS_BATCH = 10;

    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
    };

    try {
      await ZipJob.findByIdAndUpdate(jobId, { status: 'processing' });

      const s3Stream = s3
        .getObject({ Bucket: env.S3_BUCKET_NAME, Key: s3Key })
        .createReadStream();

      const zip = s3Stream.pipe(unzipper.Parse({ forceStream: true }));

      const uploadedPhotos: { _id: any; s3Key: string }[] = [];
      let totalFiles = 0;
      let completedFiles = 0;
      let failedFiles = 0;
      let pendingSinceLastUpdate = 0;
      const activeUploads: Promise<void>[] = [];

      const processEntry = async (buffer: Buffer, fileName: string, ext: string, category: string | null) => {
        try {
          const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const photoS3Key = `events/${eventCode}/${nanoid()}-${cleanName}`;

          await s3
            .putObject({
              Bucket: env.S3_BUCKET_NAME,
              Key: photoS3Key,
              Body: buffer,
              ContentType: mimeMap[ext] || 'image/jpeg',
            })
            .promise();

          const photo = await Photo.create({
            eventId,
            s3Key: photoS3Key,
            url: `${env.CLOUDFRONT_URL}/${photoS3Key}`,
            thumbnailUrl: `${env.CLOUDFRONT_URL}/thumbnails/${photoS3Key}`,
            category,
            uploadedBy: 'owner',
            uploaderName: 'צלם האירוע',
            metadata: {
              size: buffer.length,
              mimeType: mimeMap[ext] || 'image/jpeg',
            },
          });

          uploadedPhotos.push({ _id: photo._id, s3Key: photoS3Key });
          completedFiles++;
        } catch (err) {
          logger.warn(`ZIP extraction failed for ${fileName}: ${err}`);
          failedFiles++;
        }

        pendingSinceLastUpdate++;
        if (pendingSinceLastUpdate >= PROGRESS_BATCH) {
          pendingSinceLastUpdate = 0;
          await ZipJob.findByIdAndUpdate(jobId, { completedFiles, failedFiles, totalFiles });
        }
      };

      for await (const entry of zip) {
        const filePath: string = entry.path;
        const type: string = entry.type;

        if (type === 'Directory') {
          entry.autodrain();
          continue;
        }

        const fileName = filePath.split('/').pop() || '';
        const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
        const category = categoryFromPath(filePath);

        const shouldSkip =
          fileName.startsWith('.') ||
          SKIP_PATTERNS.some((p) => filePath.includes(p)) ||
          !IMAGE_EXTENSIONS.includes(ext);

        if (shouldSkip) {
          entry.autodrain();
          continue;
        }

        totalFiles++;
        if (totalFiles % 5 === 0 || totalFiles === 1) {
          ZipJob.findByIdAndUpdate(jobId, { totalFiles }).catch(() => {});
        }
        const buffer = await entry.buffer();

        if (activeUploads.length >= ZIP_CONCURRENCY) {
          await Promise.race(activeUploads);
        }

        const promise = processEntry(buffer, fileName, ext, category).then(() => {
          activeUploads.splice(activeUploads.indexOf(promise), 1);
        });
        activeUploads.push(promise);
      }

      await Promise.all(activeUploads);

      await ZipJob.findByIdAndUpdate(jobId, { completedFiles, failedFiles, totalFiles });

      if (uploadedPhotos.length > 0) {
        await Event.findByIdAndUpdate(eventId, {
          $inc: { photoCount: uploadedPhotos.length },
          lastPhotoUploadedAt: new Date(),
        });

        const event = await Event.findById(eventId);
        if (event && !event.uploadStartedAt) {
          const uploadStartedAt = new Date();
          const uploadExpiresAt = new Date(uploadStartedAt);
          uploadExpiresAt.setMonth(uploadExpiresAt.getMonth() + 6);
          await Event.findByIdAndUpdate(eventId, { uploadStartedAt, uploadExpiresAt });
        }

        this.indexFacesInBackground(uploadedPhotos, collectionId);
      }

      try {
        await s3.deleteObject({ Bucket: env.S3_BUCKET_NAME, Key: s3Key }).promise();
      } catch (err) {
        logger.warn(`Failed to delete ZIP file ${s3Key}: ${err}`);
      }

      const finalStatus = completedFiles === 0 && totalFiles > 0 ? 'failed' : 'completed';
      await ZipJob.findByIdAndUpdate(jobId, { status: finalStatus });

      logger.info(`ZIP processing ${finalStatus} for job ${jobId}: ${uploadedPhotos.length} photos extracted`);
    } catch (err: any) {
      logger.error(`ZIP processing failed for job ${jobId}: ${err.message}`);
      await ZipJob.findByIdAndUpdate(jobId, {
        status: 'failed',
        error: err.message || 'ZIP processing failed',
      });
    }
  }

  async getZipJobStatus(eventId: string, jobId: string) {
    const job = await ZipJob.findOne({ _id: jobId, eventId });
    if (!job) {
      throw new NotFoundError('ZipJob');
    }
    return {
      jobId: job._id,
      status: job.status,
      totalFiles: job.totalFiles,
      completedFiles: job.completedFiles,
      failedFiles: job.failedFiles,
      failedEntries: job.failedEntries,
      error: job.error,
    };
  }

  async uploadCoverImage(eventId: string, file: Express.Multer.File) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.coverImage?.s3Key) {
      try {
        await s3.deleteObject({ Bucket: env.S3_BUCKET_NAME, Key: event.coverImage.s3Key }).promise();
      } catch (err) {
        logger.warn(`Failed to delete old cover image from S3: ${event.coverImage.s3Key}: ${err}`);
      }
    }

    const ext = file.originalname.split('.').pop() || 'jpg';
    const s3Key = `events/${event.eventCode}/cover-${nanoid()}.${ext}`;

    await s3
      .putObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    const coverImage = {
      s3Key,
      url: `${env.CLOUDFRONT_URL}/${s3Key}`,
      uploadedAt: new Date(),
    };

    await Event.findByIdAndUpdate(eventId, { coverImage });

    logger.info(`Admin uploaded cover image for event ${event.eventCode}`);

    return coverImage;
  }

  async deleteCoverImage(eventId: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (!event.coverImage?.s3Key) {
      throw new ValidationError('No cover image to delete');
    }

    try {
      await s3.deleteObject({ Bucket: env.S3_BUCKET_NAME, Key: event.coverImage.s3Key }).promise();
    } catch (err) {
      logger.warn(`Failed to delete cover image from S3: ${event.coverImage.s3Key}: ${err}`);
    }

    await Event.findByIdAndUpdate(eventId, { $unset: { coverImage: 1 } });

    logger.info(`Admin deleted cover image from event ${event.eventCode}`);

    return { message: 'Cover image deleted' };
  }

  async deleteEventPhoto(eventId: string, photoId: string) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    const photo = await Photo.findOne({ _id: photoId, eventId });
    if (!photo) {
      throw new NotFoundError('Photo');
    }

    await s3
      .deleteObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: photo.s3Key,
      })
      .promise();

    const faceIds = collectPhotoFaceIds(photo);
    if (faceIds.length > 0) {
      await rekognitionService.deleteFaces(event.collectionId, faceIds);
    }

    await Photo.findByIdAndDelete(photoId);

    await Event.findByIdAndUpdate(eventId, {
      $inc: { photoCount: -1 },
    });

    logger.info(`Admin deleted photo ${photoId} from event ${event.eventCode}`);

    return { message: 'Photo deleted successfully' };
  }

  async deleteEventPhotosBulk(eventId: string, photoIds: string[]) {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      throw new ValidationError('photoIds must be a non-empty array');
    }

    const photos = await Photo.find({ _id: { $in: photoIds }, eventId });
    if (photos.length === 0) {
      return { deleted: 0, message: 'No matching photos found' };
    }

    const s3Keys = photos.map((p) => ({ Key: p.s3Key }));
    for (let i = 0; i < s3Keys.length; i += 1000) {
      const batch = s3Keys.slice(i, i + 1000);
      try {
        await s3
          .deleteObjects({
            Bucket: env.S3_BUCKET_NAME,
            Delete: { Objects: batch, Quiet: true },
          })
          .promise();
      } catch (err: any) {
        logger.error(`Failed to delete S3 batch: ${err.message}`);
      }
    }

    const allFaceIds = new Set<string>();
    for (const p of photos) {
      for (const fid of collectPhotoFaceIds(p)) allFaceIds.add(fid);
    }
    if (allFaceIds.size > 0) {
      await rekognitionService.deleteFaces(event.collectionId, [...allFaceIds]);
    }

    const photoObjectIds = photos.map((p) => p._id);
    const deleteResult = await Photo.deleteMany({ _id: { $in: photoObjectIds }, eventId });

    await Event.findByIdAndUpdate(eventId, {
      $inc: { photoCount: -deleteResult.deletedCount },
    });

    logger.info(`Admin bulk-deleted ${deleteResult.deletedCount} photos from event ${event.eventCode}`);

    return { deleted: deleteResult.deletedCount, message: `${deleteResult.deletedCount} photos deleted` };
  }
}

export const adminService = new AdminService();
