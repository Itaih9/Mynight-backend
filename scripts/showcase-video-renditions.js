/**
 * Generates, for every video under gallery_showcase/:
 *   thumbnails/<key>  – a JPEG poster (first frame), so stories show a still
 *                       immediately instead of a black box while buffering.
 *   display/<key>     – a 720p faststart re-encode, so playback can start
 *                       before the file has finished downloading.
 *
 * Both land on the keys getShowcaseImages() already looks for, so no backend
 * change is needed — they light up on the next cache expiry (5 min).
 *
 * Prerequisite:  sudo apt install -y ffmpeg
 * Usage:         cd /home/ubuntu/mynight-back && node scripts/showcase-video-renditions.js
 *
 * Safe to re-run: existing renditions are skipped, nothing is ever deleted.
 */
require('dotenv').config();
const AWS = require('aws-sdk');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUCKET = process.env.S3_BUCKET_NAME;
const PREFIX = 'gallery_showcase/';
const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();

async function listAll(prefix) {
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

/**
 * Stream an object to disk. Buffering it (getObject().promise()) pulls the whole
 * file into RAM — a large clip gets the process OOM-killed on this box.
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

function poster(src, dest) {
  // Seek a second in — frame 0 is often a fade-in or a black leader.
  try {
    execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', src, '-frames:v', '1',
      '-vf', 'scale=800:-2', '-q:v', '4', dest], { stdio: 'ignore' });
  } catch {
    // Clip shorter than a second: fall back to the very first frame.
    execFileSync('ffmpeg', ['-y', '-i', src, '-frames:v', '1',
      '-vf', 'scale=800:-2', '-q:v', '4', dest], { stdio: 'ignore' });
  }
}

(async () => {
  const [keys, thumbs, displays] = await Promise.all([
    listAll(PREFIX),
    listAll(`thumbnails/${PREFIX}`),
    listAll(`display/${PREFIX}`),
  ]);
  const have = new Set([...thumbs, ...displays]);
  const videos = keys.filter((k) => VIDEO_RE.test(k));
  console.log(`${videos.length} video(s) under ${PREFIX}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
  let processed = 0;

  for (const key of videos) {
    const needPoster = !have.has(`thumbnails/${key}`);
    const needDisplay = !have.has(`display/${key}`);
    if (!needPoster && !needDisplay) {
      console.log(`skip     ${key}`);
      continue;
    }

    const src = path.join(tmp, `in${path.extname(key)}`);
    await download(key, src);
    const srcBytes = fs.statSync(src).size;

    if (needPoster) {
      const jpg = path.join(tmp, 'poster.jpg');
      poster(src, jpg);
      await s3.upload({
        Bucket: BUCKET,
        Key: `thumbnails/${key}`,
        Body: fs.createReadStream(jpg),
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000',
      }).promise();
      fs.unlinkSync(jpg);
      console.log(`poster   ${key}`);
    }

    if (needDisplay) {
      const out = path.join(tmp, 'out.mp4');
      execFileSync('ffmpeg', ['-y', '-i', src, '-vf', 'scale=-2:720',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], { stdio: 'ignore' });
      await s3.upload({
        Bucket: BUCKET,
        Key: `display/${key}`,
        Body: fs.createReadStream(out),
        ContentType: 'video/mp4',
        CacheControl: 'public, max-age=31536000',
      }).promise();
      const before = (srcBytes / 1e6).toFixed(1);
      const after = (fs.statSync(out).size / 1e6).toFixed(1);
      console.log(`display  ${key}  ${before}MB -> ${after}MB`);
      fs.unlinkSync(out);
    }

    fs.unlinkSync(src);
    processed++;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`done: ${processed} processed, ${videos.length - processed} already had renditions`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
