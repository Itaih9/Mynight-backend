import { Router, Request, Response, NextFunction } from 'express';
import QRCode from 'qrcode';
import { trackedLinkService } from './trackedLink.service';
import { adminProtect } from '../admin/admin.middleware';
import { isPreviewFetch } from '../emailCampaign/campaignTracking';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';

/**
 * Tracked short links behind printed QR codes: /api/q/<code> → count → 302.
 *
 * Mounted under /api deliberately. nginx proxies `^~ /api` and nothing else, so
 * a root-level /q/ would fall through to the SPA, render the site with a 200,
 * and count nothing — which is exactly how the campaign tracker was first built
 * wrong.
 */
const router = Router();

// ---- admin ------------------------------------------------------------------
router.post('/', adminProtect, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targetUrl, label, code } = req.body || {};
    const link = await trackedLinkService.create({ targetUrl, label, code });
    res.status(201).json({
      success: true,
      data: {
        code: link.code,
        label: link.label,
        targetUrl: link.targetUrl,
        scanUrl: trackedLinkService.scanUrl(link.code),
        qrUrl: `${env.FRONTEND_URL}/api/q/${link.code}/qr.png`,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', adminProtect, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await trackedLinkService.list() });
  } catch (error) {
    next(error);
  }
});

/**
 * Retire a printed QR, or bring it back. Not a delete — see the service for
 * why a code that is already on a wall has to outlive its campaign.
 */
router.patch('/:code/active', adminProtect, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const link = await trackedLinkService.setActive(req.params.code, (req.body || {}).isActive);
    res.json({
      success: true,
      data: { code: link.code, label: link.label, isActive: link.isActive },
      message: link.isActive
        ? 'Link is live again'
        : 'Link retired — scans stop counting and go to the home page',
    });
  } catch (error) {
    next(error);
  }
});

/** One link's own numbers, for the page that shows a single QR. */
router.get('/:code/stats', adminProtect, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days === undefined ? undefined : Number(req.query.days);
    res.json({ success: true, data: await trackedLinkService.stats(req.params.code, days) });
  } catch (error) {
    next(error);
  }
});

// ---- public ------------------------------------------------------------------
/**
 * The QR image for a tracked link. Public, because it is fetched by whatever is
 * laying out the poster, and it reveals nothing the printed code does not.
 */
router.get('/:code/qr.png', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const link = await trackedLinkService.get(req.params.code);
    const png = await QRCode.toBuffer(trackedLinkService.scanUrl(link.code), {
      type: 'png',
      // Same as the guest camera QR: printed, then scanned across a room.
      width: 1200,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#1A1A1A', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="mynight-qr-${link.code}.png"`);
    }
    res.send(png);
  } catch (error) {
    next(error);
  }
});

/**
 * The scan. Every path ends in a redirect: somebody is standing in front of a
 * poster with their camera open, and an error page is never the right answer.
 */
router.get('/:code', async (req: Request, res: Response) => {
  // A cached redirect is an uncounted scan.
  res.set('Cache-Control', 'no-store');
  try {
    // Link previewers and bots fetch a URL without a human ever seeing it;
    // counting those would inflate every number the QR is meant to report.
    if (isPreviewFetch(req.get('user-agent'))) {
      const link = await trackedLinkService.get(req.params.code).catch(() => null);
      // A retired link sends a previewer to the front door too. Before
      // anything could be retired this branch could not disagree with the
      // counted path below; now it can, and a dead poster whose preview
      // still resolved to the old target would be the one place the
      // retirement did not take.
      res.redirect(302, link && link.isActive ? link.targetUrl : env.FRONTEND_URL);
      return;
    }
    const destination = await trackedLinkService.recordScan(req.params.code);
    res.redirect(302, destination || env.FRONTEND_URL);
  } catch (err) {
    logger.error(`Tracked-link scan failed for ${req.params.code}: ${(err as Error).message}`);
    res.redirect(302, env.FRONTEND_URL);
  }
});

export default router;
