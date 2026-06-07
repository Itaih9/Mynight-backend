import AWS from 'aws-sdk';
import { env } from './env';

AWS.config.update({
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  region: env.AWS_REGION,
});

export const s3 = new AWS.S3();
export const rekognition = new AWS.Rekognition({ region: env.AWS_REGION });
export const ses = new AWS.SES({ region: env.SES_REGION });

export default AWS;
