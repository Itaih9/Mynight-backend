/**
 * Backfills, for every event video that lacks them:
 *   <s3Key>-poster.jpg   – JPEG poster; the Photo doc's posterUrl is set to match.
 *   display/<s3Key>.mp4  – 720p faststart re-encode for quick playback.
 *
 * Originals are never touched, so downloads stay full quality (every download
 * path reads photo.s3Key directly).
 *
 * The display/ rendition is only *served* when VIDEO_RENDITIONS_ENABLED=true;
 * generate first, flip the flag after (see displayUrlFor).
 *
 * Prerequisite:  sudo apt install -y ffmpeg
 *
 * Usage:
 *   node scripts/event-video-renditions.js --dry-run   # count only, writes nothing
 *   node scripts/event-video-renditions.js --limit=10  # process the first 10
 *   node scripts/event-video-renditions.js             # process everything
 *
 * Safe to re-run and safe to interrupt: each video is committed as it finishes,
 * and anything already done is skipped.
 */
require('dotenv').config();
const AWS = require('aws-sdk');
const mongoose = require('mongoose');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

const BUCKET = process.env.S3_BUCKET_NAME;

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();

async function exists(key) {
  try {
    await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    return true;
  } catch {
    return false;
  }
}

function poster(src, dest) {
  // Seek a second in — frame 0 is often a fade-in or a black leader.
  try {
    execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', src, '-frames:v', '1',
      '-vf', 'scale=800:-2', '-q:v', '4', dest], { stdio: 'ignore' });
  } catch {
    execFileSync('ffmpeg', ['-y', '-i', src, '-frames:v', '1',
      '-vf', 'scale=800:-2', '-q:v', '4', dest], { stdio: 'ignore' });
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const photos = mongoose.connection.collection('photos');

  const query = { 'metadata.mimeType': { $regex: '^video/' } };
  const total = await photos.countDocuments(query);
  const missingPoster = await photos.countDocuments({
    ...query,
    $or: [{ posterUrl: { $exists: false } }, { posterUrl: null }, { posterUrl: '' }],
  });
  console.log(`${total} event video(s); ${missingPoster} with no posterUrl`);

  if (DRY_RUN) {
    console.log('--dry-run: nothing written.');
    await mongoose.disconnect();
    return;
  }

  const cursor = photos.find(query).project({ s3Key: 1, posterUrl: 1 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evrend-'));
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let seen = 0;

  while (await cursor.hasNext()) {
    if (LIMIT && processed >= LIMIT) break;
    const doc = await cursor.next();
    const key = doc.s3Key;
    if (!key) continue;
    seen++;
    // Downloading + transcoding a clip takes a while and is silent; say what
    // we're on so the run doesn't look hung.
    process.stdout.write(`[${seen}/${total}] ${key} ... `);

    const posterKey = `${key}-poster.jpg`;
    const displayKey = `display/${key}.mp4`;

    const [hasPoster, hasDisplay] = await Promise.all([exists(posterKey), exists(displayKey)]);
    const needPoster = !hasPoster || !doc.posterUrl;
    const needDisplay = !hasDisplay;
    if (!needPoster && !needDisplay) {
      skipped++;
      console.log('skip');
      continue;
    }

    const src = path.join(tmp, `in${path.extname(key) || '.mp4'}`);
    try {
      const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
      fs.writeFileSync(src, obj.Body);

      if (needPoster) {
        const jpg = path.join(tmp, 'poster.jpg');
        if (!hasPoster) {
          poster(src, jpg);
          await s3.putObject({
            Bucket: BUCKET,
            Key: posterKey,
            Body: fs.readFileSync(jpg),
            ContentType: 'image/jpeg',
            CacheControl: 'public, max-age=31536000',
          }).promise();
          fs.unlinkSync(jpg);
        }
        // The gallery reads posterUrl off the document — writing the JPEG alone
        // would change nothing.
        await photos.updateOne(
          { _id: doc._id },
          { $set: { posterUrl: `${process.env.CLOUDFRONT_URL}/${posterKey}` } }
        );
        process.stdout.write('poster ');
      }

      if (needDisplay) {
        const out = path.join(tmp, 'out.mp4');
        execFileSync('ffmpeg', ['-y', '-i', src, '-vf', 'scale=-2:720',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
          '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], { stdio: 'ignore' });
        await s3.putObject({
          Bucket: BUCKET,
          Key: displayKey,
          Body: fs.readFileSync(out),
          ContentType: 'video/mp4',
          CacheControl: 'public, max-age=31536000',
        }).promise();
        const before = (obj.Body.length / 1e6).toFixed(1);
        const after = (fs.statSync(out).size / 1e6).toFixed(1);
        process.stdout.write(`display ${before}MB -> ${after}MB `);
        fs.unlinkSync(out);
      }

      processed++;
      console.log('ok');
    } catch (e) {
      // One bad file shouldn't end the run.
      failed++;
      console.log(`FAILED: ${e.message}`);
    } finally {
      if (fs.existsSync(src)) fs.unlinkSync(src);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  await mongoose.disconnect();
  console.log(`done: ${processed} processed, ${skipped} already had renditions, ${failed} failed`);
})().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
