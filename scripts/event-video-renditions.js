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
 *   node scripts/event-video-renditions.js --dry-run   # survey only, writes nothing
 *   node scripts/event-video-renditions.js --limit=10  # process (or survey) the first 10
 *   node scripts/event-video-renditions.js             # process everything
 *
 * --dry-run asks S3 what is actually there rather than reading the database
 * alone, because the database records the poster and knows nothing about the
 * rendition. It reports how many videos would 404 if VIDEO_RENDITIONS_ENABLED
 * were switched on right now — the one number that decides whether flipping it
 * is an improvement or a wasted round trip per video.
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

/**
 * Stream an object to disk. Buffering it (getObject().promise()) pulls the whole
 * file into RAM — a 380MB clip gets the process OOM-killed on this box.
 */
function download(key, dest) {
  return new Promise((resolve, reject) => {
    const read = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    const write = fs.createWriteStream(dest);
    read.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
    read.pipe(write);
  });
}

async function exists(key) {
  try {
    await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    return true;
  } catch {
    return false;
  }
}

const posterKeyFor = (s3Key) => `${s3Key}-poster.jpg`;
const displayKeyFor = (s3Key) => `display/${s3Key}.mp4`;

/** Run `worker` over `items`, at most `width` at a time. */
async function mapPool(items, width, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

const humanBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
};

/**
 * What S3 actually holds for every video, as opposed to what the database
 * remembers. One HEAD per key, ten at a time: enough to survey a few thousand
 * videos in a couple of minutes without flooding the bucket.
 */
async function survey(docs, probe = exists, onProgress = () => {}) {
  let done = 0;
  return mapPool(docs, 10, async (doc) => {
    const [hasPoster, hasDisplay] = await Promise.all([
      probe(posterKeyFor(doc.s3Key)),
      probe(displayKeyFor(doc.s3Key)),
    ]);
    onProgress(++done, docs.length);
    return { doc, hasPoster, hasDisplay };
  });
}

/**
 * Turn the survey into the numbers the decision needs. Kept separate from the
 * printing, and from S3, so it can be exercised directly — these counts are
 * what someone reads before switching a flag in production.
 */
function summarize(rows) {
  const guest = (list) => list.filter((r) => r.doc.uploadedBy === 'guest').length;
  const noPoster = rows.filter((r) => !r.hasPoster);
  const noDisplay = rows.filter((r) => !r.hasDisplay);
  return {
    total: rows.length,
    ready: rows.filter((r) => r.hasPoster && r.hasDisplay).length,
    noPoster: noPoster.length,
    noPosterGuest: guest(noPoster),
    noDisplay: noDisplay.length,
    noDisplayGuest: guest(noDisplay),
    bytesWithoutDisplay: noDisplay.reduce((n, r) => n + (r.doc.metadata?.size || 0), 0),
    // The document and the bucket can disagree: the backfill writes both, but a
    // poster uploaded by the camera client can leave one without the other.
    posterObjectButNoUrl: rows.filter((r) => r.hasPoster && !r.doc.posterUrl).length,
    urlButNoPosterObject: rows.filter((r) => !r.hasPoster && r.doc.posterUrl).length,
  };
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

async function main() {
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
    const docs = await photos
      .find(query)
      .project({ s3Key: 1, posterUrl: 1, uploadedBy: 1, 'metadata.size': 1 })
      .limit(LIMIT || 0)
      .toArray();
    if (LIMIT) console.log(`Surveying the first ${docs.length} (--limit=${LIMIT}) — a sample, not the whole picture.`);
    else console.log(`Asking S3 about ${docs.length} video(s)…`);

    const rows = await survey(docs, exists, (done, all) => {
      if (done % 50 === 0) process.stdout.write(`  surveyed ${done}/${all}\r`);
    });
    process.stdout.write(' '.repeat(40) + '\r');
    const sum = summarize(rows);

    console.log('');
    console.log(`  ready (poster + rendition) : ${sum.ready}`);
    console.log(`  no poster in the bucket    : ${sum.noPoster}  (${sum.noPosterGuest} from guests)`);
    console.log(`  NO DISPLAY RENDITION       : ${sum.noDisplay}  (${sum.noDisplayGuest} from guests), ${humanBytes(sum.bytesWithoutDisplay)} of originals`);
    if (sum.posterObjectButNoUrl) console.log(`  poster in S3 but not on the document: ${sum.posterObjectButNoUrl}`);
    if (sum.urlButNoPosterObject) console.log(`  posterUrl set but no such object    : ${sum.urlButNoPosterObject}`);

    console.log('');
    const flagOn = process.env.VIDEO_RENDITIONS_ENABLED === 'true';
    console.log(`  VIDEO_RENDITIONS_ENABLED is currently ${flagOn ? 'ON' : 'off'}.`);
    if (sum.noDisplay === 0) {
      console.log('  Every video has a rendition. Turning the flag on is a straight win.');
    } else if (flagOn) {
      console.log(`  ${sum.noDisplay} video(s) are being served as a 404 and a fallback to the original RIGHT NOW.`);
      console.log('  Run this script without --dry-run to close that gap.');
    } else {
      console.log(`  Turning it on now would make ${sum.noDisplay} video(s) 404 and fall back to the`);
      console.log('  original — a wasted round trip each, and no faster than today. Generate first.');
    }
    // The poster is worth having on its own: a video with no poster makes the
    // gallery grid fall back to a <video> element and fetch video bytes just to
    // measure the tile, whatever the flag says.
    if (sum.noPoster) {
      console.log(`  ${sum.noPoster} video(s) have no poster, so their grid tiles fetch video bytes`);
      console.log('  to measure themselves. That is worth fixing regardless of the flag.');
    }

    console.log('');
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

    const posterKey = posterKeyFor(key);
    const displayKey = displayKeyFor(key);

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
      await download(key, src);
      const srcBytes = fs.statSync(src).size;

      if (needPoster) {
        const jpg = path.join(tmp, 'poster.jpg');
        if (!hasPoster) {
          poster(src, jpg);
          await s3.upload({
            Bucket: BUCKET,
            Key: posterKey,
            Body: fs.createReadStream(jpg),
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
        await s3.upload({
          Bucket: BUCKET,
          Key: displayKey,
          Body: fs.createReadStream(out),
          ContentType: 'video/mp4',
          CacheControl: 'public, max-age=31536000',
        }).promise();
        const before = (srcBytes / 1e6).toFixed(1);
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
}

module.exports = { main, mapPool, humanBytes, survey, summarize, posterKeyFor, displayKeyFor };

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
