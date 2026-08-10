import { Request, Response, NextFunction } from 'express';
import { emailCampaignService } from './emailCampaign.service';

export class EmailCampaignController {
  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await emailCampaignService.list() });
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json({ success: true, data: await emailCampaignService.create(req.body) });
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await emailCampaignService.update(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      await emailCampaignService.remove(req.params.id);
      res.json({ success: true, data: { deleted: true } });
    } catch (error) { next(error); }
  }

  /** WhatsApp templates available in the Wati account. */
  async waTemplates(_req: Request, res: Response, next: NextFunction) {
    try {
      const { whatsappService } = await import('@/shared/services/whatsapp.service');
      res.json({ success: true, data: { configured: whatsappService.isConfigured, templates: await whatsappService.listTemplates() } });
    } catch (error) { next(error); }
  }

  /** Searchable contact list for the recipient picker. */
  async contacts(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await emailCampaignService.listContacts(String(req.query.search || ''));
      res.json({ success: true, data: rows });
    } catch (error) { next(error); }
  }

  /** Dry run — who would receive what, right now. Sends nothing. */
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await emailCampaignService.run({
        dryRun: true,
        campaignId: req.query.campaignId as string | undefined,
      });
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  /** Run for real, now, instead of waiting for the next tick. */
  async run(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await emailCampaignService.run({
        campaignId: req.body?.campaignId,
      });
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async sendTest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { to, channel } = req.body || {};
      const ch = channel === 'whatsapp' ? 'whatsapp' : 'email';
      if (!to || (ch === 'email' && !String(to).includes('@'))) {
        res.status(400).json({ success: false, error: 'A valid destination is required' });
        return;
      }
      await emailCampaignService.sendTest(req.params.id, String(to), ch);
      res.json({ success: true, data: { sent: true, to, channel: ch } });
    } catch (error) { next(error); }
  }

  async history(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await emailCampaignService.history(req.params.id) });
    } catch (error) { next(error); }
  }

  /** Delivery and click counts for one campaign. */
  async stats(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await emailCampaignService.stats(req.params.id) });
    } catch (error) { next(error); }
  }
}

export const emailCampaignController = new EmailCampaignController();
