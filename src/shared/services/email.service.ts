import sgMail from '@sendgrid/mail';
import axios from 'axios';
import { ses } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';
import { AppError } from '@/shared/utils/errors';
import { buildIcs, googleCalendarUrl, type CalendarEvent } from '@/shared/utils/calendar';
import { generateEventQrBuffer } from './qr.service';

interface EmailAttachment {
  filename: string;
  /** Text attachments (e.g. .ics): raw utf-8 string, base64'd on send. */
  content?: string;
  /** Binary attachments (e.g. PNG): already base64 — used as-is. */
  contentBase64?: string;
  type: string;
  /** Set → embedded inline image (referenced in HTML as cid:<contentId>). */
  contentId?: string;
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

/**
 * Where an upsell CTA sends a couple: straight into checkout for the החכמה
 * package, not the /here-i-am page. That page asks for contact details, and a
 * couple who has just clicked "שדרוג ל-My Night" has already decided — making
 * them request a call back loses them. It is also titled "Here I Am", a product
 * name they have never seen, right after an email that said My Night.
 *
 * No ?price: the server charges the package's own price, and the checkout page
 * reads it from /api/packages, so a link in an old email can never quote a
 * stale figure.
 */
const UPGRADE_CHECKOUT_URL = () => `${env.FRONTEND_URL}/register?package=Here%20I%20Am`;

const SENDGRID_ENABLED = Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
const BREVO_ENABLED = Boolean(env.BREVO_API_KEY);

if (SENDGRID_ENABLED) sgMail.setApiKey(env.SENDGRID_API_KEY!);

// warn, not info: the logger sits at 'warn' in production, and knowing which
// providers were live at boot is the first thing you want when mail stops.
logger.warn(
  `Email providers available: ${[BREVO_ENABLED && 'Brevo', SENDGRID_ENABLED && 'SendGrid', 'SES']
    .filter(Boolean)
    .join(' -> ')}`
);

const BRAND = {
  // Served from our own domain, not a free image host. The previous postimg.cc
  // link had 404'd, which is why the logo stopped rendering — those links expire.
  // Must stay a PNG/JPG: email clients don't render SVG.
  // ?v bump busts mail-client/Gmail-proxy image caches when the asset changes.
  logoUrl: `${env.FRONTEND_URL}/logo-email.png?v=2`,
  name: 'MyNight',
  tagline: 'Photo Matching Made Easy',
  // Stationery palette — matches the site (paper + charcoal ink + brand gold).
  // Bright gold is for fills/rules only; gold TEXT uses accentDark so it stays
  // legible on white (WCAG AA).
  primary: '#1C1917',   // charcoal ink — headings, body
  accent: '#F5C518',    // brand gold — button fills, ornaments
  accentDark: '#7A5B0E', // darkened gold — legible gold-coloured text
  bg: '#F4F1EC',        // warm paper backdrop
  cardBg: '#FFFFFF',    // card stock
  text: '#1C1917',
  muted: '#57534E',
  border: '#E6D5A8',    // gold hairline (solid hex — Outlook-safe)
  success: '#2E7D5B',
  serif: "Georgia,'Times New Roman',serif", // elegant heading face, email-safe
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
                      <!-- Text wordmark, not an image: always crisp, never blocked
                           or downscaled by the mail client, no proxy caching. -->
                      <div style="font-family:${BRAND.serif};font-style:italic;font-weight:700;font-size:36px;letter-spacing:0.5px;color:${BRAND.primary};line-height:1;">My Night</div>
                      <!-- gold hairline under the wordmark, like the printed stationery -->
                      <div style="margin:12px auto 0;width:132px;height:1px;background:${BRAND.accent};line-height:1px;font-size:0;">&nbsp;</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:16px;padding:40px 36px;box-shadow:0 10px 30px rgba(92,78,56,0.07);">
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

/** Primary action — gold fill with charcoal text, matching the site's button. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px auto;">
    <tr>
      <td align="center" style="background:${BRAND.accent};border-radius:12px;">
        <a href="${href}" target="_blank" style="display:inline-block;padding:15px 30px;color:${BRAND.primary};text-decoration:none;font-size:15px;font-weight:700;letter-spacing:0.3px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

/** Gold hairline with a small centred diamond — the stationery section divider. */
function rule(): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:28px auto;">
    <tr>
      <td style="width:70px;height:1px;background:${BRAND.border};line-height:1px;font-size:0;">&nbsp;</td>
      <td style="padding:0 12px;color:${BRAND.accentDark};font-size:11px;line-height:1;">&#9670;</td>
      <td style="width:70px;height:1px;background:${BRAND.border};line-height:1px;font-size:0;">&nbsp;</td>
    </tr>
  </table>`;
}

class EmailService {
  private fromEmail = SENDGRID_ENABLED ? env.SENDGRID_FROM_EMAIL! : env.SES_EMAIL_FROM;
  private fromName = env.SENDGRID_FROM_NAME || BRAND.name;
  // SES rejects any Source that isn't a verified identity, and the two providers
  // verify senders independently — so the SendGrid address is not automatically
  // usable here. Falls back to it anyway: both live under mynight.co.il, which is
  // verified as a domain in SES, so any address on it is a valid Source.
  private sesFromEmail = env.SES_EMAIL_FROM || env.SENDGRID_FROM_EMAIL!;
  // Brevo rejects a sender whose domain isn't authenticated in the Brevo
  // account, so this must be an address on the domain set up there.
  private brevoFromEmail = env.BREVO_FROM_EMAIL || env.SENDGRID_FROM_EMAIL || env.SES_EMAIL_FROM;

  /**
   * Send through the first provider that accepts the message.
   *
   * A provider-level failure — exhausted credits, revoked key, lapsed plan — is
   * account-wide and lasts until someone fixes the billing. With a single
   * provider that took the whole product down: sign-in is gated behind an
   * emailed code, so an empty SendGrid balance locked customers out of albums
   * they had paid for, and locked us out of our own admin panel. Hence a chain,
   * and hence the order.
   *
   * Brevo first because it is the one that actually delivers: SendGrid ran dry
   * on 2026-08-04 and SES is still sandboxed (it can only reach addresses
   * verified in the AWS account, which no customer ever will be). SES stays on
   * the end as a last resort that at least reaches our own verified addresses.
   */
  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, subject } = params;

    const chain: { name: string; send: () => Promise<void> }[] = [];
    if (BREVO_ENABLED) chain.push({ name: 'Brevo', send: () => this.sendViaBrevo(params) });
    if (SENDGRID_ENABLED) chain.push({ name: 'SendGrid', send: () => this.sendViaSendGrid(params) });
    chain.push({ name: 'SES', send: () => this.sendViaSes(params) });

    const failures: string[] = [];
    for (const provider of chain) {
      try {
        await provider.send();
        if (failures.length) {
          // Succeeding only after a fallback means the primary is broken —
          // that belongs at warn, where it will actually be seen, rather than
          // dying at info like every successful send before it.
          logger.warn(`Email to ${to} sent via ${provider.name} after ${failures.join(' | ')}`);
        } else {
          logger.info(`Email sent to ${to} via ${provider.name}: ${subject}`);
        }
        return;
      } catch (error: any) {
        failures.push(`${provider.name} failed (${error.message})`);
      }
    }

    logger.error(`Email to ${to} failed on every provider: ${failures.join(' | ')}`);
    throw new AppError(`Email sending failed: ${failures.join(' | ')}`, 500);
  }

  private async sendViaSendGrid({ to, subject, htmlBody, textBody, attachments }: SendEmailParams): Promise<void> {
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
                content: a.contentBase64 ?? Buffer.from(a.content ?? '', 'utf-8').toString('base64'),
                type: a.type,
                disposition: a.contentId ? ('inline' as const) : ('attachment' as const),
                ...(a.contentId ? { content_id: a.contentId } : {}),
              })),
            }
          : {}),
      });
    } catch (error: any) {
      throw new Error(error?.response?.body?.errors?.[0]?.message || error.message);
    }
  }

  /**
   * Brevo's transactional endpoint. Inline (cid:) images are sent as ordinary
   * attachments — Brevo has no content-id equivalent here — so any mail that
   * embeds an image has to still read correctly with it detached, which is the
   * same constraint the SES path already imposes.
   */
  private async sendViaBrevo({ to, subject, htmlBody, textBody, attachments }: SendEmailParams): Promise<void> {
    try {
      const res = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { email: this.brevoFromEmail, name: this.fromName },
          to: [{ email: to }],
          subject,
          htmlContent: htmlBody,
          textContent: textBody || htmlBody.replace(/<[^>]*>/g, ''),
          ...(attachments?.length
            ? {
                attachment: attachments.map((a) => ({
                  name: a.filename,
                  content: a.contentBase64 ?? Buffer.from(a.content ?? '', 'utf-8').toString('base64'),
                })),
              }
            : {}),
        },
        {
          headers: { 'api-key': env.BREVO_API_KEY!, 'Content-Type': 'application/json' },
          timeout: 20000,
        }
      );
      if (!res.data?.messageId) throw new Error('Brevo accepted the request but returned no messageId');
    } catch (error: any) {
      throw new Error(error?.response?.data?.message || error?.response?.data?.code || error.message);
    }
  }

  /**
   * Attachments are dropped here: this uses sendEmail, and attachment support
   * would need sendRawEmail with hand-built MIME. Any mail that attaches
   * something has to still make sense without it.
   */
  private async sendViaSes({ to, subject, htmlBody, textBody }: SendEmailParams): Promise<void> {
    try {
      await ses
        .sendEmail({
          Source: this.sesFromEmail,
          Destination: { ToAddresses: [to] },
          Message: {
            // Charset is REQUIRED for Hebrew. SES falls back to 7-bit ASCII when
            // it's omitted, which turns every non-Latin character into '?'.
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: htmlBody, Charset: 'UTF-8' },
              Text: { Data: textBody || htmlBody.replace(/<[^>]*>/g, ''), Charset: 'UTF-8' },
            },
          },
        })
        .promise();
    } catch (error: any) {
      // Plain Error, not AppError: sendEmail owns the logging and the final
      // failure, so every provider in the chain reports the same way.
      throw new Error(error.message);
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
   * Renders an admin-authored campaign (structured blocks) into the branded RTL
   * layout and sends it. Authors never touch HTML, so a campaign can't break
   * rendering; tokens are substituted by the caller before this point.
   */
  async sendCampaignEmail(opts: {
    to: string;
    subject: string;
    blocks: {
      title?: string;
      paragraphs?: string[];
      bullets?: string[];
      ctaText?: string;
      ctaUrl?: string;
      footnote?: string;
    };
  }): Promise<void> {
    const b = opts.blocks;
    const parts: string[] = [];

    if (b.title) {
      parts.push(`<h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};">${b.title}</h1>`);
    }
    for (const p of b.paragraphs || []) {
      if (!p?.trim()) continue;
      parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">${p}</p>`);
    }
    const bullets = (b.bullets || []).filter((x) => x?.trim());
    if (bullets.length) {
      parts.push(`
      <div style="background:${BRAND.bg};border-right:3px solid ${BRAND.accent};border-radius:8px;padding:18px 22px;margin:24px 0;">
        <ul style="margin:0;padding-right:18px;padding-left:0;font-size:14px;line-height:1.9;color:${BRAND.text};">
          ${bullets.map((x) => `<li>${x}</li>`).join('')}
        </ul>
      </div>`);
    }
    if (b.ctaText && b.ctaUrl) {
      parts.push(button(b.ctaUrl, b.ctaText));
    }
    if (b.footnote) {
      parts.push(`<p style="margin:24px 0 0 0;font-size:13px;color:${BRAND.muted};">${b.footnote}</p>`);
    }

    await this.sendEmail({
      to: opts.to,
      subject: opts.subject,
      htmlBody: renderLayout({
        preheader: b.paragraphs?.[0]?.slice(0, 120),
        body: parts.join('\n'),
        dir: 'rtl',
      }),
    });
  }

  /**
   * Sent when a couple registers for FREE פלאש. Confirms their camera link and
   * plants the Here I Am pitch — free covers the shooting, the paid layer is
   * what finds each guest their own photos.
   */
  async sendFlashWelcomeEmail(opts: {
    to: string;
    coupleName: string;
    eventCode: string;
    weddingDate: Date;
    phoneNumber?: string;
  }): Promise<void> {
    const link = `${env.FRONTEND_URL}/camera/${opts.eventCode}`;
    const dateLabel = new Date(opts.weddingDate).toLocaleDateString('he-IL');
    // Embed the QR inline (CID) so no mail client has to fetch it remotely —
    // works in Gmail, Spark, Apple Mail, Outlook alike.
    const qrPng = await generateEventQrBuffer(opts.eventCode);
    // Show the number in familiar local form (+972501234567 -> 0501234567).
    const phoneLocal = opts.phoneNumber ? opts.phoneNumber.replace(/^\+972/, '0') : '';
    const body = `
      <p style="margin:0 0 10px 0;font-size:11px;font-weight:700;letter-spacing:3px;color:${BRAND.accentDark};text-align:center;">הפלאש שלכם</p>
      <h1 style="margin:0 0 14px 0;font-family:${BRAND.serif};font-size:32px;font-weight:400;line-height:1.2;color:${BRAND.primary};text-align:center;">הפלאש שלכם מוכן</h1>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:${BRAND.text};text-align:center;">${opts.coupleName}, מזל טוב! הכנו לכם מצלמה חד-פעמית לאורחים לחתונה ב-${dateLabel}.</p>
      ${rule()}
      <div style="background:${BRAND.bg};border-right:3px solid ${BRAND.accent};border-radius:8px;padding:18px 22px;margin:24px 0;">
        <p style="margin:0 0 10px 0;font-size:14px;font-weight:700;color:${BRAND.primary};">הקישור לאורחים</p>
        <p style="margin:0 0 10px 0;font-size:14px;line-height:1.8;color:${BRAND.text};word-break:break-all;">${link}</p>
        <p style="margin:0;font-size:13px;color:${BRAND.muted};">כל אורח מקבל 8 צילומים. בלי לראות, בלי לחזור אחורה — הכל מתפתח בבוקר שאחרי.</p>
      </div>
      ${button(link, 'לצפייה במצלמה')}
      <div style="background:#fff;border:1px solid ${BRAND.border};border-radius:12px;padding:22px;margin:26px 0;text-align:center;">
        <p style="margin:0 0 4px 0;font-family:${BRAND.serif};font-size:21px;font-weight:400;color:${BRAND.primary};">קוד ה-QR לאורחים</p>
        <p style="margin:0 0 14px 0;font-size:13px;color:${BRAND.muted};">הדפיסו והציבו — האורחים סורקים ומצלמים, בלי אפליקציה.</p>
        <img src="cid:eventqr" alt="קוד QR" width="190" height="190" style="display:inline-block;border:1px solid ${BRAND.border};border-radius:12px;background:#fff;padding:8px;" />
        <div style="margin:16px 0 0 0;">${button(`${env.FRONTEND_URL}/api/events/code/${opts.eventCode}/qr.png?download=1`, 'הורדת קוד ה-QR')}</div>
        <div style="margin:18px auto 0 auto;text-align:right;max-width:430px;background:${BRAND.bg};border-radius:8px;padding:14px 18px;">
          <p style="margin:0 0 6px 0;font-size:13px;font-weight:700;color:${BRAND.primary};">איפה להדפיס ולהציב</p>
          <ul style="margin:0;padding-right:18px;padding-left:0;font-size:13px;line-height:1.9;color:${BRAND.text};">
            <li>הדפיסו בגודל A5–A4 על נייר מט</li>
            <li>על שולחן קבלת הפנים וליד ספר הברכות</li>
            <li>מסגרת קטנה על כל שולחן אורחים</li>
            <li>ליד הבר ובאזור רחבת הריקודים</li>
          </ul>
        </div>
      </div>
      <p style="margin:0 0 4px 0;font-size:14px;line-height:1.8;color:${BRAND.text};"><strong>איך רואים את התמונות?</strong></p>
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.8;color:${BRAND.muted};">בבוקר שאחרי החתונה, היכנסו ל-<a href="${env.FRONTEND_URL}/login?method=phone" style="color:${BRAND.accentDark};">${env.FRONTEND_URL.replace(/^https?:\/\//, '')}/login</a> עם מספר הטלפון ${phoneLocal ? `<strong style="color:${BRAND.text};" dir="ltr">${phoneLocal}</strong>` : 'שאיתו נרשמתם'} — האלבום שלכם יחכה שם.</p>
      ${rule()}
      <div style="background:#FFF7F7;border:1px solid ${BRAND.border};border-radius:12px;padding:22px 24px;margin:8px 0 0 0;text-align:center;">
        <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:2px;color:${BRAND.accentDark};">החבילה החכמה של My Night</p>
        <p style="margin:0 0 10px 0;font-family:${BRAND.serif};font-size:22px;font-weight:400;line-height:1.25;color:${BRAND.primary};">רוצים שכל אורח יקבל את התמונות שלו?</p>
        <p style="margin:0 0 14px 0;font-size:14px;line-height:1.8;color:${BRAND.text};text-align:right;">פלאש קורה בחתונה שלכם. <strong>My Night</strong> מתחיל לעבוד בבוקר אחרי, ומרכיב לכל אחד את האלבום שלו, בזיהוי חכם. כל אורח מקבל רק את התמונות שהוא מופיע בהן. ואתם מקבלים את כל החתונה במקום אחד, בלי לחפש ובלי לתייג. זיכרון מושלם, אפס מאמץ.</p>
        ${button(UPGRADE_CHECKOUT_URL(), 'שדרוג ל-My Night')}
      </div>
      <p style="margin:24px 0 0 0;font-size:14px;color:${BRAND.muted};">יש שאלה? פשוט השיבו למייל הזה.</p>
    `;
    await this.sendEmail({
      to: opts.to,
      subject: `הפלאש שלכם מוכן — ${opts.coupleName} 📸`,
      htmlBody: renderLayout({ preheader: `הקישור למצלמה של האורחים מוכן.`, body, dir: 'rtl' }),
      attachments: [
        { filename: 'qr.png', contentBase64: qrPng.toString('base64'), type: 'image/png', contentId: 'eventqr' },
      ],
    });
  }

  /**
   * Pre-wedding nudge for free פלאש couples who haven't bought yet. Tone shifts
   * with proximity — informative far out, time-bound close in.
   */
  async sendFlashUpsellEmail(opts: {
    to: string;
    coupleName: string;
    eventCode: string;
    daysUntilWedding: number;
  }): Promise<void> {
    const urgent = opts.daysUntilWedding <= 7;
    const headline = urgent
      ? `עוד ${opts.daysUntilWedding} ימים לחתונה שלכם`
      : `${opts.coupleName}, נשארו ${opts.daysUntilWedding} ימים`;
    const body = `
      <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:${BRAND.primary};">${headline}</h1>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">פלאש כבר מוכן — האורחים שלכם יצלמו, ואתם תקבלו את כל התמונות בבוקר שאחרי.</p>
      <div style="background:${BRAND.bg};border-right:3px solid ${BRAND.accent};border-radius:8px;padding:18px 22px;margin:24px 0;">
        <p style="margin:0 0 10px 0;font-size:14px;font-weight:700;color:${BRAND.primary};">מה שפלאש לא עושה לבד</p>
        <ul style="margin:0;padding-right:18px;padding-left:0;font-size:14px;line-height:1.9;color:${BRAND.text};">
          <li>כל אורח מקבל אלבום אישי — רק עם התמונות שהוא בהן</li>
          <li>גם התמונות מהצלם המקצועי נכנסות לזיהוי הפנים</li>
          <li>סטורי מוכן כבר ביום שאחרי החתונה</li>
        </ul>
      </div>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:${BRAND.text};">פלאש קורה בחתונה שלכם. <strong>My Night</strong> מתחיל לעבוד בבוקר אחרי. אפשר לשדרג עד ליום החתונה.</p>
      ${button(UPGRADE_CHECKOUT_URL(), 'שדרוג ל-My Night')}
      <p style="margin:24px 0 0 0;font-size:13px;color:${BRAND.muted};">לא מעוניינים? אפשר להתעלם — פלאש נשאר שלכם בחינם.</p>
    `;
    await this.sendEmail({
      to: opts.to,
      subject: urgent
        ? `עוד ${opts.daysUntilWedding} ימים — רוצים שכל אורח יקבל את התמונות שלו?`
        : `${opts.coupleName}, שדרוג אחד לפני החתונה`,
      htmlBody: renderLayout({ preheader: `זיהוי פנים לכל אורח, כולל תמונות הצלם.`, body, dir: 'rtl' }),
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

  /** Lead alert for a new פלאש signup — the free tier's counterpart to the payment notification. */
  async sendSignupAdminNotification(opts: {
    coupleName: string;
    eventCode: string;
    weddingDate?: Date;
    phoneNumber?: string;
    contactEmail?: string;
    tier: 'basic' | 'plus';
  }): Promise<void> {
    const { coupleName, eventCode, weddingDate, phoneNumber, contactEmail, tier } = opts;

    const row = (label: string, value: string) =>
      `<tr><td style="padding:8px 0;font-size:14px;color:${BRAND.muted};white-space:nowrap;">${label}</td>
        <td style="padding:8px 0 8px 16px;font-size:14px;font-weight:600;color:${BRAND.text};">${value}</td></tr>`;

    let dateStr = '—';
    if (weddingDate) {
      dateStr = weddingDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
      // How long the upsell window actually is — the whole pre-wedding sequence
      // has to land before this date, so it is the first thing worth knowing.
      const days = Math.ceil((weddingDate.getTime() - Date.now()) / 86_400_000);
      if (days > 0) dateStr += ` · בעוד ${days} ימים`;
    }

    const body = `
      <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:${BRAND.primary};">הרשמה חדשה לפלאש ✨</h1>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:16px;border-collapse:collapse;">
        ${row('הזוג', coupleName)}
        ${row('קוד אירוע', eventCode)}
        ${row('תאריך חתונה', dateStr)}
        ${row('טלפון', phoneNumber || '—')}
        ${row('אימייל', contactEmail || '—')}
        ${row('חבילה', tier === 'plus' ? 'פלאש+' : 'פלאש (חינם)')}
      </table>
      ${button(`${env.FRONTEND_URL}/camera/${eventCode}`, 'מצלמת האורחים')}
    `;

    await this.sendEmail({
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: `✨ הרשמה חדשה — ${coupleName} (${eventCode})`,
      htmlBody: renderLayout({ preheader: `${coupleName} · ${dateStr}`, body, dir: 'rtl' }),
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
