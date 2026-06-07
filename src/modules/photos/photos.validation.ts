import { z } from 'zod';

export const getPresignedUrlSchema = z.object({
  eventId: z.string(),
  fileName: z.string(),
  fileType: z.string().regex(/^(image\/(jpeg|jpg|png|webp|gif|heic|heif)|video\/(mp4|mov|quicktime|webm|mpeg))$/, 'Invalid file type'),
});

export const completeUploadSchema = z.object({
  eventId: z.string(),
  s3Key: z.string(),
  metadata: z.object({
    size: z.number(),
    mimeType: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
});

export const matchPhotosSchema = z.object({
  eventId: z.string(),
  selfieKey: z.string(),
});

export const guestPresignedUrlSchema = z.object({
  eventCode: z.string(),
  fileName: z.string(),
  fileType: z.string().regex(/^(image\/(jpeg|jpg|png|webp|gif|heic|heif)|video\/(mp4|mov|quicktime|webm|mpeg))$/, 'Invalid file type'),
});

export const guestCompleteUploadSchema = z.object({
  eventCode: z.string(),
  s3Key: z.string(),
  guestName: z.string().optional(),
  metadata: z.object({
    size: z.number(),
    mimeType: z.string(),
  }),
});
