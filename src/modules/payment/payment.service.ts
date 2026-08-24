import axios from 'axios';
import { Payment, IPayment } from './payment.model';
import { Event, IEvent } from '../events/events.model';
import { User } from '../auth/user.model';
import { Referral, COMMISSION_RATE } from '../affiliate/referral.model';
import { Affiliate } from '../affiliate/affiliate.model';
import { Coupon } from '../coupon/coupon.model';
import { couponService } from '../coupon/coupon.service';
import { affiliateService } from '../affiliate/affiliate.service';
import { env } from '@/shared/config/env';
import { FLASH_PLUS_PRICE_ILS } from '@/shared/config/flashPlans';
import { NotFoundError, ValidationError, AppError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

const SUMIT_CHARGE_URL = 'https://api.sumit.co.il/billing/payments/charge/';
const SUMIT_BEGIN_REDIRECT_URL = 'https://api.sumit.co.il/creditguy/gateway/beginredirect/';
const SUMIT_GET_TRANSACTION_URL = 'https://api.sumit.co.il/creditguy/gateway/gettransaction/';

// On payment, notify the admin only. The couple's single email is the Hebrew
// welcome sent at signup — no receipt is sent to them here.
async function notifyAdminOfPayment(payment: IPayment) {
  try {
    const [user, event] = await Promise.all([
      User.findById(payment.userId).lean(),
      Event.findById(payment.eventId).lean(),
    ]);

    const coupleName =
      [user?.partnerName1, user?.partnerName2].filter(Boolean).join(' & ') ||
      user?.name ||
      'Unknown couple';

    // A referral is expressed through an affiliate/prepaid coupon.
    let affiliateName: string | undefined;
    const couponCode: string | undefined = payment.metadata?.couponCode;
    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
      if (coupon?.affiliateId && (coupon.type === 'affiliate' || coupon.type === 'prepaid')) {
        const affiliate = await Affiliate.findById(coupon.affiliateId).lean();
        affiliateName = affiliate?.name || affiliate?.email;
      }
    }

    const { emailService } = await import('@/shared/services/email.service');
    await emailService.sendPaymentAdminNotification({
      coupleName,
      eventCode: event?.eventCode || String(payment.eventId),
      packageName: event?.packageName,
      weddingDate: event?.weddingDate,
      amountPaid: payment.amount,
      originalAmount: payment.originalAmount,
      discountAmount: payment.discountAmount,
      couponCode,
      discountPercent: payment.metadata?.discountPercent,
      affiliateName,
      contactEmail: user?.email,
      contactPhone: user?.phoneNumber,
    });
  } catch (err: any) {
    logger.warn(`Admin payment notification failed for payment ${payment._id}: ${err.message}`);
  }
}

interface PayWithCouponResult {
  success: boolean;
  message: string;
  payment?: IPayment;
}

interface SumitChargeResult {
  success: boolean;
  paymentId?: string;
  publicKey?: string;
  companyId?: string;
  message: string;
}

