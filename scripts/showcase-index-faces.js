/**
 * Indexes every showcase photo into a Rekognition collection and writes a face
 * manifest to gallery_showcase/_faces.json, which getShowcaseImages() reads to
 * draw face circles and getShowcaseFacePhotos() reads to filter to one person.
 *
 * Resumable: the manifest is checkpointed to S3 every 50 photos and records
 * every processed key (including zero-face ones), so a crashed or killed run
 * picks up where it left off — just run it again. Because resuming keeps the
 * existing Rekognition collection (its faceIds are in the checkpoint), the
 * collection is only reset on a fresh start or with --fresh.
 *
 * Each Rekognition call is capped at 30s with 2 retries, so one bad file
 * stalls a single photo, not the run.
 *
 * Cost: ~$0.001 per image indexed, one-off.
 *
 * Usage:   cd /home/ubuntu/mynight-back && node scripts/showcase-index-faces.js
 *          node scripts/showcase-index-faces.js --dry-run   # count only
 *          node scripts/showcase-index-faces.js --fresh     # ignore checkpoint, full rebuild
 */
require('dotenv').config();
const AWS = require('aws-sdk');

const DRY_RUN = process.argv.includes('--dry-run');
const FRESH = process.argv.includes('--fresh');
const BUCKET = process.env.S3_BUCKET_NAME;
const PREFIX = 'gallery_showcase/';
const MANIFEST_KEY = 'gallery_showcase/_faces.json';
const COLLECTION_ID = 'gallery-showcase';
const CHECKPOINT_EVERY = 50;
const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;
// Rekognition only indexes JPEG/PNG.
const IMAGE_RE = /\.(jpe?g|png)$/i;

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
// Hard-capped so a single stuck call can't hang the whole run.
const rekognition = new AWS.Rekognition({
  httpOptions: { connectTimeout: 5000, timeout: 30000 },
  maxRetries: 2,
});

async function listAllKeys(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3
      .listObjectsV2({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
      .promise();
    for (const o of res.Contents || []) {
      if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function loadCheckpoint() {
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: MANIFEST_KEY }).promise();
    return JSON.parse(obj.Body.toString('utf-8'));
  } catch (e) {
    return null;
  }
}

async function saveManifest(manifest) {
  await s3
    .putObject({
      Bucket: BUCKET,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    })
    .promise();
}

async function resetCollection() {
  try {
    await rekognition.deleteCollection({ CollectionId: COLLECTION_ID }).promise();
    console.log(`deleted existing collection ${COLLECTION_ID}`);
  } catch (e) {
    if (e.code !== 'ResourceNotFoundException') throw e;
  }
  await rekognition.createCollection({ CollectionId: COLLECTION_ID }).promise();
  console.log(`created collection ${COLLECTION_ID}`);
}

(async () => {
  const allKeys = await listAllKeys(PREFIX);
  const photos = allKeys.filter((k) => IMAGE_RE.test(k) && !VIDEO_RE.test(k) && k !== MANIFEST_KEY);
  console.log(`${allKeys.length} objects, ${photos.length} indexable photo(s)`);

  if (DRY_RUN) {
    console.log('--dry-run: nothing written.');
    return;
  }

  // Resume from the checkpoint unless a fresh rebuild was asked for. The
  // checkpoint's faceIds live in the existing collection, so resuming must
  // not reset it.
  let manifest = FRESH ? null : await loadCheckpoint();
  if (manifest && Object.keys(manifest).length > 0) {
    console.log(`resuming: ${Object.keys(manifest).length} photo(s) already processed`);
  } else {
    manifest = {};
    await resetCollection();
  }

  let processed = 0;
  let faces = 0;
  let failed = 0;
  let sinceCheckpoint = 0;

  for (let i = 0; i < photos.length; i++) {
    const key = photos[i];
    if (Object.prototype.hasOwnProperty.call(manifest, key)) continue;

    process.stdout.write(`[${i + 1}/${photos.length}] ${key.split('/').pop()} ... `);
    try {
      const res = await rekognition
        .indexFaces({
          CollectionId: COLLECTION_ID,
          Image: { S3Object: { Bucket: BUCKET, Name: key } },
          MaxFaces: 50,
          QualityFilter: 'AUTO',
          DetectionAttributes: [],
        })
        .promise();

      const detected = (res.FaceRecords || [])
        .map((r) => ({
          faceId: r.Face && r.Face.FaceId,
          boundingBox: {
            Width: (r.Face && r.Face.BoundingBox && r.Face.BoundingBox.Width) || 0,
            Height: (r.Face && r.Face.BoundingBox && r.Face.BoundingBox.Height) || 0,
            Left: (r.Face && r.Face.BoundingBox && r.Face.BoundingBox.Left) || 0,
            Top: (r.Face && r.Face.BoundingBox && r.Face.BoundingBox.Top) || 0,
          },
        }))
        .filter((f) => f.faceId);

      // Record zero-face photos too, so a resume skips them.
      manifest[key] = detected;
      faces += detected.length;
      processed++;
      sinceCheckpoint++;
      console.log(`${detected.length} face(s)`);
    } catch (e) {
      failed++;
      console.log(`FAILED: ${e.message}`);
    }

    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      await saveManifest(manifest);
      sinceCheckpoint = 0;
      console.log(`-- checkpoint saved (${Object.keys(manifest).length} photos in manifest)`);
    }
  }

  await saveManifest(manifest);
  console.log(
    `done: ${processed} newly indexed, ${failed} failed, ` +
      `${Object.keys(manifest).length} photos in manifest, ${faces} new faces, manifest -> ${MANIFEST_KEY}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
