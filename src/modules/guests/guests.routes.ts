import { Router } from 'express';
import { guestsController } from './guests.controller';
import { validate } from '@/shared/middleware/validation.middleware';
import { protect } from '@/shared/middleware/auth.middleware';
import { addGuestSchema, addGuestsBulkSchema, updateGuestSchema } from './guests.validation';

const router = Router();

router.post('/event/:eventId', protect, validate(addGuestSchema), guestsController.addGuest);
router.post('/event/:eventId/bulk', protect, validate(addGuestsBulkSchema), guestsController.addGuestsBulk);
router.get('/event/:eventId', protect, guestsController.getEventGuests);
router.put('/event/:eventId/:guestId', protect, validate(updateGuestSchema), guestsController.updateGuest);
router.delete('/event/:eventId/:guestId', protect, guestsController.deleteGuest);
router.delete('/event/:eventId', protect, guestsController.deleteAllGuests);

export default router;
