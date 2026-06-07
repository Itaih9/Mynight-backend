import { Guest, IGuest } from './guests.model';
import { Event } from '../events/events.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

interface GuestInput {
  name: string;
  phone: string;
  email?: string;
}

class GuestsService {
  async addGuest(eventId: string, userId: string, data: GuestInput): Promise<IGuest> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    const existingGuest = await Guest.findOne({ eventId, phone: data.phone });
    if (existingGuest) {
      throw new ValidationError('Guest with this phone already exists');
    }

    const guest = await Guest.create({
      eventId,
      name: data.name,
      phone: data.phone.replace(/\D/g, ''),
      email: data.email,
    });

    logger.info(`Guest added to event ${eventId}: ${data.name}`);
    return guest;
  }

  async addGuestsBulk(eventId: string, userId: string, guests: GuestInput[]): Promise<{ added: number; skipped: number; errors: string[] }> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const guestData of guests) {
      try {
        if (!guestData.name || !guestData.phone) {
          errors.push(`Missing name or phone for entry`);
          skipped++;
          continue;
        }

        const phone = guestData.phone.replace(/\D/g, '');
        if (phone.length < 9) {
          errors.push(`Invalid phone for ${guestData.name}: ${guestData.phone}`);
          skipped++;
          continue;
        }

        const existingGuest = await Guest.findOne({ eventId, phone });
        if (existingGuest) {
          skipped++;
          continue;
        }

        await Guest.create({
          eventId,
          name: guestData.name.trim(),
          phone,
          email: guestData.email?.trim(),
        });
        added++;
      } catch (err: any) {
        errors.push(`Error adding ${guestData.name}: ${err.message}`);
        skipped++;
      }
    }

    logger.info(`Bulk guests added to event ${eventId}: ${added} added, ${skipped} skipped`);
    return { added, skipped, errors };
  }

  async getEventGuests(eventId: string, userId: string): Promise<IGuest[]> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    return Guest.find({ eventId }).sort({ createdAt: -1 });
  }

  async updateGuest(guestId: string, eventId: string, userId: string, data: Partial<GuestInput>): Promise<IGuest> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    const guest = await Guest.findOneAndUpdate(
      { _id: guestId, eventId },
      {
        ...(data.name && { name: data.name }),
        ...(data.phone && { phone: data.phone.replace(/\D/g, '') }),
        ...(data.email !== undefined && { email: data.email }),
      },
      { new: true }
    );

    if (!guest) {
      throw new NotFoundError('Guest');
    }

    return guest;
  }

  async deleteGuest(guestId: string, eventId: string, userId: string): Promise<void> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    const guest = await Guest.findOneAndDelete({ _id: guestId, eventId });
    if (!guest) {
      throw new NotFoundError('Guest');
    }

    logger.info(`Guest deleted from event ${eventId}: ${guest.name}`);
  }

  async deleteAllGuests(eventId: string, userId: string): Promise<number> {
    const event = await Event.findOne({ _id: eventId, userId });
    if (!event) {
      throw new NotFoundError('Event');
    }

    const result = await Guest.deleteMany({ eventId });
    logger.info(`All guests deleted from event ${eventId}: ${result.deletedCount} guests`);
    return result.deletedCount;
  }

  async getGuestCount(eventId: string): Promise<number> {
    return Guest.countDocuments({ eventId });
  }
}

export const guestsService = new GuestsService();
