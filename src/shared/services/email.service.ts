import sgMail from '@sendgrid/mail';
import { ses } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';
import { AppError } from '@/shared/utils/errors';
import { buildIcs, googleCalendarUrl, type CalendarEvent } from '@/shared/utils/calendar';

interface EmailAttachment {
  filename: string;
  content: string;
  type: string;
}

interface SendEmailParams {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  /**
   * SendGrid only. The SES fallback uses sendEmail, which has no attachment
   * support (that needs sendRawEmail + hand-built MIME), so attachments are
   * dropped there — mails that attach anything must also work without it.
   */
  attachments?: EmailAttachment[];
}

const SENDGRID_ENABLED = Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);

if (SENDGRID_ENABLED) {
  sgMail.setApiKey(env.SENDGRID_API_KEY!);
  logger.info('Email provider: SendGrid');
} else {
  logger.info('Email provider: AWS SES (SendGrid not configured)');
}

const BRAND = {
  logoUrl: 'https://i.postimg.cc/mPStkVPV/logo.png',
  name: 'MyNight',
  tagline: 'Photo Matching Made Easy',
  primary: '#1A1A1A',
  accent: '#D4A24C',
  accentDark: '#A67C2E',
  bg: '#F5F1EA',
  cardBg: '#FFFFFF',
  text: '#1A1A1A',
  muted: '#6B6B6B',
  border: '#E8E2D6',
  success: '#2E7D5B',
};

