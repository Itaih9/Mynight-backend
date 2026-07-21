/**
 * Backfills aiCategories on existing event photos via Rekognition DetectLabels
 * (wedding filters: dance, kids, drinks, cake, group, outdoor) at >=85%
 * confidence. New uploads get this automatically in completeUpload.
 *
 * Cost: ~$1 per 1,000 images (DetectLabels), one-off.
 *
 * Usage:
 *   node scripts/backfill-ai-categories.js --dry-run     # count only
 *   node scripts/backfill-ai-categories.js --event=CODE  # one event by code
 *   node scripts/backfill-ai-categories.js               # all photos missing it
 *
 * Resumable: skips photos that already have aiCategories set, so re-run freely.
 */
require('dotenv').config();
const AWS = require('aws-sdk');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EVENT_CODE = (args.find((a) => a.startsWith('--event=')) || '').split('=')[1];

const BUCKET = process.env.S3_BUCKET_NAME;
const CONFIDENCE = 85;
const IMAGE_RE = /\.(jpe?g|png)$/i;

// Keep in sync with rekognition.service.ts AI_CATEGORY_LABELS.
const CATEGORY_LABELS = {
  'ריקודים': ['Dancing', 'Dance Pose', 'Nightlife'],
  'ילדים': ['Child', 'Baby', 'Boy', 'Girl', 'Toddler', 'Kid'],
  'לחיים': ['Wine', 'Wine Glass', 'Beer', 'Glass', 'Alcohol', 'Drink', 'Cocktail', 'Bottle'],
  'עוגה ואוכל': ['Cake', 'Dessert', 'Food', 'Meal', 'Birthday Cake', 'Torte', 'Plate'],
  'צילום קבוצתי': ['Group', 'Crowd'],
  'בחוץ': ['Outdoors', 'Garden', 'Nature', 'Lawn', 'Field', 'Grass', 'Park'],
};

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const rekognition = new AWS.Rekognition();

async function detect(s3Key) {
  const res = await rekognition
    .detectLabels({ Image: { S3Object: { Bucket: BUCKET, Name: s3Key } }, MinConfidence: CONFIDENCE, MaxLabels: 60 })
    .promise();
  const found = new Set((res.Labels || []).map((l) => l.Name));
  const cats = [];
  for (const [cat, labels] of Object.entries(CATEGORY_LABELS)) {
    if (labels.some((l) => found.has(l))) cats.push(cat);
  }
  return cats;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const photos = mongoose.connection.collection('photos');

  const query = {
    's3Key': { $regex: IMAGE_RE },
    $or: [{ aiCategories: { $exists: false } }, { aiCategories: { $size: 0 } }],
  };
  if (EVENT_CODE) {
    const events = mongoose.connection.collection('events');
    const ev = await events.findOne({ eventCode: EVENT_CODE });
    if (!ev) { console.error(`Event ${EVENT_CODE} not found`); process.exit(1); }
    query.eventId = ev._id;
  }

  const total = await photos.countDocuments(query);
  console.log(`${total} photo(s) without aiCategories${EVENT_CODE ? ` in ${EVENT_CODE}` : ''}`);
  if (DRY_RUN) { console.log('--dry-run: nothing written.'); await mongoose.disconnect(); return; }

  const cursor = photos.find(query).project({ s3Key: 1 });
  let done = 0, tagged = 0, failed = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    done++;
    try {
      const cats = await detect(doc.s3Key);
      await photos.updateOne({ _id: doc._id }, { $set: { aiCategories: cats } });
      if (cats.length) tagged++;
      if (done % 25 === 0 || cats.length) console.log(`[${done}/${total}] ${doc.s3Key.split('/').pop()} -> ${cats.join(', ') || '(none)'}`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${doc.s3Key}: ${e.message}`);
    }
  }

  await mongoose.disconnect();
  console.log(`done: ${done} processed, ${tagged} got categories, ${failed} failed`);
})().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
