import convert from 'heic-convert';

/**
 * Rekognition reads JPEG and PNG only. A selfie picked from a phone's gallery
 * is often HEIC — Samsung and iPhone both save photos that way — and handing
 * it over as-is fails with "Request has invalid image format", which the guest
 * sees as an error on the selfie screen. So HEIC/HEIF is converted to JPEG
 * first; anything else passes through untouched.
 *
 * Detection is by the file's own bytes, not the declared type: browsers send
 * HEIC as image/heic, image/heif or application/octet-stream depending on the
 * phone.
 */

/** ISO-BMFF brands used by HEIC/HEIF stills and sequences. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

export const isHeif = (buffer: Buffer): boolean =>
  buffer.length >= 12 &&
  buffer.toString('ascii', 4, 8) === 'ftyp' &&
  HEIF_BRANDS.has(buffer.toString('ascii', 8, 12));

export interface SelfieImage {
  buffer: Buffer;
  mimeType: string;
  /** File name to store under, with an extension that matches the bytes. */
  name: string;
}

const JPEG_QUALITY = 0.9;

export async function toRekognitionImage(file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<SelfieImage> {
  if (!isHeif(file.buffer)) {
    return { buffer: file.buffer, mimeType: file.mimetype, name: file.originalname };
  }
  const jpeg = await convert({ buffer: file.buffer, format: 'JPEG', quality: JPEG_QUALITY });
  const base = file.originalname.replace(/\.[^./\\]*$/, '') || 'selfie';
  return { buffer: Buffer.from(jpeg), mimeType: 'image/jpeg', name: `${base}.jpg` };
}