class PaymentService {
  /**
   * What this event costs, decided from the event and the product — never from
   * the request body. Any `amount` a client sends is a suggestion at best: the
   * browser controls it, so trusting it means the buyer sets the price.
   */
  private async resolveAuthoritativeAmount(event: IEvent, product?: string): Promise<number> {
    if (product === 'flash_plus') {
      if (event.flashTier === 'plus') {
        throw new ValidationError('האירוע כבר משודרג ל-פלאש+');
      }
      return FLASH_PLUS_PRICE_ILS;
    }

    if (event.isPaid) {
      throw new ValidationError('Event is already paid');
    }

    // The event records which package it is; that is what decides the price.
    //
    // Refuse a missing name BEFORE querying, rather than letting an undefined
    // reach the filter. `$or: [{title: undefined}, {englishTitle: undefined}]`
    // is not the harmless miss it looks like: the keys are still there, and
    // whether they reach Mongo depends on the driver's `ignoreUndefined`. At
    // the default (false) they serialize to null and match nothing — which is
    // why this has never misfired. Turn that option on, as anyone might to stop
    // writing nulls, and the clauses become `{}`, the filter matches EVERY
    // active package, and findOne charges whichever one Mongo returns first.
    // A price must never be one connection option away from being arbitrary.
    const packageName = typeof event.packageName === 'string' ? event.packageName.trim() : '';
    if (!packageName) {
      logger.error(`Event ${event.eventCode} has no packageName; refusing to guess a price`);
      throw new ValidationError('לא נמצאה חבילה מתאימה לאירוע. פנו אלינו ונשלים את ההזמנה.');
    }

    // Prefer the key the event was stamped with: it survives a rename in the
    // Packages screen, where matching on the title would stop finding the
    // package and refuse a sale the couple is entitled to make.
    const { Package } = await import('../packages/packages.model');
    const pkg = event.packageKey
      ? await Package.findOne({ isActive: true, key: event.packageKey })
      : null;
    const resolved =
      pkg ||
      (await Package.findOne({
        isActive: true,
        $or: [{ title: packageName }, { englishTitle: packageName }],
      }));

    if (!resolved) {
      logger.error(
        `No active package matches event ${event.eventCode} packageKey="${event.packageKey ?? ''}" packageName="${packageName}"`
      );
      throw new ValidationError('לא נמצאה חבילה מתאימה לאירוע. פנו אלינו ונשלים את ההזמנה.');
    }
    return resolved.price;
  }