function renderLayout(opts: {
  preheader?: string;
  body: string;
  dir?: 'ltr' | 'rtl';
}): string {
  const dir = opts.dir || 'ltr';
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="${dir === 'rtl' ? 'he' : 'en'}" dir="${dir}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${BRAND.name}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.text};">
    ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;visibility:hidden;">${opts.preheader}</div>` : ''}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
            <tr>
              <td align="center" style="padding:8px 0 24px 0;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td align="center" valign="middle" style="padding:0;">
                      <img src="${BRAND.logoUrl}" alt="${BRAND.name}" width="44" height="44" style="display:inline-block;vertical-align:middle;border:0;outline:none;margin-right:12px;" />
                      <span style="display:inline-block;vertical-align:middle;font-size:26px;font-weight:800;letter-spacing:0.5px;color:${BRAND.primary};font-family:Georgia,'Times New Roman',serif;">${BRAND.name}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:16px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">
                ${opts.body}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 16px 8px 16px;color:${BRAND.muted};font-size:12px;line-height:1.6;">
                <div style="font-weight:600;color:${BRAND.primary};margin-bottom:4px;">${BRAND.name}</div>
                <div>${BRAND.tagline}</div>
                <div style="margin-top:8px;">&copy; ${year} ${BRAND.name}. All rights reserved.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px auto;">
    <tr>
      <td align="center" style="background:${BRAND.primary};border-radius:10px;">
        <a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:0.3px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

class EmailService {
  private fromEmail = SENDGRID_ENABLED ? env.SENDGRID_FROM_EMAIL! : env.SES_EMAIL_FROM;
  private fromName = env.SENDGRID_FROM_NAME || BRAND.name;

  async sendEmail({ to, subject, htmlBody, textBody, attachments }: SendEmailParams): Promise<void> {
    if (SENDGRID_ENABLED) {
      try {
        await sgMail.send({
          to,
          from: { email: this.fromEmail, name: this.fromName },
          subject,
          html: htmlBody,
          text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
          ...(attachments?.length
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content, 'utf-8').toString('base64'),
                  type: a.type,
                  disposition: 'attachment',
                })),
              }
            : {}),
        });
        logger.info(`Email sent to ${to} via SendGrid: ${subject}`);
        return;
      } catch (error: any) {
        const detail = error?.response?.body?.errors?.[0]?.message || error.message;
        logger.error(`SendGrid send failed to ${to}: ${detail}`);
        throw new AppError(`Email sending failed: ${detail}`, 500);
      }
    }

    try {
      await ses
        .sendEmail({
          Source: this.fromEmail,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject },
            Body: {
              Html: { Data: htmlBody },
              Text: { Data: textBody || htmlBody.replace(/<[^>]*>/g, '') },
            },
          },
        })
        .promise();

      logger.info(`Email sent to ${to} via SES: ${subject}`);
    } catch (error: any) {
      logger.error(`Failed to send email to ${to}: ${error.message}`);
      throw new AppError(`Email sending failed: ${error.message}`, 500);
    }
  }

  async sendOTPEmail(to: string, otp: string): Promise<void> {
    const subject = `Your ${BRAND.name} verification code`;
    const body = `
      <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:700;color:${BRAND.primary};">Verification code</h1>
      <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:${BRAND.muted};">Use this code to complete your sign in to ${BRAND.name}.</p>
      <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:${BRAND.primary};font-family:'Courier New',monospace;">${otp}</div>
      </div>
      <p style="margin:0 0 8px 0;font-size:14px;color:${BRAND.muted};">This code expires in 10 minutes.</p>
      <p style="margin:0;font-size:14px;color:${BRAND.muted};">If you did not request this code, you can safely ignore this email.</p>
    `;
    await this.sendEmail({
      to,
      subject,
      htmlBody: renderLayout({ preheader: `Your ${BRAND.name} verification code is ${otp}`, body }),
    });
  }

  async sendWelcomeEmail(to: string, name?: string): Promise<void> {
    const subject = `ברוכים הבאים ל-${BRAND.name} 🎉`;
    const greeting = name ? `ברוכים הבאים, ${name}!` : `ברוכים הבאים ל-${BRAND.name}!`;
    const body = `
      <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};">${greeting}</h1>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">אנחנו מתרגשים שאתם איתנו. מהרגע שהנעל נוגעת בכוס, אנחנו מתחילים לעבוד על האלבום המושלם שלכם!</p>
      <div style="background:${BRAND.bg};border-right:3px solid ${BRAND.accent};border-radius:8px;padding:18px 22px;margin:24px 0;">
        <p style="margin:0 0 10px 0;font-size:14px;font-weight:700;color:${BRAND.primary};">מה עכשיו?</p>
        <ul style="margin:0;padding-right:18px;padding-left:0;font-size:14px;line-height:1.9;color:${BRAND.text};">
          <li>הגדירו את הלינק האישי שלכם בלוח הבקרה</li>
          <li>העלו את רשימת האורחים</li>
          <li>אנחנו נטפל בכל השאר!</li>
        </ul>
      </div>
      ${button(`${env.FRONTEND_URL}/login`, 'כניסה לחשבון')}
      <p style="margin:24px 0 0 0;font-size:14px;color:${BRAND.muted};">יש שאלה? פשוט השיבו למייל הזה ונשמח לעזור.</p>
    `;
    await this.sendEmail({
      to,
      subject,
      htmlBody: renderLayout({ preheader: `ברוכים הבאים ל-${BRAND.name} — האלבום שלכם מתחיל כאן.`, body, dir: 'rtl' }),
    });
  }

  /**
   * Internal alert sent to ADMIN_NOTIFY_EMAIL when an event is paid for. Carries
   * the amount, coupon and referral status; the couple never sees this.
   */
  async sendPaymentAdminNotification(opts: {
    coupleName: string;
    eventCode: string;
    packageName?: string;
    weddingDate?: Date;
    amountPaid: number;
    originalAmount?: number;
    discountAmount?: number;
    couponCode?: string;
    discountPercent?: number;
    affiliateName?: string;
    contactEmail?: string;
    contactPhone?: string;
  }): Promise<void> {
    const {
      coupleName, eventCode, packageName, weddingDate, amountPaid,
      originalAmount, discountAmount, couponCode, discountPercent, affiliateName,
      contactEmail, contactPhone,
    } = opts;

    const row = (label: string, value: string) =>
      `<tr><td style="padding:8px 0;font-size:14px;color:${BRAND.muted};white-space:nowrap;">${label}</td>
        <td style="padding:8px 0 8px 16px;font-size:14px;font-weight:600;color:${BRAND.text};">${value}</td></tr>`;

    const dateStr = weddingDate
      ? weddingDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })
      : '—';
    const discounted = typeof discountAmount === 'number' && discountAmount > 0;
    const couponLine = couponCode
      ? `${couponCode}${discountPercent ? ` (${discountPercent}%–)` : ''}`
      : 'ללא קופון';
    const contact = [contactEmail, contactPhone].filter(Boolean).join(' · ') || '—';

    const body = `
      <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:${BRAND.primary};">תשלום חדש התקבל 🎉</h1>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:16px;border-collapse:collapse;">
        ${row('הזוג', coupleName)}
        ${row('קוד אירוע', eventCode)}
        ${row('חבילה', packageName || '—')}
        ${row('תאריך חתונה', dateStr)}
        ${row('סכום ששולם', `₪${amountPaid}`)}
        ${discounted ? row('מחיר מקורי', `<s style="color:${BRAND.muted};">₪${originalAmount}</s> · הנחה: ₪${discountAmount}`) : ''}
        ${row('קופון', couponLine)}
        ${row('שותף מפנה', affiliateName || 'אין שותף מפנה')}
        ${row('פרטי קשר', contact)}
      </table>
    `;

    await this.sendEmail({
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: `💳 תשלום חדש — ${coupleName} (${eventCode})`,
      htmlBody: renderLayout({ preheader: `₪${amountPaid} · ${coupleName}`, body, dir: 'rtl' }),
    });
  }

  async sendEventShareEmail(to: string, eventName: string, eventCode: string): Promise<void> {
    const shareUrl = `${env.FRONTEND_URL}/selfie?code=${eventCode}`;
    const subject = `You are invited to view ${eventName} photos`;
    const body = `
      <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};">Find yourself in ${eventName}</h1>
      <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">Upload a selfie and instantly see every photo you appear in from the event.</p>
      <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;padding:22px;text-align:center;margin:24px 0;">
        <p style="margin:0 0 8px 0;font-size:12px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:1.2px;">Event code</p>
        <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:${BRAND.primary};font-family:'Courier New',monospace;">${eventCode}</div>
      </div>
      ${button(shareUrl, 'Find my photos')}
      <p style="margin:24px 0 0 0;font-size:13px;color:${BRAND.muted};text-align:center;word-break:break-all;">Or open <a href="${shareUrl}" style="color:${BRAND.accentDark};text-decoration:underline;">${shareUrl}</a></p>
    `;
    await this.sendEmail({
      to,
      subject,
      htmlBody: renderLayout({ preheader: `Find yourself in the ${eventName} photos`, body }),
    });
  }

  /**
   * Sent when a couple creates their event. Carries two calendar reminders:
   * a week before the wedding (share the guest link) and the day after
   * (send the links out). Both as one .ics and as Google Calendar links, since
   * neither covers everyone on its own.
   */
  async sendEventCreatedEmail(
    to: string,
    opts: { eventName: string; eventCode: string; weddingDate: Date }
  ): Promise<void> {
    const { eventName, eventCode, weddingDate } = opts;
    const guestUrl = `${env.FRONTEND_URL}/guest/${eventCode}/selfie`;
    const galleryUrl = `${env.FRONTEND_URL}/gallery/${eventCode}`;

    const weekBefore = new Date(weddingDate);
    weekBefore.setDate(weekBefore.getDate() - 7);
    const dayAfter = new Date(weddingDate);
    dayAfter.setDate(dayAfter.getDate() + 1);

    const reminders: CalendarEvent[] = [];
    // An event created less than a week out would otherwise get a reminder
    // dated in the past.
    if (weekBefore.getTime() > Date.now()) {
      reminders.push({
        uid: `mynight-${eventCode}-before@mynight.co.il`,
        title: `שבוע לחתונה — שתפו את הקישור לאורחים (${eventName})`,
        description: 'שתפו את הקישור עם האורחים כדי שיוכלו להעלות ולמצוא את הצילומים שלהם.',
        date: weekBefore,
        url: guestUrl,
      });
    }
    reminders.push({
      uid: `mynight-${eventCode}-after@mynight.co.il`,
      title: `שלחו לאורחים את הקישור לצילומים (${eventName})`,
      description: 'החתונה מאחוריכם — שלחו לאורחים את הקישור כדי שימצאו את עצמם בצילומים.',
      date: dayAfter,
      url: guestUrl,
    });

    const dateFmt = (d: Date) => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });

    const reminderRows = reminders
      .map(
        (r) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid ${BRAND.border};">
          <div style="font-size:15px;font-weight:700;color:${BRAND.primary};">${r.title}</div>
          <div style="font-size:13px;color:${BRAND.muted};margin-top:4px;">${dateFmt(r.date)}</div>
          <a href="${googleCalendarUrl(r)}" target="_blank" style="display:inline-block;margin-top:8px;font-size:13px;color:${BRAND.accentDark};text-decoration:underline;">הוספה ליומן Google</a>
        </td>
      </tr>`
      )
      .join('');

    const body = `
      <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};">האירוע ${eventName} נוצר בהצלחה</h1>
      <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">הכול מוכן. זה הקישור שהאורחים שלכם ישתמשו בו כדי להעלות צילומים ולמצוא את עצמם:</p>
      <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;padding:22px;text-align:center;margin:24px 0;">
        <p style="margin:0 0 8px 0;font-size:12px;font-weight:700;color:${BRAND.muted};letter-spacing:1.2px;">קוד האירוע</p>
        <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:${BRAND.primary};font-family:'Courier New',monospace;" dir="ltr">${eventCode}</div>
      </div>
      ${button(guestUrl, 'הקישור לאורחים')}
      <p style="margin:32px 0 8px 0;font-size:15px;font-weight:700;color:${BRAND.primary};">תזכורות ליומן</p>
      <p style="margin:0 0 8px 0;font-size:14px;line-height:1.7;color:${BRAND.text};">צירפנו קובץ יומן למייל הזה — פתיחה שלו תוסיף את שתי התזכורות בבת אחת. אפשר גם להוסיף כל אחת בנפרד:</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${reminderRows}</table>
      <p style="margin:24px 0 0 0;font-size:13px;color:${BRAND.muted};">הגלריה שלכם: <a href="${galleryUrl}" style="color:${BRAND.accentDark};text-decoration:underline;" dir="ltr">${galleryUrl}</a></p>
    `;

    await this.sendEmail({
      to,
      subject: `האירוע ${eventName} נוצר — הקישור לאורחים ותזכורות ליומן`,
      htmlBody: renderLayout({ preheader: `הקישור לאורחים ותזכורות ליומן עבור ${eventName}`, body, dir: 'rtl' }),
      attachments: [
        {
          filename: 'mynight-reminders.ics',
          content: buildIcs(reminders),
          type: 'text/calendar',
        },
      ],
    });
  }

  async sendPaymentConfirmationEmail(
    to: string,
    eventName: string,
    amount: number
  ): Promise<void> {
    const subject = `Payment confirmed - ${BRAND.name}`;
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const body = `
      <div style="text-align:center;margin:0 0 24px 0;">
        <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:${BRAND.success};color:#FFFFFF;font-size:28px;line-height:56px;text-align:center;font-weight:700;">&#10003;</div>
      </div>
      <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};text-align:center;">Payment received</h1>
      <p style="margin:0 0 28px 0;font-size:15px;line-height:1.7;color:${BRAND.text};text-align:center;">Thank you. Your event is now active and ready for uploads.</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;margin:0 0 24px 0;">
        <tr><td style="padding:14px 20px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.muted};">Event</td><td style="padding:14px 20px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.primary};font-weight:600;text-align:right;">${eventName}</td></tr>
        <tr><td style="padding:14px 20px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.muted};">Amount</td><td style="padding:14px 20px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.primary};font-weight:600;text-align:right;">${amount.toFixed(2)} ILS</td></tr>
        <tr><td style="padding:14px 20px;font-size:14px;color:${BRAND.muted};">Date</td><td style="padding:14px 20px;font-size:14px;color:${BRAND.primary};font-weight:600;text-align:right;">${date}</td></tr>
      </table>
      ${button(`${env.FRONTEND_URL}/upload`, 'Go to my event')}
      <p style="margin:20px 0 0 0;font-size:13px;color:${BRAND.muted};text-align:center;">Need help? Just reply to this email.</p>
    `;
    await this.sendEmail({
      to,
      subject,
      htmlBody: renderLayout({ preheader: `Your payment for ${eventName} was successful`, body }),
    });
  }

  async sendPasswordConfirmationEmail(to: string, name?: string): Promise<void> {
    const subject = `Password updated - ${BRAND.name}`;
    const hi = name ? `Hi ${name},` : 'Hi,';
    const body = `
      <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:700;color:${BRAND.primary};">Password updated</h1>
      <p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">${hi}</p>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">Your password was successfully updated. You can now sign in to your ${BRAND.name} account with the new password.</p>
      ${button(`${env.FRONTEND_URL}/login`, 'Go to login')}
      <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;padding:14px 18px;margin:24px 0 0 0;">
        <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">If you did not make this change, please contact support immediately.</p>
      </div>
    `;
    await this.sendEmail({
      to,
      subject,
      htmlBody: renderLayout({ preheader: 'Your password was successfully updated', body }),
    });
  }
}

export const emailService = new EmailService();
