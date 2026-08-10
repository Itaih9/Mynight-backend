import { Router } from 'express';
import { whatsappController } from './whatsapp.controller';

/**
 * Public because Wati calls it from their own servers with no credentials of
 * ours. WATI_WEBHOOK_SECRET in the URL is what keeps it from being an open
 * write; see whatsapp.controller.
 */
const router = Router();

router.post('/webhook', whatsappController.webhook);
router.get('/webhook', whatsappController.webhookHealth);

export default router;
