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
      const { to } = req.body || {};
      if (!to || !String(to).includes('@')) {
        res.status(400).json({ success: false, error: 'A valid "to" address is required' });
        return;
      }
      await emailCampaignService.sendTest(req.params.id, String(to));
      res.json({ success: true, data: { sent: true, to } });
    } catch (error) { next(error); }
  }

  async history(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await emailCampaignService.history(req.params.id) });
    } catch (error) { next(error); }
  }
}

export const emailCampaignController = new EmailCampaignController();