  async payWithCoupon(
    userId: string,
    eventId: string,
    couponCode: string,
    product?: string
  ): Promise<PayWithCouponResult> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to pay for this event');
    }

    if (event.isPaid) {
      throw new ValidationError('Event is already paid');
    }

    // This route used to take the price from the request body, so
    // {couponCode: "GIFT-...", amount: 200} against a ₪200 guest gift card
    // zeroed out and marked the event paid — a free My Night event.
    const originalAmount = await this.resolveAuthoritativeAmount(event, product);

    const couponResult = await couponService.validate(couponCode, event.packageKey || event.packageName);
    if (!couponResult.valid) {
      throw new ValidationError(couponResult.message);
    }

    // Guest gift cards are advertised "למימוש לאלבום המושלם". A ₪200 card
    // against a ₪50 פלאש+ upgrade would cover it entirely, and a fully-covered
    // payment grants the event — so keep them to album purchases.
    if (product === 'flash_plus' && couponResult.coupon?.type === 'event') {
      throw new ValidationError('גיפט קארד של אורחים ניתן למימוש ברכישת אלבום My Night בלבד');
    }

    const discountPercent = couponResult.discountPercent ?? 0;
    const fixedDiscount = couponResult.discountAmount && couponResult.discountAmount > 0
      ? couponResult.discountAmount
      : 0;
    const discountAmount = fixedDiscount > 0
      ? Math.min(fixedDiscount, originalAmount)
      : (originalAmount * discountPercent) / 100;
    const finalAmount = Math.max(0, originalAmount - discountAmount);

    if (finalAmount <= 0) {
      await couponService.use(couponCode);

      const payment = await Payment.create({
        userId,
        eventId,
        amount: 0,
        originalAmount,
        discountAmount,
        currency: 'ILS',
        status: 'completed',
        paymentIntentId: `coupon_${couponCode}_${Date.now()}`,
        provider: 'coupon',
        metadata: {
          couponCode,
          discountPercent,
        },
      });

      // A פלאש+ upgrade buys the flash tier, not the whole event — only a
      // package purchase marks it paid.
      await Event.findByIdAndUpdate(eventId, {
        ...(product === 'flash_plus' ? {} : { isPaid: true }),
        paymentId: payment._id,
        flashTier: 'plus',
      });

      await this.processAffiliateCommission(payment);

      logger.warn(`Payment completed with full-cover coupon ${couponCode} for event ${event.eventCode}: ₪${originalAmount} covered`);

      await notifyAdminOfPayment(payment);

      return {
        success: true,
        message: 'Payment completed with coupon',
        payment,
      };
    }

    return {
      success: false,
      message: `Coupon applied. Remaining amount: ${finalAmount} ILS`,
    };
  }

  async createSumitPayment(
    userId: string,
    eventId: string,
    amount: number,
    couponCode?: string,
    product?: string
  ): Promise<SumitChargeResult> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to pay for this event');
    }

    // `amount` arrives in the request body and was once charged verbatim, so
    // /register?price=1 — the price is a URL parameter the browser controls —
    // bought a ₪675 package for one shekel. The server decides the price.
    const authoritativeAmount = await this.resolveAuthoritativeAmount(event, product);
    if (amount !== authoritativeAmount) {
      logger.warn(`Payment amount ${amount} did not match the server price ${authoritativeAmount} for event ${event.eventCode} — charging the server price`);
    }
    amount = authoritativeAmount;

    if (!amount || amount <= 0) {
      throw new ValidationError('סכום התשלום חסר');
    }

    let finalAmount = amount;
    let discountAmount = 0;
    let discountPercent = 0;

    if (couponCode) {
      const couponResult = await couponService.validate(couponCode, event.packageKey || event.packageName);
      if (couponResult.valid) {
        discountPercent = couponResult.discountPercent ?? 0;
        // Fixed-amount (ILS) coupons discount a flat amount; otherwise percent.
        const fixedDiscount = couponResult.discountAmount && couponResult.discountAmount > 0
          ? couponResult.discountAmount
          : 0;
        discountAmount = fixedDiscount > 0
          ? Math.min(fixedDiscount, amount)
          : (amount * discountPercent) / 100;
        finalAmount = Math.max(0, amount - discountAmount);

        logger.info(`[COUPON-DEBUG] code=${couponCode} valid=${couponResult.valid} pct=${couponResult.discountPercent} fixed=${couponResult.discountAmount} amount=${amount} discount=${discountAmount} final=${finalAmount}`);

        if (finalAmount <= 0) {
          const result = await this.payWithCoupon(userId, eventId, couponCode, product);
          return {
            success: result.success,
            message: result.message,
            paymentId: result.payment?._id?.toString(),
          };
        }
      }
    }

    const payment = await Payment.create({
      userId,
      eventId,
      amount: finalAmount,
      originalAmount: amount,
      discountAmount,
      currency: 'ILS',
      status: 'pending',
      paymentIntentId: `sumit_pending_${Date.now()}`,
      provider: 'sumit',
      metadata: {
        couponCode,
        discountPercent,
        product,
      },
    });

    logger.info(`Sumit payment initiated: ${payment._id} for event ${eventId}, amount: ${finalAmount} ILS${product ? ` (${product})` : ''}`);

    const pk = env.SUMIT_PUBLIC_KEY || '';
    const sk = env.SUMIT_API_KEY || '';
    const cid = env.SUMIT_COMPANY_ID || '';
    const mask = (s: string) => s.length <= 8 ? `(len=${s.length})` : `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length})`;
    logger.info(`[SUMIT-DEBUG] CompanyID="${cid}" (numeric=${Number(cid)}, isInt=${Number.isInteger(Number(cid))}) | PublicKey=${mask(pk)} | SecretKey=${mask(sk)} | sameKey=${pk === sk && pk.length > 0}`);

    return {
      success: true,
      message: 'Payment initiated',
      paymentId: payment._id.toString(),
      publicKey: env.SUMIT_PUBLIC_KEY,
      companyId: env.SUMIT_COMPANY_ID,
    };
  }

  async chargeSumit(
    paymentId: string,
    token: string,
    userId: string
  ): Promise<IPayment> {
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment');
    }

    if (payment.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized');
    }

    if (payment.status === 'completed') {
      throw new ValidationError('Payment already completed');
    }

    try {
      const user = await User.findById(userId);
      const customerName = user
        ? [user.partnerName1, user.partnerName2].filter(Boolean).join(' & ') || user.name || user.phoneNumber
        : userId;
      // Line-item name shown on the Sumit invoice/document. (The MERCHANT name —
      // "איתי הופמן" — is the Sumit account business name, set in the Sumit
      // dashboard, not here.)
      const itemName = payment.metadata?.product === 'flash_plus' ? 'פלאש+' : 'My Night';

      const response = await axios.post(SUMIT_CHARGE_URL, {
        Credentials: {
          CompanyID: Number(env.SUMIT_COMPANY_ID),
          APIKey: env.SUMIT_API_KEY,
        },
        SingleUseToken: token,
        Customer: {
          Name: customerName,
          EmailAddress: user?.email || undefined,
          Phone: user?.phoneNumber || undefined,
          ExternalIdentifier: userId,
          SearchMode: 'ExternalIdentifier',
        },
        Items: [
          {
            Item: {
              Name: itemName,
              Description: itemName,
              Price: payment.amount,
              Currency: 'ILS',
              SearchMode: 'Name',
            },
            Quantity: 1,
            UnitPrice: payment.amount,
            Currency: 'ILS',
            Description: itemName,
          },
        ],
        SendDocumentByEmail: !!user?.email,
        VATIncluded: true,
      });

      const apiOk = response.data?.Status === 'Success' || response.data?.Status === 0;
      const validPayment = response.data?.Data?.Payment?.ValidPayment === true;
      const sumitOk = apiOk && validPayment;

      if (sumitOk) {
        payment.status = 'completed';
        payment.paymentIntentId =
          response.data?.Data?.Payment?.ID?.toString() ||
          response.data?.Data?.DocumentID?.toString() ||
          payment.paymentIntentId;
        await payment.save();

        await Event.findByIdAndUpdate(payment.eventId, {
          isPaid: true,
          paymentId: payment._id,
          flashTier: 'plus',
        });

        if (payment.metadata?.couponCode) {
          await couponService.use(payment.metadata.couponCode);
        }

        await this.processAffiliateCommission(payment);

        logger.info(`Sumit payment completed: ${payment._id}`);

        await notifyAdminOfPayment(payment);
      } else {
        payment.status = 'failed';
        await payment.save();
        const errMsg =
          response.data?.Data?.Payment?.StatusDescription ||
          response.data?.UserErrorMessage ||
          response.data?.TechnicalErrorDetails ||
          response.data?.ErrorMessage ||
          (apiOk ? 'הכרטיס נדחה' : 'Payment failed');
        throw new AppError(errMsg, 400);
      }

      return payment;
    } catch (error: any) {
      logger.error(`Sumit charge failed: ${error.message}`);
      payment.status = 'failed';
      await payment.save();
      throw new AppError(`Payment failed: ${error.message}`, 500);
    }
  }

  async beginSumitRedirect(paymentId: string, userId: string): Promise<{ redirectUrl: string }> {
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment');
    }
    if (payment.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized');
    }
    if (payment.status === 'completed') {
      throw new ValidationError('Payment already completed');
    }

    const uniqueIdentifier = `${payment._id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const frontendBase = (env.FRONTEND_URL || '').replace(/\/+$/, '');
    // Flash+ (code-in-link) upgrades return to the flash-plus thank-you; album
    // payments keep the shared /payment-callback.
    const returnPath = payment.metadata?.product === 'flash_plus' ? '/flash/thanks' : '/payment-callback';
    const returnUrl = `${frontendBase}${returnPath}?paymentId=${payment._id}`;

    try {
      // NOTE: Sumit's billing/payments/beginredirect honors a `Header` (page
      // title) but produces a full income document, which this עוסק-פטור account
      // rejects with "Missing organization details". So we stay on the CreditGuy
      // flow (charges the card, verify works); the page shows the account name.
      const pageTitle = 'My Night';

      const response = await axios.post(SUMIT_BEGIN_REDIRECT_URL, {
        Credentials: {
          CompanyID: Number(env.SUMIT_COMPANY_ID),
          APIKey: env.SUMIT_API_KEY,
        },
        Mode: 'Charge',
        Amount: payment.amount,
        Currency: 'ILS',
        Identifier: uniqueIdentifier,
        RedirectURL: returnUrl,
        Header: pageTitle,
      });

      const redirectUrl: string | undefined = response.data?.Data?.RedirectURL || response.data?.RedirectURL;
      if (!redirectUrl) {
        const err =
          response.data?.UserErrorMessage ||
          response.data?.TechnicalErrorDetails ||
          response.data?.Status ||
          'Failed to begin Sumit redirect';
        throw new AppError(typeof err === 'string' ? err : 'Failed to begin Sumit redirect', 400);
      }

      payment.metadata = { ...(payment.metadata || {}), sumitIdentifier: uniqueIdentifier };
      payment.markModified('metadata');
      await payment.save();

      logger.info(`Sumit redirect URL created for payment ${payment._id} (identifier=${uniqueIdentifier})`);
      return { redirectUrl };
    } catch (error: any) {
      logger.error(`Sumit beginredirect failed: ${error.message}`);
      throw new AppError(`Failed to start payment: ${error.message}`, 500);
    }
  }

  async verifySumitRedirect(paymentId: string, userId: string): Promise<{ success: boolean; payment: IPayment; message?: string }> {
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment');
    }
    if (payment.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized');
    }

    if (payment.status === 'completed') {
      return { success: true, payment, message: 'Already completed' };
    }

    try {
      const sumitIdentifier: string = payment.metadata?.sumitIdentifier || String(payment._id);
      const response = await axios.post(SUMIT_GET_TRANSACTION_URL, {
        Credentials: {
          CompanyID: Number(env.SUMIT_COMPANY_ID),
          APIPublicKey: env.SUMIT_PUBLIC_KEY,
        },
        UniqueIdentifier: sumitIdentifier,
      });

      const data = response.data?.Data ?? response.data;
      const code: string | undefined = data?.Code != null ? String(data.Code) : undefined;
      const description: string | undefined = data?.Description;
      const authNumber = data?.AuthNumber;
      const isApproved = code === '000' || code === '0' || code === '00' || !!authNumber;

      if (isApproved) {
        payment.status = 'completed';
        payment.paymentIntentId = String(data?.ReferenceNumber || data?.AuthNumber || payment.paymentIntentId);
        await payment.save();

        await Event.findByIdAndUpdate(payment.eventId, {
          isPaid: true,
          paymentId: payment._id,
          flashTier: 'plus',
        });

        if (payment.metadata?.couponCode) {
          await couponService.use(payment.metadata.couponCode);
        }

        await this.processAffiliateCommission(payment);

        logger.info(`Sumit redirect payment verified: ${payment._id}`);

        await notifyAdminOfPayment(payment);

        return { success: true, payment };
      }

      payment.status = 'failed';
      await payment.save();
      logger.warn(`Sumit redirect payment failed: ${payment._id} code=${code} desc=${description}`);
      return { success: false, payment, message: description || 'Payment was not completed' };
    } catch (error: any) {
      logger.error(`Sumit gettransaction failed: ${error.message}`);
      throw new AppError(`Failed to verify payment: ${error.message}`, 500);
    }
  }

  // ── Public Flash+ upgrade (code-in-link, no auth) ──────────────────────────
  // The couple isn't logged in; identity is derived from their event code (from
  // the QR/email link) and, on return, the random paymentId. Price is always
  // server-authoritative (FLASH_PLUS_PRICE_ILS). The authed album flow is untouched.
  async beginFlashPlusByCode(code: string): Promise<{ redirectUrl: string }> {
    const raw = String(code || '').trim().replace(/[^A-Za-z0-9]/g, '');
    if (!raw) {
      throw new ValidationError('קוד אירוע חסר');
    }
    const event = await Event.findOne({ eventCode: { $regex: `^${raw}$`, $options: 'i' } });
    if (!event) {
      throw new NotFoundError('Event');
    }
    if (event.flashTier === 'plus') {
      throw new ValidationError('האירוע כבר משודרג ל-פלאש+');
    }
    const ownerId = event.userId.toString();
    const created = await this.createSumitPayment(ownerId, event._id.toString(), 0, undefined, 'flash_plus');
    if (!created.paymentId) {
      throw new AppError('Failed to create Flash+ payment', 500);
    }
    return this.beginSumitRedirect(created.paymentId, ownerId);
  }

  async verifyFlashPlusByPayment(
    paymentId: string
  ): Promise<{ success: boolean; message?: string; eventCode?: string; flashTier?: string }> {
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment');
    }
    if (payment.metadata?.product !== 'flash_plus') {
      throw new ValidationError('Unsupported payment');
    }
    const result = await this.verifySumitRedirect(paymentId, payment.userId.toString());
    const event = await Event.findById(payment.eventId).lean();
    return {
      success: result.success,
      message: result.message,
      eventCode: event?.eventCode,
      flashTier: event?.flashTier,
    };
  }

  async getPayment(paymentId: string, userId: string): Promise<IPayment> {
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment');
    }

    if (payment.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized to access this payment');
    }

    return payment;
  }

  async getUserPayments(userId: string): Promise<IPayment[]> {
    const payments = await Payment.find({ userId }).sort({ createdAt: -1 });
    return payments;
  }

  async getEventPaymentStatus(eventId: string, userId: string): Promise<{ isPaid: boolean; payment?: IPayment }> {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }

    if (event.userId.toString() !== userId) {
      throw new ValidationError('Unauthorized');
    }

    const payment = await Payment.findOne({ eventId, status: 'completed' });

    return {
      isPaid: event.isPaid,
      payment: payment || undefined,
    };
  }

  private async processAffiliateCommission(payment: IPayment): Promise<void> {
    try {
      const couponCode: string | undefined = payment.metadata?.couponCode;

      if (couponCode) {
        const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });

        if (coupon?.type === 'prepaid' && coupon.affiliateId) {
          const event = await Event.findById(payment.eventId);
          const user = await User.findById(payment.userId);
          const eventName = event?.name || event?.eventCode || 'Event';
          const coupleName = user
            ? [user.partnerName1, user.partnerName2].filter(Boolean).join(' & ') || user.name
            : undefined;

          await affiliateService.recordPrepaidUsage({
            affiliateId: String(coupon.affiliateId),
            eventId: String(payment.eventId),
            userId: String(payment.userId),
            couponCode: coupon.code,
            eventName,
            coupleName,
          });

          logger.info(`Prepaid coupon ${coupon.code} consumed for affiliate ${coupon.affiliateId}`);
          return;
        }

        if (coupon?.type === 'affiliate' && coupon.affiliateId) {
          const commissionAmount = (payment.originalAmount || payment.amount) * COMMISSION_RATE;

          await Referral.create({
            affiliateId: coupon.affiliateId,
            referredUserId: payment.userId,
            referralCode: coupon.code,
            paymentId: payment._id as any,
            paymentAmount: payment.originalAmount || payment.amount,
            commissionAmount,
            status: 'converted',
            convertedAt: new Date(),
          });

          await Affiliate.findByIdAndUpdate(coupon.affiliateId, {
            $inc: {
              totalEarnings: commissionAmount,
              pendingEarnings: commissionAmount,
              totalReferrals: 1,
            },
          });

          logger.info(`Affiliate commission via coupon ${coupon.code}: ${commissionAmount} ILS to ${coupon.affiliateId}`);
          return;
        }
      }

      const referral = await Referral.findOne({
        referredUserId: payment.userId,
        status: 'pending'
      });

      if (!referral) {
        return;
      }

      const commissionAmount = (payment.originalAmount || payment.amount) * COMMISSION_RATE;

      referral.status = 'converted';
      referral.paymentId = payment._id as any;
      referral.paymentAmount = payment.originalAmount || payment.amount;
      referral.commissionAmount = commissionAmount;
      referral.convertedAt = new Date();
      await referral.save();

      await Affiliate.findByIdAndUpdate(referral.affiliateId, {
        $inc: {
          totalEarnings: commissionAmount,
          pendingEarnings: commissionAmount
        }
      });

      logger.info(`Affiliate commission processed: ${commissionAmount} ILS for referral ${referral._id}`);
    } catch (error: any) {
      logger.error(`Failed to process affiliate commission: ${error.message}`);
    }
  }
}

export const paymentService = new PaymentService();
