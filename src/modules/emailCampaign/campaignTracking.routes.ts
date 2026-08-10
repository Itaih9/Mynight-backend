import { Router, Request, Response } from 'express';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';
import { verifyClickToken, isPreviewFetch } from './campaignTracking';
import { emailCampaignService } from './emailCampaign.service';

/**
 * The click counter behind campaign CTAs: /api/t/<token> → count → 302.
 *
 * Every path ends in a redirect. A bad or expired token means someone is
 * standing in front of a link that doesn't work, and the site is a better answer
 * than an error page.
 */
const router = Router();

router.get('/:token', async (req: Request, res: Response) => {
  // A cached redirect is an uncounted click.
  res.set('Cache-Control', 'no-store');

  const claim = verifyClickToken(req.params.token);
  if (!claim) {
    res.redirect(302, env.FRONTEND_URL);
    return;
  }

  let destination = env.FRONTEND_URL;
  try {
    destination = await emailCampaignService.destinationFor(claim.campaignId, claim.eventId, claim.channel);

    // HEAD is a link checker, not a reader.
    if (req.method === 'GET' && !isPreviewFetch(req.get('user-agent'))) {
      await emailCampaignService.recordClick(claim.campaignId, claim.eventId);
    }
  } catch (err) {
    logger.error(`Click tracking failed for campaign ${claim.campaignId}: ${(err as Error).message}`);
  }

  res.redirect(302, destination);
});

export default router;
