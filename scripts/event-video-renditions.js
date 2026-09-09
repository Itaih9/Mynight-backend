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
 * This shares a box with the API, and transcoding is sequential and CPU-bound,
 * so for a live server run it inside a window it cannot escape:
 *
 *   node scripts/event-video-renditions.js --nice --max-minutes=90
 *   node scripts/event-video-renditions.js --nice=15 --max-bytes=20GB
 *
 * --nice (default 10, or --nice=N) runs ffmpeg at a lower priority so it yields
 * to request handling. --max-bytes and --max-minutes stop the run between
 * videos once the budget is spent; re-running picks up where it left off,
 * because anything already done is skipped.
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

/**
 * Bytes from a human-written size: 500MB, 2.5gb, 1_000_000. Plain digits are
 * bytes. Returns NaN for anything it cannot read, so the caller can refuse it
 * rather than silently treating a typo as "no budget".
 */
function parseBytes(text) {
  const m = String(text).trim().replace(/_/g, '').match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return NaN;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Number(m[1]) * units[(m[2] || 'b').toLowerCase()];
}

/**
 * This runs on the same box as the API. Transcoding is sequential and pegs a
 * core for as long as it takes, so the flags that matter are the ones that let
 * it be run in an off-peak window and stop on its own before anyone notices:
 * a niceness, a byte budget and a wall-clock budget.
 */
function parseArgs(argv) {
  const flag = (n) => argv.includes(`--${n}`);
  const value = (n) => {
    const found = argv.find((a) => a.startsWith(`--${n}=`));
    return found === undefined ? undefined : found.slice(`--${n}=`.length);
  };
  const num = (n, raw) => {
    if (raw === undefined) return undefined;
    const v = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`--${n} must be a non-negative number, got "${raw}"`);
    return v;
  };

  // `--nice 15` would set niceness to the default and then be ignored, which is
  // the sort of thing you only discover from a load graph the next morning.
  for (const n of ['limit', 'nice', 'max-bytes', 'max-minutes']) {
    if (argv.includes(`--${n}`) && n !== 'nice') {
      throw new Error(`--${n} takes its value with an equals sign: --${n}=<value>`);
    }
  }

  const rawNice = value('nice');
  let niceness = null;
  if (rawNice !== undefined) {
    niceness = num('nice', rawNice);
    if (niceness > 19) throw new Error(`--nice must be between 0 and 19, got "${rawNice}"`);
  } else if (flag('nice')) {
    niceness = 10; // enough to yield to the API without stalling outright
  }

  const rawBytes = value('max-bytes');
  let maxBytes = 0;
  if (rawBytes !== undefined) {
    maxBytes = parseBytes(rawBytes);
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`--max-bytes must be a size like 500MB or 2GB, got "${rawBytes}"`);
    }
  }

  const maxMinutes = num('max-minutes', value('max-minutes')) || 0;

  return {
    dryRun: flag('dry-run'),
    limit: num('limit', value('limit')) || 0,
    niceness,
    maxBytes,
    maxMinutes,
  };
}

/**
 * Set by main() from its argv, rather than parsed at import: the file is also
 * required by its checks, and parsing then would read the test runner's own
 * argv and refuse it.
 */
let OPTS = { dryRun: false, limit: 0, niceness: null, maxBytes: 0, maxMinutes: 0 };

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

/**
 * Whether this run has spent its budget, and which one. Returns null to carry
 * on. Budgets are checked BETWEEN videos, never mid-transcode: stopping halfway
 * would leave a partial rendition in the bucket, and the point of the budget is
 * to bound the load, not to abandon work already paid for.
 */
function shouldStop({ bytesDone, elapsedMs, maxBytes, maxMinutes }) {
  if (maxBytes && bytesDone >= maxBytes) return 'byte budget';
  if (maxMinutes && elapsedMs >= maxMinutes * 60 * 1000) return 'time budget';
  return null;
}

/**
 * `nice` is not everywhere, and a missing one must not take the run with it —
 * the point of the flag is to be gentler, not to be a new way to fail.
 */
let niceChecked = false;
let niceAvailable = false;
function ffmpegCommand(ffmpegArgs) {
  if (OPTS.niceness === null) return ['ffmpeg', ffmpegArgs];
  if (!niceChecked) {
    niceChecked = true;
    try {
      execFileSync('nice', ['-n', '0', 'true'], { stdio: 'ignore' });
      niceAvailable = true;
    } catch {
      console.warn('  (nice is unavailable here — running ffmpeg at normal priority)');
    }
  }
  return niceAvailable
    ? ['nice', ['-n', String(OPTS.niceness), 'ffmpeg', ...ffmpegArgs]]
    : ['ffmpeg', ffmpegArgs];
}

function poster(src, dest) {
  // Seek a second in — frame 0 is often a fade-in or a black leader.
  const run = (extra) => {
    const [cmd, cmdArgs] = ffmpegCommand([...extra, '-i', src, '-frames:v', '1',
      '-vf', 'scale=800:-2', '-q:v', '4', dest]);
    execFileSync(cmd, cmdArgs, { stdio: 'ignore' });
  };
  try {
    run(['-y', '-ss', '1']);
  } catch {
    run(['-y']);
  }
}

async function main(argv = process.argv.slice(2)) {
  OPTS = parseArgs(argv);
  const DRY_RUN = OPTS.dryRun;
  const LIMIT = OPTS.limit;

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
  let bytesDone = 0;
  let stoppedBy = null;
  const startedAt = Date.now();
  if (OPTS.niceness !== null) console.log(`Running ffmpeg at niceness ${OPTS.niceness}.`);
  if (OPTS.maxBytes) console.log(`Byte budget: ${humanBytes(OPTS.maxBytes)} of source video.`);
  if (OPTS.maxMinutes) console.log(`Time budget: ${OPTS.maxMinutes} minute(s).`);

  while (await cursor.hasNext()) {
    if (LIMIT && processed >= LIMIT) break;
    stoppedBy = shouldStop({
      bytesDone,
      elapsedMs: Date.now() - startedAt,
      maxBytes: OPTS.maxBytes,
      maxMinutes: OPTS.maxMinutes,
    });
    if (stoppedBy) break;
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
      // Counted on download, not on success: the bytes were pulled and the CPU
      // was spent either way, and the budget exists to bound exactly that.
      bytesDone += srcBytes;

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
        const [cmd, cmdArgs] = ffmpegCommand(['-y', '-i', src, '-vf', 'scale=-2:720',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
          '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
        execFileSync(cmd, cmdArgs, { stdio: 'ignore' });
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
  console.log(`      ${humanBytes(bytesDone)} of source video read in ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
  if (stoppedBy) {
    console.log(`      STOPPED EARLY on the ${stoppedBy}. Re-run to continue — finished videos are skipped.`);
  }
}

module.exports = { main, parseArgs, parseBytes, shouldStop, mapPool, humanBytes, survey, summarize, posterKeyFor, displayKeyFor };

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
