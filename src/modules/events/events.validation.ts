import { z } from 'zod';

export const createEventSchema = z.object({
  name: z.string().min(3, 'Event name must be at least 3 characters'),
});

export const getEventByCodeSchema = z.object({
  eventCode: z.string().length(8, 'Invalid event code'),
});

export const updateSharingPermissionsSchema = z.object({
  showProPhotos: z.boolean().optional(),
  showGuestPhotos: z.boolean().optional(),
  showGuestStories: z.boolean().optional(),
});

export const updateSlugSchema = z.object({
  customSlug: z.string().min(3, 'Slug must be at least 3 characters').regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
});
