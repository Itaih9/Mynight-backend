/**
 * env.ts throws on a missing required variable, so importing any module that
 * reads config would fail before a single test ran. These are placeholders —
 * nothing here is dialled, sent or connected to.
 */
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET = 'test-secret';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.SES_EMAIL_FROM = 'test@example.com';
process.env.LOG_LEVEL = 'error';
