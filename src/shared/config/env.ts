import dotenv from 'dotenv';

dotenv.config();

interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  FRONTEND_URL: string;
  MONGO_URI: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  S3_BUCKET_NAME: string;
  CLOUDFRONT_URL: string;
  // Serve transcoded video renditions (display/{s3Key}.mp4). Turn on once the
  // transcode pipeline is writing them, so we don't 404 on missing renditions.
  VIDEO_RENDITIONS_ENABLED: boolean;
  REKOGNITION_MIN_CONFIDENCE: number;
  REKOGNITION_FACE_MATCH_THRESHOLD: number;
  SES_EMAIL_FROM: string;
  SES_REGION: string;
  SENDGRID_API_KEY?: string;
  // Wati (WhatsApp Business API). Endpoint includes the tenant id, e.g.
  // https://live-mt-server.wati.io/123456
  WATI_API_ENDPOINT?: string;
  WATI_ACCESS_TOKEN?: string;
  /**
   * Name of the approved Wati template used to deliver login/registration
   * codes. WhatsApp only permits pre-approved templates, so the wording lives
   * in Wati/Meta — we just pass the code as a named parameter. Unset means the
   * WhatsApp OTP fallback stays off.
   */
  WATI_OTP_TEMPLATE?: string;
  /**
   * Shared secret for the Wati webhook. Wati does not sign its callbacks, so the
   * only thing standing between the endpoint and the open internet is a secret
   * we put in the URL we hand Wati: .../api/whatsapp/webhook?token=<secret>.
   * Unset means the endpoint accepts anything — tolerable locally, not in
   * production, where anyone could then forge delivery stats.
   */
  WATI_WEBHOOK_SECRET?: string;
  /**
   * Public origin of THIS server, e.g. https://api.mynight.co.il. Campaign CTA
   * links are rewritten through it so clicks can be counted. Unset means links
   * go out untracked — they still work, they just point straight at the site.
   */
  PUBLIC_API_URL?: string;
  SENDGRID_FROM_EMAIL?: string;
  SENDGRID_FROM_NAME?: string;
  /**
   * Brevo (formerly Sendinblue). Tried FIRST when set: SendGrid ran out of
   * credits and SES is sandboxed, so this is the provider that actually
   * delivers. Free tier is 300/day, which covers current volume several times
   * over. Sender must be on a domain authenticated in Brevo, or mail is
   * rejected outright rather than merely landing in spam.
   */
  BREVO_API_KEY?: string;
  BREVO_FROM_EMAIL?: string;
  // Where new-payment notifications are sent.
  ADMIN_NOTIFY_EMAIL: string;
  SUMIT_COMPANY_ID: string;
  SUMIT_API_KEY: string;
  SUMIT_PUBLIC_KEY: string;
  INTERNAL_WEBHOOK_SECRET: string;
  // Static bearer token for automated admin API access (the Claude service
  // principal). Grants admin-level access EXCEPT deleting accounts or deleting
  // events it did not create. Unset => service-token auth is disabled entirely.
  SERVICE_API_TOKEN?: string;
}

const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
};

export const env: EnvConfig = {
  NODE_ENV: getEnv('NODE_ENV', 'development'),
  PORT: parseInt(getEnv('PORT', '3000')),
  FRONTEND_URL: getEnv('FRONTEND_URL'),
  MONGO_URI: getEnv('MONGO_URI'),
  JWT_SECRET: getEnv('JWT_SECRET'),
  JWT_EXPIRES_IN: getEnv('JWT_EXPIRES_IN', '7d'),
  AWS_ACCESS_KEY_ID: getEnv('AWS_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: getEnv('AWS_SECRET_ACCESS_KEY'),
  AWS_REGION: getEnv('AWS_REGION', 'us-east-1'),
  S3_BUCKET_NAME: getEnv('S3_BUCKET_NAME'),
  CLOUDFRONT_URL: getEnv('CLOUDFRONT_URL', ''),
  VIDEO_RENDITIONS_ENABLED: getEnv('VIDEO_RENDITIONS_ENABLED', 'false') === 'true',
  REKOGNITION_MIN_CONFIDENCE: parseInt(getEnv('REKOGNITION_MIN_CONFIDENCE', '80')),
  REKOGNITION_FACE_MATCH_THRESHOLD: parseInt(getEnv('REKOGNITION_FACE_MATCH_THRESHOLD', '70')),
  SES_EMAIL_FROM: getEnv('SES_EMAIL_FROM'),
  SES_REGION: getEnv('SES_REGION', 'us-east-1'),
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  WATI_API_ENDPOINT: process.env.WATI_API_ENDPOINT,
  WATI_ACCESS_TOKEN: process.env.WATI_ACCESS_TOKEN,
  WATI_OTP_TEMPLATE: process.env.WATI_OTP_TEMPLATE,
  WATI_WEBHOOK_SECRET: process.env.WATI_WEBHOOK_SECRET,
  PUBLIC_API_URL: process.env.PUBLIC_API_URL,
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME: process.env.SENDGRID_FROM_NAME,
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_FROM_EMAIL: process.env.BREVO_FROM_EMAIL,
  ADMIN_NOTIFY_EMAIL: process.env.ADMIN_NOTIFY_EMAIL || 'itaih9@gmail.com',
  SUMIT_COMPANY_ID: getEnv('SUMIT_COMPANY_ID', ''),
  SUMIT_API_KEY: getEnv('SUMIT_API_KEY', ''),
  SUMIT_PUBLIC_KEY: getEnv('SUMIT_PUBLIC_KEY', ''),
  INTERNAL_WEBHOOK_SECRET: getEnv('INTERNAL_WEBHOOK_SECRET', 'change-me-in-production'),
  SERVICE_API_TOKEN: process.env.SERVICE_API_TOKEN,
};
