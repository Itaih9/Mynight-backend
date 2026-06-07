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
  REKOGNITION_MIN_CONFIDENCE: number;
  REKOGNITION_FACE_MATCH_THRESHOLD: number;
  SES_EMAIL_FROM: string;
  SES_REGION: string;
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM_EMAIL?: string;
  SENDGRID_FROM_NAME?: string;
  SUMIT_COMPANY_ID: string;
  SUMIT_API_KEY: string;
  SUMIT_PUBLIC_KEY: string;
  INTERNAL_WEBHOOK_SECRET: string;
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
  REKOGNITION_MIN_CONFIDENCE: parseInt(getEnv('REKOGNITION_MIN_CONFIDENCE', '80')),
  REKOGNITION_FACE_MATCH_THRESHOLD: parseInt(getEnv('REKOGNITION_FACE_MATCH_THRESHOLD', '70')),
  SES_EMAIL_FROM: getEnv('SES_EMAIL_FROM'),
  SES_REGION: getEnv('SES_REGION', 'us-east-1'),
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME: process.env.SENDGRID_FROM_NAME,
  SUMIT_COMPANY_ID: getEnv('SUMIT_COMPANY_ID', ''),
  SUMIT_API_KEY: getEnv('SUMIT_API_KEY', ''),
  SUMIT_PUBLIC_KEY: getEnv('SUMIT_PUBLIC_KEY', ''),
  INTERNAL_WEBHOOK_SECRET: getEnv('INTERNAL_WEBHOOK_SECRET', 'change-me-in-production'),
};
