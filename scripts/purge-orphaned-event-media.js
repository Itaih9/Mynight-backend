/**
 * Remove the S3 media and Rekognition collections of events that no longer
 * exist in the database.
 *
 * WHY THIS EXISTS. purgeEvent used to sweep events/ and thumbnails/ but not the
 * web-optimised copies under display/, and its Rekognition delete reported
 * nothing when it failed. Every event deleted before that was fixed left a full
 * second copy of the couple's photos in the bucket — still fetchable, because
 * CloudFront serves this bucket unsigned, so anyone holding an old link keeps
 * working access to photos the couple was told were gone — and, quite possibly,
 * a live face collection holding their guests' biometrics. The count at the
 * time of writing was 2,869 objects / 14.3 GB under events/ for 12 events that
 * are not in the database, plus 2,866 thumbnails and 2,910 display renditions.
 *
 * WHAT COUNTS AS AN ORPHAN. An event code that appears in the bucket (or as a
 * Rekognition collection) and does not appear in the events collection. Nothing
 * else. The four prefixes below are the only places event media is ever
 * written; gallery_showcase/ and everything else in the bucket is not looked at.
 *
 * Usage:
 *   node scripts/purge-orphaned-event-media.js                    # report only
 *   node scripts/purge-orphaned-event-media.js --delete           # remove them
 *   node scripts/purge-orphaned-event-media.js --code=7KGKKVXB    # one code
 *   node scripts/purge-orphaned-event-media.js --min-age-hours=48 # default 24
 *   node scripts/purge-orphaned-event-media.js --delete --skip-rekognition
 *
 * Reporting is the DEFAULT here, the opposite of the other scripts in this
 * folder, which do their work unless given --dry-run. Those write; this one
 * deletes a couple's photographs, and the safe default for that is to print
 * what it would do and let a human read it first.
 *
 * Safe to interrupt and safe to re-run: each code is finished before the next
 * starts, and anything already gone simply isn't found again.
 */
require('dotenv').config();
const AWS = require('aws-sdk');
const mongoose = require('mongoose');

/**
 * Every prefix under which event media is written, and the only ones this
 * script will delete from. Keep in sync with purgeEvent in events.service.ts —
 * a prefix missing from THAT list is what created the orphans in the first
 * place, and a prefix missing from THIS one leaves them behind again.
 */
const MEDIA_ROOTS = ['events/', 'thumbnails/events/', 'display/events/'];
/** The printed camera QR: one object per code, not a prefix. */
const QR_ROOT = 'static/qr/';
/** Rekognition collection id for an event, as built by events.service.ts. */
const COLLECTION_PREFIX = 'event-';
/**
 * The marketing gallery's face collection. It has no event and would read as an
 * orphan to any rule based on "not in the events collection". COLLECTION_PREFIX
 * already excludes it; naming it as well means a future change to that rule
 * cannot quietly take it out.
 */
const PROTECTED_COLLECTIONS = new Set(['gallery-showcase']);

/** S3 refuses more than 1000 keys in one DeleteObjects call. */
const DELETE_BATCH = 1000;

// ---------------------------------------------------------------------------
// Decisions. Kept free of AWS and mongo so they can be exercised directly.
// ---------------------------------------------------------------------------

/**
 * Codes are compared case-insensitively. Mongoose uppercases eventCode, so the
 * bucket should hold uppercase directories throughout — but a stray lowercase
 * one matching a live event must be spared, not deleted, and this is the
 * cheapest way to guarantee that.
 */
const codeKey = (code) => String(code || '').trim().toUpperCase();

/**
 * Generated codes are 8 chars from a fixed alphabet, but events predating that
 * generator exist, so this is deliberately loose. Its job is only to reject the
 * things that are not codes at all — `undefined/`, a stray file, a path that
 * arrived by some route nobody remembers. Those are reported and left alone:
 * "I don't recognise this" is a reason to ask a human, not to delete.
 */
const isEventCodeShape = (code) => /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(String(code || ''));

/**
 * Split what the bucket holds into what the database still knows about, what it
 * doesn't, and what isn't an event code at all.
 */
