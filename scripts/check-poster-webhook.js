/**
 * Answers the three questions you need answered BEFORE deploying the
 * video-poster changes, without printing a secret anywhere.
 *
 *   1. Is INTERNAL_WEBHOOK_SECRET set on this server at all?
 *   2. If it is, which value is it — as a fingerprint you can compare against
 *      the Lambda's, not as the secret itself.
 *   3. Do the posterKeys the Lambda has actually been delivering satisfy the
 *      validation the server now applies? If they do not, the Lambda starts
 *      getting 400s the moment you deploy.
 *
 * Question 3 is answered from the database rather than from AWS: every
 * photo.posterUrl is a record of a posterKey that Lambda delivered.
 *
 * Usage:
 *   node scripts/check-poster-webhook.js
 *   node scripts/check-poster-webhook.js --sample=500   # default 200
 *
 * Read-only. It writes nothing, to either the database or S3.
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const SAMPLE = Number((args.find((a) => a.startsWith('--sample=')) || '').split('=')[1]) || 200;

/** The value INTERNAL_WEBHOOK_SECRET used to default to — already public. */
const PUBLISHED_DEFAULT = 'change-me-in-production';

/**
 * MUST agree with isPosterKeyFor in src/modules/photos/photos.controller.ts —
 * a diagnostic that disagrees with the server is worse than none, because it
 * would tell you a deploy is safe when it is not. A check asserts the two
 * implementations match across a corpus of keys; if you change one, change both.
 */
const isPosterKeyFor = (s3Key, posterKey) =>
  typeof posterKey === 'string' &&
  posterKey.startsWith(`${s3Key}-`) &&
  !posterKey.includes('..') &&
  /\.(jpe?g|png)$/i.test(posterKey);

const describeSecret = (secret) => {
  if (!secret) return 'NOT SET';
  if (secret === PUBLISHED_DEFAULT) return 'the published repo default (!)';
  return `${secret.length} chars, sha256:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)}`;
};

async function main() {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET;
  const cloudfront = (process.env.CLOUDFRONT_URL || '').replace(/\/+$/, '');

  console.log('1. INTERNAL_WEBHOOK_SECRET on this server');
  console.log(`   ${describeSecret(secret)}`);
  if (!secret) {
    console.log('   => The endpoint is OPEN right now if this server is running the old code,');
    console.log('      and will refuse every call once the new code is deployed.');
  } else if (secret === PUBLISHED_DEFAULT) {
    console.log('   => This value is published in the repository. Treat it as no secret at all.');
  } else {
    console.log('   Compare with the Lambda:  printf %s "$SECRET" | sha256sum');
  }

  console.log('');
  console.log('2. What the Lambda has actually been sending');
  await mongoose.connect(process.env.MONGO_URI);
  const photos = mongoose.connection.collection('photos');
  const docs = await photos
    .find({ posterUrl: { $exists: true, $ne: null, $ne: '' } })
    .project({ s3Key: 1, posterUrl: 1 })
    .limit(SAMPLE)
    .toArray();

  if (!docs.length) {
    console.log('   No photo has a posterUrl. Either no video has ever been posterised,');
    console.log('   or the Lambda has never successfully reached this endpoint.');
  }

  const bad = [];
  let good = 0;
  for (const doc of docs) {
    // posterUrl is CLOUDFRONT_URL + '/' + posterKey, so undo that to recover
    // the key the Lambda sent.
    const posterKey = cloudfront && doc.posterUrl.startsWith(cloudfront)
      ? doc.posterUrl.slice(cloudfront.length + 1)
      : doc.posterUrl.replace(/^https?:\/\/[^/]+\//, '');
    if (isPosterKeyFor(doc.s3Key, posterKey)) good++;
    else bad.push({ s3Key: doc.s3Key, posterKey });
  }

  console.log(`   ${docs.length} sampled: ${good} satisfy the new rule, ${bad.length} do not`);
  for (const b of bad.slice(0, 5)) {
    console.log(`   REJECTED  s3Key=${b.s3Key}`);
    console.log(`             posterKey=${b.posterKey}`);
  }
  if (bad.length > 5) console.log(`   ...and ${bad.length - 5} more`);

  console.log('');
  console.log('3. Verdict');
  if (bad.length) {
    console.log('   DO NOT DEPLOY YET. The posterKeys above would be refused with a 400,');
    console.log('   so posters would stop and videos would stop reaching face albums.');
    console.log('   Send these examples back and the rule can be widened to match.');
  } else if (!docs.length) {
    console.log('   Nothing to judge from. Check the Lambda by hand before deploying.');
  } else {
    console.log('   posterKeys are fine — deploying will not break the Lambda on that count.');
  }
  if (!secret) {
    console.log('   SET INTERNAL_WEBHOOK_SECRET first, to the same value the Lambda sends,');
    console.log('   or the endpoint will refuse the Lambda as well.');
  }

  await mongoose.disconnect();
}

module.exports = { isPosterKeyFor, describeSecret, PUBLISHED_DEFAULT };

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
