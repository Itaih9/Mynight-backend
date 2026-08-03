import QRCode from 'qrcode';
import { s3 } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';

/**
 * The camera-link QR, hosted as a STATIC image on S3/CloudFront.
 *
 * Emails reference this CloudFront URL rather than the dynamic /qr.png endpoint:
 * a static, immutable image is what mail-client image proxies (Gmail, etc.)
 * handle most reliably — same reason the landing photos moved to CloudFront.
 */
const qrKey = (eventCode: string) => `static/qr/${eventCode.toUpperCase()}.png`;

export async function ensureEventQrUrl(eventCode: string): Promise<string> {
  const key = qrKey(eventCode);
  const url = `${env.CLOUDFRONT_URL}/${key}`;
  try {
    const target = `${env.FRONTEND_URL}/camera/${eventCode}`;
    const png = await QRCode.toBuffer(target, {
      type: 'png',
      width: 720,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1A1A1A', light: '#FFFFFF' },
    });
    await s3
      .putObject({
        Bucket: env.S3_BUCKET_NAME,
        Key: key,
        Body: png,
        ContentType: 'image/png',
        CacheControl: 'public, max-age=31536000, immutable',
      })
      .promise();
  } catch (e) {
    logger.error(`QR upload failed for ${eventCode}: ${(e as Error).message}`);
  }
  return url;
}
