import axios from 'axios';
import { env } from '@/shared/config/env';
import { AppError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

/**
 * WhatsApp sending via Wati.
 *
 * Important constraint, and the reason campaign copy can't be authored here the
 * way email copy is: outside the 24-hour service window WhatsApp only permits
 * **pre-approved templates**. The wording lives in Wati/Meta, not in our admin —
 * we choose a template by name and supply its named variables. Sending arbitrary
 * text would simply be rejected.
 */
class WhatsAppService {
  private get enabled(): boolean {
    return Boolean(env.WATI_API_ENDPOINT && env.WATI_ACCESS_TOKEN);
  }

  /**
   * Wati expects a bare international number — digits only, no '+'. Our users
   * are stored as +972…, so strip anything that isn't a digit.
   */
  private normalize(phone: string): string {
    return (phone || '').replace(/\D/g, '');
  }

  /**
   * Returns the Wati/Meta message id when the response carries one — it's the
   * only reliable key for matching a later delivery webhook back to this send.
   * Wati's response shape varies by tenant and API version, so an absent id is
   * normal and callers fall back to matching on the phone number.
   */
  private messageIdOf(data: any): string | undefined {
    const id =
      data?.whatsappMessageId ||
      data?.message?.whatsappMessageId ||
      data?.message?.id ||
      data?.messageId ||
      data?.data?.whatsappMessageId ||
      data?.id;
    return id ? String(id) : undefined;
  }

  async sendTemplate(opts: {
    to: string;
    templateName: string;
    broadcastName?: string;
    parameters?: { name: string; value: string }[];
  }): Promise<{ messageId?: string }> {
    if (!this.enabled) {
      throw new AppError('WhatsApp is not configured (WATI_API_ENDPOINT / WATI_ACCESS_TOKEN)', 500);
    }

    const number = this.normalize(opts.to);
    if (!number) throw new AppError('A valid phone number is required', 400);

    const base = env.WATI_API_ENDPOINT!.replace(/\/+$/, '');
    const url = `${base}/api/v2/sendTemplateMessage?whatsappNumber=${number}`;

    try {
      const res = await axios.post(
        url,
        {
          template_name: opts.templateName,
          // Wati groups sends under this label in its dashboard.
          broadcast_name: opts.broadcastName || opts.templateName,
          parameters: opts.parameters || [],
        },
        {
          headers: {
            Authorization: `Bearer ${env.WATI_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      // Wati answers 200 with { result: false } on template/param errors, so a
      // 2xx alone is not success.
      const data: any = res.data;
      if (data && data.result === false) {
        throw new Error(data.info || data.message || 'Wati rejected the message');
      }
      logger.info(`WhatsApp template "${opts.templateName}" sent to ${number}`);
      return { messageId: this.messageIdOf(data) };
    } catch (error: any) {
      const detail = error?.response?.data?.info || error?.response?.data?.message || error.message;
      logger.error(`WhatsApp send failed to ${number}: ${detail}`);
      throw new AppError(`WhatsApp sending failed: ${detail}`, 500);
    }
  }

  /** Templates available in the Wati account, for the admin picker. */
  async listTemplates(): Promise<{ name: string; status?: string }[]> {
    if (!this.enabled) return [];
    const base = env.WATI_API_ENDPOINT!.replace(/\/+$/, '');
    try {
      const res = await axios.get(`${base}/api/v1/getMessageTemplates`, {
        headers: { Authorization: `Bearer ${env.WATI_ACCESS_TOKEN}` },
        timeout: 20000,
      });
      const list = (res.data?.messageTemplates || res.data?.result || res.data || []) as any[];
      return list
        .map((t) => ({ name: t.elementName || t.name, status: t.status }))
        .filter((t) => t.name);
    } catch (error: any) {
      logger.warn(`Could not list Wati templates: ${error.message}`);
      return [];
    }
  }

  get isConfigured(): boolean {
    return this.enabled;
  }
}

export const whatsappService = new WhatsAppService();
