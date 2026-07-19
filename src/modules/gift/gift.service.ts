import axios from 'axios';
import { Gift, IGift } from './gift.model';
import { couponService } from '../coupon/coupon.service';
import { env } from '@/shared/config/env';
import { NotFoundError, ValidationError, AppError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

const SUMIT_CHARGE_URL = 'https://api.sumit.co.il/billing/payments/charge/';
const SUMIT_BEGIN_REDIRECT_URL = 'https://api.sumit.co.il/creditguy/gateway/beginredirect/';
const SUMIT_GET_TRANSACTION_URL = 'https://api.sumit.co.il/creditguy/gateway/gettransaction/';

// Guard rails on the gift-card amount so a tampered request can't create an
// absurd coupon. The full-package path passes the package price directly.
const MIN_GIFT = 50;
const MAX_GIFT = 5000;

interface CreateGiftInput {
  amount: number;
  packageName?: string;
  coupleName?: string;
  gifterEmail?: string;
  message?: string;
}

class GiftService {
  async createGift(input: CreateGiftInput): Promise<{
    giftId: string;
    amount: number;
    publicKey?: string;
    companyId?: string;
  }> {
    const amount = Math.round(Number(input.amount));
    if (!Number.isFinite(amount) || amount < MIN_GIFT || amount > MAX_GIFT) {
      throw new ValidationError(`Gift amount must be between ${MIN_GIFT} and ${MAX_GIFT} ILS`);
    }

    const gift = await Gift.create({
      amount,
      packageName: input.packageName || undefined,
      coupleName: input.coupleName?.trim() || undefined,
      gifterEmail: input.gifterEmail?.trim() || undefined,
      message: input.message?.trim() || undefined,
      status: 'pending',
    });

    logger.info(`Gift initiated: ${gift._id} for ₪${amount}${input.packageName ? ` (${input.packageName})` : ''}`);

    return {
      giftId: gift._id.toString(),
      amount,
      publicKey: env.SUMIT_PUBLIC_KEY,
      companyId: env.SUMIT_COMPANY_ID,
    };
  }

  async chargeGift(giftId: string, token: string): Promise<{
    couponCode: string;
    amount: number;
    coupleName?: string;
    message?: string;
  }> {
    const gift = await Gift.findById(giftId);
    if (!gift) throw new NotFoundError('Gift');
    if (gift.status === 'paid' && gift.couponCode) {
      // Idempotent: re-charging a paid gift just returns its coupon.
      return { couponCode: gift.couponCode, amount: gift.amount, coupleName: gift.coupleName, message: gift.message };
    }

    try {
      const response = await axios.post(SUMIT_CHARGE_URL, {
        Credentials: {
          CompanyID: Number(env.SUMIT_COMPANY_ID),
          APIKey: env.SUMIT_API_KEY,
        },
        SingleUseToken: token,
        Customer: {
          Name: gift.coupleName ? `Gift for ${gift.coupleName}` : 'MyNight Gift',
          EmailAddress: gift.gifterEmail || undefined,
          SearchMode: 'Name',
        },
        Items: [
          {
            Item: {
              Name: 'MyNight Gift',
              Description: 'MyNight Gift Card',
              Price: gift.amount,
              Currency: 'ILS',
              SearchMode: 'Name',
            },
            Quantity: 1,
            UnitPrice: gift.amount,
            Currency: 'ILS',
            Description: 'MyNight Gift Card',
          },
        ],
        SendDocumentByEmail: !!gift.gifterEmail,
        VATIncluded: true,
      });

      const apiOk = response.data?.Status === 'Success' || response.data?.Status === 0;
      const validPayment = response.data?.Data?.Payment?.ValidPayment === true;
      if (!apiOk || !validPayment) {
        gift.status = 'failed';
        await gift.save();
        const errMsg =
          response.data?.Data?.Payment?.StatusDescription ||
          response.data?.UserErrorMessage ||
          response.data?.TechnicalErrorDetails ||
          'הכרטיס נדחה';
        throw new AppError(errMsg, 400);
      }

      const paymentRef =
        response.data?.Data?.Payment?.ID?.toString() ||
        response.data?.Data?.DocumentID?.toString();
      return await this.finalizeGift(gift, paymentRef);
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`Gift charge failed: ${error.message}`);
      throw new AppError(`Gift payment failed: ${error.message}`, 500);
    }
  }

  /**
   * Sends the gifter to Sumit's hosted payment page. On return the client calls
   * verifyGiftRedirect, which mints the coupon.
   */
  async beginGiftRedirect(giftId: string): Promise<{ redirectUrl: string }> {
    const gift = await Gift.findById(giftId);
    if (!gift) throw new NotFoundError('Gift');
    if (gift.status === 'paid') throw new ValidationError('Gift already paid');

    const identifier = `${gift._id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const frontendBase = (env.FRONTEND_URL || '').replace(/\/+$/, '');
    const returnUrl = `${frontendBase}/gift-callback?giftId=${gift._id}`;

    const response = await axios.post(SUMIT_BEGIN_REDIRECT_URL, {
      Credentials: { CompanyID: Number(env.SUMIT_COMPANY_ID), APIKey: env.SUMIT_API_KEY },
      Mode: 'Charge',
      Amount: gift.amount,
      Currency: 'ILS',
      Identifier: identifier,
      RedirectURL: returnUrl,
    });

    const redirectUrl: string | undefined = response.data?.Data?.RedirectURL || response.data?.RedirectURL;
    if (!redirectUrl) {
      const err = response.data?.UserErrorMessage || response.data?.TechnicalErrorDetails || 'Failed to begin Sumit redirect';
      throw new AppError(typeof err === 'string' ? err : 'Failed to begin Sumit redirect', 400);
    }

    gift.sumitIdentifier = identifier;
    await gift.save();
    logger.info(`Gift redirect started: ${gift._id} (identifier=${identifier})`);
    return { redirectUrl };
  }

  /** Verifies the redirect transaction and mints the coupon on success. */
  async verifyGiftRedirect(giftId: string): Promise<{
    couponCode: string;
    amount: number;
    coupleName?: string;
    message?: string;
  }> {
    const gift = await Gift.findById(giftId);
    if (!gift) throw new NotFoundError('Gift');
    if (gift.status === 'paid' && gift.couponCode) {
      return { couponCode: gift.couponCode, amount: gift.amount, coupleName: gift.coupleName, message: gift.message };
    }

    const response = await axios.post(SUMIT_GET_TRANSACTION_URL, {
      Credentials: { CompanyID: Number(env.SUMIT_COMPANY_ID), APIPublicKey: env.SUMIT_PUBLIC_KEY },
      UniqueIdentifier: gift.sumitIdentifier || String(gift._id),
    });

    const data = response.data?.Data ?? response.data;
    const code: string | undefined = data?.Code != null ? String(data.Code) : undefined;
    const authNumber = data?.AuthNumber;
    const approved = code === '000' || code === '0' || code === '00' || !!authNumber;
    if (!approved) {
      gift.status = 'failed';
      await gift.save();
      throw new AppError(data?.Description || 'התשלום לא הושלם', 400);
    }

    return await this.finalizeGift(gift, String(data?.ReferenceNumber || data?.AuthNumber || ''));
  }

  /** Mints the coupon, marks the gift paid, notifies the admin. */
  private async finalizeGift(gift: IGift, paymentRef?: string) {
    const coupon = await couponService.createGiftCoupon(gift.amount, gift.packageName);
    gift.couponCode = coupon.code;
    gift.status = 'paid';
    gift.paymentIntentId = paymentRef || gift.paymentIntentId;
    await gift.save();

    logger.info(`Gift ${gift._id} paid — coupon ${coupon.code}`);

    try {
      const { emailService } = await import('@/shared/services/email.service');
      await emailService.sendEmail({
        to: env.ADMIN_NOTIFY_EMAIL,
        subject: `🎁 מתנה חדשה נרכשה — ₪${gift.amount}`,
        htmlBody: `<div dir="rtl" style="font-family:sans-serif"><h2>מתנה חדשה נרכשה 🎁</h2>
          <p>סכום: ₪${gift.amount}</p>
          <p>עבור: ${gift.coupleName || '—'}</p>
          <p>חבילה: ${gift.packageName || 'ללא (שובר)'}</p>
          <p>מייל הרוכש: ${gift.gifterEmail || '—'}</p>
          <p>קוד: ${coupon.code}</p></div>`,
      });
    } catch (e: any) {
      logger.warn(`Gift admin notification failed: ${e.message}`);
    }

    return { couponCode: coupon.code, amount: gift.amount, coupleName: gift.coupleName, message: gift.message };
  }

  /** Public info for the couple's gift-landing page. */
  async getGiftByCode(couponCode: string): Promise<{
    amount: number;
    coupleName?: string;
    message?: string;
    packageName?: string;
    redeemed: boolean;
  }> {
    const gift = await Gift.findOne({ couponCode: couponCode.toUpperCase(), status: 'paid' });
    if (!gift) throw new NotFoundError('Gift');

    // Redeemed = the coupon has been used up.
    const validation = await couponService.validate(couponCode, gift.packageName);
    return {
      amount: gift.amount,
      coupleName: gift.coupleName,
      message: gift.message,
      packageName: gift.packageName,
      redeemed: !validation.valid,
    };
  }
}

export const giftService = new GiftService();
