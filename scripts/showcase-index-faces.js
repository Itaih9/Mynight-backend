/**
 * Indexes every showcase photo into a Rekognition collection and writes a face
 * manifest to gallery_showcase/_faces.json, which getShowcaseImages() reads to
 * draw face circles and getShowcaseFacePhotos() reads to filter to one person.
 *
 * The collection (gallery-showcase) persists in Rekognition; the backend
 * searches it live when a bubble is tapped. Re-running rebuilds both from
 * scratch (collection is reset first) so the set stays in sync with S3.
 *
 * Cost: ~$0.001 per image indexed, one-off.
 *
 * Usage:   cd /home/ubuntu/mynight-back && node scripts/showcase-index-faces.js
 *          node scripts/showcase-index-faces.js --dry-run   # count only
 */
require('dotenv').config();
const AWS = require('aws-sdk');

const DRY_RUN = process.argv.includes('--dry-run');
const BUCKET = process.env.S3_BUCKET_NAME;
const PREFIX = 'gallery_showcase/';
const MANIFEST_KEY = 'gallery_showcase/_faces.json';
const COLLECTION_ID = 'gallery-showcase';
const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;
// Rekognition only indexes JPEG/PNG.
const IMAGE_RE = /\.(jpe?g|png)$/i;

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();

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

  await resetCollection();

  const manifest = {};
  let indexed = 0;
  let faces = 0;

  for (let i = 0; i < photos.length; i++) {
    const key = photos[i];
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

      if (detected.length) {
        manifest[key] = detected;
        faces += detected.length;
      }
      indexed++;
      console.log(`${detected.length} face(s)`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  await s3
    .putObject({
      Bucket: BUCKET,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    })
    .promise();

  console.log(`done: ${indexed} indexed, ${faces} faces total, manifest -> ${MANIFEST_KEY}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
