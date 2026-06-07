import { z } from 'zod';

export const addGuestSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  phone: z.string().min(9, 'Phone must be at least 9 digits'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
});

export const addGuestsBulkSchema = z.object({
  guests: z.array(
    z.object({
      name: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().optional(),
    })
  ).min(1, 'At least one guest is required'),
});

export const updateGuestSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(9).optional(),
  email: z.string().email().optional().or(z.literal('')),
});
