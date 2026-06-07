import { Router } from 'express';
import { contactController } from './contact.controller';
import { adminProtect } from '../admin/admin.middleware';

const router = Router();

// Public endpoint - anyone can submit contact form
router.post('/submit', contactController.submit);

// Admin endpoints
router.get('/', adminProtect, contactController.getAll);
router.get('/stats', adminProtect, contactController.getStats);
router.get('/:contactId', adminProtect, contactController.getById);
router.patch('/:contactId/status', adminProtect, contactController.updateStatus);
router.delete('/:contactId', adminProtect, contactController.delete);

export default router;