function classifyCodes(s3Codes, liveCodes) {
  const live = new Set([...liveCodes].map(codeKey));
  const orphans = [];
  const inUse = [];
  const unrecognized = [];
  for (const code of s3Codes) {
    if (!isEventCodeShape(code)) unrecognized.push(code);
    else if (live.has(codeKey(code))) inUse.push(code);
    else orphans.push(code);
  }
  return { orphans, inUse, unrecognized };
}

/**
 * A prefix whose newest object is only minutes old is far more likely to be an
 * event being created right now — its row written after we read the database —
 * than a leftover from a deletion months ago. A real orphan is old by
 * definition, so waiting a day costs nothing and closes the window.
 */
function isOldEnough(newestMs, nowMs, minAgeHours) {
  if (newestMs == null) return true; // nothing there to be too new
  return nowMs - newestMs >= minAgeHours * 3600 * 1000;
}

/** Rekognition collections whose event is gone. */
function classifyCollections(collectionIds, liveCollectionIds) {
  const live = new Set([...liveCollectionIds].map((id) => String(id).toLowerCase()));
  return collectionIds.filter((id) => {
    const lower = String(id).toLowerCase();
    if (PROTECTED_COLLECTIONS.has(lower)) return false;
    if (!lower.startsWith(COLLECTION_PREFIX)) return false; // not ours to judge
    return !live.has(lower);
  });
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const humanBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

/** Directory names directly under a prefix, via the delimiter. */
async function listChildPrefixes(s3, bucket, root) {
  const found = [];
  let token;
  do {
    const page = await s3
      .listObjectsV2({ Bucket: bucket, Prefix: root, Delimiter: '/', ContinuationToken: token })
      .promise();
    for (const cp of page.CommonPrefixes || []) {
      if (cp.Prefix) found.push(cp.Prefix);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}

/** Every object under a prefix. */
async function listObjects(s3, bucket, prefix) {
  const found = [];
  let token;
  do {
    const page = await s3
      .listObjectsV2({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
      .promise();
    for (const obj of page.Contents || []) {
      if (obj.Key) found.push(obj);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}

/**
 * Every event code the bucket holds anything for, mapped to the actual prefixes
 * and keys it was found under. The prefixes are kept verbatim rather than
 * rebuilt from the code, so what gets deleted is exactly what was listed.
 */
async function collectS3Codes(s3, bucket) {
  const byCode = new Map();
  const remember = (code, target) => {
    const key = codeKey(code);
    if (!byCode.has(key)) byCode.set(key, { code, targets: [] });
    byCode.get(key).targets.push(target);
  };

  for (const root of MEDIA_ROOTS) {
    for (const prefix of await listChildPrefixes(s3, bucket, root)) {
      const code = prefix.slice(root.length).replace(/\/+$/, '');
      if (code) remember(code, prefix);
    }
  }

  for (const obj of await listObjects(s3, bucket, QR_ROOT)) {
    const name = obj.Key.slice(QR_ROOT.length);
    if (!name || name.includes('/') || !/\.png$/i.test(name)) continue;
    remember(name.replace(/\.png$/i, ''), obj.Key);
  }

  return byCode;
}

/** Count, bytes and newest timestamp across everything held for one code. */
async function measure(s3, bucket, targets) {
  const objects = [];
  for (const target of targets) {
    objects.push(...(await listObjects(s3, bucket, target)));
  }
  let bytes = 0;
  let newestMs = null;
  for (const obj of objects) {
    bytes += obj.Size || 0;
    const ms = obj.LastModified ? new Date(obj.LastModified).getTime() : null;
    if (ms != null && (newestMs == null || ms > newestMs)) newestMs = ms;
  }
  return { objects, count: objects.length, bytes, newestMs };
}

/**
 * Delete listed objects, reporting what actually went. Quiet mode names only
 * failures, so anything reported back was NOT deleted even though the call
 * itself succeeded — the difference between "we deleted your photos" being true
 * and merely having been attempted.
 */
async function deleteObjects(s3, bucket, keys) {
  let deleted = 0;
  const failures = [];
  for (const batch of chunk(keys, DELETE_BATCH)) {
    const res = await s3
      .deleteObjects({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
      .promise();
    const errors = res.Errors || [];
    for (const err of errors) failures.push(`${err.Key}: ${err.Code} ${err.Message}`);
    deleted += batch.length - errors.length;
  }
  return { deleted, failures };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 *   s3, rekognition       AWS clients (rekognition may be null to skip it)
 *   bucket                S3 bucket name
 *   liveCodes             every eventCode in the database
 *   liveCollectionIds     every collectionId in the database
 *   stillLive(code)       re-read the database for one code, immediately before
 *                         deleting it. liveCodes is a snapshot; an event created
 *                         while the run is in progress would not be in it, and
 *                         its photographs would be deleted minutes after being
 *                         taken. This is the check that stops that.
 *   now()                 current epoch ms
 *   log(line)
 */
async function sweep(deps, options) {
  const {
    s3,
    rekognition,
    bucket,
    liveCodes,
    liveCollectionIds,
    stillLive,
    now = () => Date.now(),
    log = console.log,
  } = deps;
  const { apply = false, minAgeHours = 24, onlyCode = null } = options || {};

  // A database that answers "no events at all" is far more likely to be the
  // wrong MONGO_URI, an unreadable collection or a half-open connection than a
  // business with no customers — and under this script's rule, "no events"
  // means every photograph in the bucket is an orphan.
  if (!liveCodes.length) {
    throw new Error('The database reports zero events. Refusing to treat the whole bucket as orphaned.');
  }

  const byCode = await collectS3Codes(s3, bucket);
  const { orphans, inUse, unrecognized } = classifyCodes(
    [...byCode.values()].map((entry) => entry.code),
    liveCodes
  );

  log(`${liveCodes.length} event(s) in the database; ${byCode.size} code(s) with media in ${bucket}`);
  log(`  ${inUse.length} in use, ${orphans.length} orphaned, ${unrecognized.length} unrecognized`);
  for (const name of unrecognized) {
    log(`  ? "${name}" is not an event code — left alone, look at it by hand`);
  }

  const wanted = onlyCode
    ? orphans.filter((code) => codeKey(code) === codeKey(onlyCode))
    : orphans;
  if (onlyCode && !wanted.length) {
    log(`--code=${onlyCode} matches no orphan. Nothing to do.`);
  }

  const summary = {
    examined: wanted.length,
    purged: 0,
    objectsDeleted: 0,
    bytesFreed: 0,
    skippedTooNew: 0,
    skippedRecreated: 0,
    failures: [],
    collectionsDeleted: 0,
  };

  for (const code of wanted.sort()) {
    const { targets } = byCode.get(codeKey(code));
    const { objects, count, bytes, newestMs } = await measure(s3, bucket, targets);
    const age = newestMs == null ? '—' : `${((now() - newestMs) / 3600000).toFixed(1)}h`;

    if (!isOldEnough(newestMs, now(), minAgeHours)) {
      summary.skippedTooNew++;
      log(`  ~ ${code}: ${count} object(s), ${humanBytes(bytes)}, newest ${age} old — younger than ${minAgeHours}h, skipped`);
      continue;
    }

    log(`  - ${code}: ${count} object(s), ${humanBytes(bytes)}, newest ${age} old`);
    if (!apply) continue;

    // Read the database again for this one code. See stillLive above.
    if (await stillLive(code)) {
      summary.skippedRecreated++;
      log(`    ! ${code} exists in the database now — created during this run. Left untouched.`);
      continue;
    }

    const { deleted, failures } = await deleteObjects(s3, bucket, objects.map((o) => o.Key));
    summary.objectsDeleted += deleted;
    summary.bytesFreed += bytes;
    if (failures.length) {
      summary.failures.push(...failures);
      log(`    FAILED to delete ${failures.length} object(s): ${failures[0]}`);
    } else {
      summary.purged++;
      log(`    deleted ${deleted} object(s)`);
    }
  }

  if (rekognition) {
    const ids = await listCollections(rekognition);
    const orphanedCollections = classifyCollections(ids, liveCollectionIds);
    log(`${ids.length} Rekognition collection(s); ${orphanedCollections.length} orphaned`);
    for (const id of orphanedCollections) {
      const code = id.slice(COLLECTION_PREFIX.length);
      if (onlyCode && codeKey(code) !== codeKey(onlyCode)) continue;
      log(`  - ${id}`);
      if (!apply) continue;
      if (await stillLive(code)) {
        summary.skippedRecreated++;
        log(`    ! ${code} exists in the database now. Left untouched.`);
        continue;
      }
      try {
        await rekognition.deleteCollection({ CollectionId: id }).promise();
        summary.collectionsDeleted++;
        log(`    deleted`);
      } catch (err) {
        if (err.code === 'ResourceNotFoundException') {
          log(`    already gone`);
        } else {
          summary.failures.push(`${id}: ${err.message}`);
          log(`    FAILED: ${err.message}`);
        }
      }
    }
  }

  return summary;
}

async function listCollections(rekognition) {
  const ids = [];
  let token;
  do {
    const page = await rekognition.listCollections({ NextToken: token }).promise();
    ids.push(...(page.CollectionIds || []));
    token = page.NextToken;
  } while (token);
  return ids;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Split apart on its own and checked, because --min-age-hours is a safety rail:
 * an off-by-one in the slice reads `--min-age-hours=48` as 8, and the guard
 * quietly stops guarding. A bad value is refused rather than falling back to
 * the default, which would look like it had been honoured.
 */
function parseArgs(args) {
  const flag = (name) => args.includes(`--${name}`);
  const value = (name) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? undefined : found.slice(`--${name}=`.length);
  };

  const rawAge = value('min-age-hours');
  // Number('') is 0, so an empty value would read as "sweep everything however
  // fresh" — the age guard switched off by a typo, silently.
  const minAgeHours = rawAge === undefined ? 24 : rawAge.trim() === '' ? NaN : Number(rawAge);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    throw new Error(`--min-age-hours must be a non-negative number, got "${rawAge}"`);
  }

  const onlyCode = value('code') || null;
  if (onlyCode !== null && !isEventCodeShape(onlyCode)) {
    throw new Error(`--code="${onlyCode}" is not an event code`);
  }

  return {
    apply: flag('delete'),
    skipRekognition: flag('skip-rekognition'),
    minAgeHours,
    onlyCode,
  };
}

async function main() {
  const { apply, skipRekognition, minAgeHours, onlyCode } = parseArgs(process.argv.slice(2));
  const bucket = process.env.S3_BUCKET_NAME;

  if (!bucket) throw new Error('S3_BUCKET_NAME is not set');

  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });
  const s3 = new AWS.S3();
  const rekognition = skipRekognition
    ? null
    : new AWS.Rekognition({ region: process.env.AWS_REGION });

  await mongoose.connect(process.env.MONGO_URI);
  const events = mongoose.connection.collection('events');
  const liveCodes = await events.distinct('eventCode');
  const liveCollectionIds = await events.distinct('collectionId');

  console.log(apply ? 'DELETING orphaned event media.' : 'Report only — pass --delete to remove anything.');

  const summary = await sweep(
    {
      s3,
      rekognition,
      bucket,
      liveCodes: liveCodes.filter(Boolean),
      liveCollectionIds: liveCollectionIds.filter(Boolean),
      stillLive: async (code) => !!(await events.findOne({ eventCode: codeKey(code) }, { projection: { _id: 1 } })),
      now: () => Date.now(),
    },
    { apply, minAgeHours, onlyCode }
  );

  await mongoose.disconnect();

  console.log(
    apply
      ? `done: ${summary.purged}/${summary.examined} code(s) purged, ${summary.objectsDeleted} object(s), ${humanBytes(summary.bytesFreed)} freed, ${summary.collectionsDeleted} collection(s) deleted`
      : `done: ${summary.examined} orphaned code(s) would be purged. Nothing was deleted.`
  );
  if (summary.skippedTooNew) console.log(`${summary.skippedTooNew} skipped as too new (--min-age-hours=${minAgeHours})`);
  if (summary.skippedRecreated) console.log(`${summary.skippedRecreated} skipped: recreated during the run`);
  if (summary.failures.length) {
    console.error(`${summary.failures.length} deletion(s) FAILED — media remains and is still reachable:`);
    for (const failure of summary.failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MEDIA_ROOTS,
  QR_ROOT,
  COLLECTION_PREFIX,
  PROTECTED_COLLECTIONS,
  DELETE_BATCH,
  codeKey,
  isEventCodeShape,
  classifyCodes,
  isOldEnough,
  classifyCollections,
  chunk,
  parseArgs,
  humanBytes,
  collectS3Codes,
  deleteObjects,
  sweep,
};

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
