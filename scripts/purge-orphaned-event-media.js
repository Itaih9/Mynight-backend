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
 *   node scripts/purge-orphaned-event-media.js --max-orphan-ratio=0.2
 *   node scripts/purge-orphaned-event-media.js --manifest=/var/log/purge.json
 *   node scripts/purge-orphaned-event-media.js --delete --skip-rekognition
 *
 * Every valued flag takes its value with an equals sign. `--code ABC` is
 * refused rather than read as "no --code", because no --code means EVERY
 * orphan and that is not a difference to discover afterwards.
 *
 * A --delete run refuses to start if the bucket has versioning enabled (a
 * delete there only writes markers and erases nothing), if no code in the
 * bucket is known to the database, or if the orphaned share is above
 * --max-orphan-ratio. It writes every key to a manifest before removing it.
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
const fs = require('fs');
const path = require('path');

/** Escape a string for use inside a RegExp, so a key cannot smuggle syntax. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every prefix under which event media is written, and the only ones this
 * script will delete from. Keep in sync with purgeEvent in events.service.ts —
 * a prefix missing from THAT list is what created the orphans in the first
 * place, and a prefix missing from THIS one leaves them behind again.
 */
const MEDIA_ROOTS = [
  'events/',
  'thumbnails/events/',
  'display/events/',
  // The photographer's full-resolution zip of the whole wedding. It is removed
  // best-effort after processing, so every failed or abandoned job leaves a
  // complete copy of the gallery here. Missing from the first version of this
  // list — the same omission that created the orphans in the first place.
  'zip-uploads/',
];
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

/**
 * Refuse to run when this share of the bucket's codes is unknown to the
 * database. The expected shape is a handful of orphans against every live
 * event; "most of the bucket is orphaned" is the signature of pointing at the
 * wrong database, not of a real backlog.
 */
const DEFAULT_MAX_ORPHAN_RATIO = 0.5;

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
 * Names that are obviously somebody's folder rather than an event. A generated
 * code cannot collide with these — it is uppercase and at least six characters
 * — so excluding them costs nothing and stops the sweep eating a directory a
 * human made by hand.
 */
const RESERVED_NAMES = new Set([
  'undefined', 'null', 'nan', 'none', 'default',
  'test', 'tests', 'temp', 'tmp', 'backup', 'backups', 'archive', 'archives',
  'old', 'new', 'staging', 'prod', 'production', 'migration', 'migrations',
]);

/**
 * Whether a directory name is an event code.
 *
 * The first version of this accepted anything three characters or longer, which
 * meant it returned TRUE for `undefined` — the very example its own comment
 * gave as the thing it was there to reject, and the exact directory a live
 * event's photos land in when eventCode is undefined at write time. It also
 * accepted `test`, `backup` and `staging`.
 *
 * Codes are generated uppercase from an alphabet with no 0/I/O, and mongoose
 * uppercases eventCode on the way in, so the bucket holds uppercase. Requiring
 * that rejects every lowercase word without needing to enumerate them. The
 * reserved list covers the uppercase spellings.
 *
 * A lowercase directory that IS a live code is still safe: codes are matched
 * case-insensitively against the database first, so it lands in `inUse` and is
 * never offered to this function's verdict at all.
 */
const isEventCodeShape = (code) => {
  const name = String(code || '');
  if (!/^[A-Z0-9]{6,16}$/.test(name)) return false;
  return !RESERVED_NAMES.has(name.toLowerCase());
};

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
    // The DATABASE is asked first, and case-insensitively. A directory that
    // belongs to a live event is in use however it is spelled — and if that
    // were decided by the shape rule instead, a lowercase directory holding a
    // live event's photos would count as "unrecognized" rather than "in use",
    // which is also one of the numbers the environment-coherence rail reads.
    if (live.has(codeKey(code))) inUse.push(code);
    else if (!isEventCodeShape(code)) unrecognized.push(code);
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

/**
 * On a versioned bucket, deleteObjects without a VersionId writes a delete
 * marker: CloudFront stops serving, but every byte is still there and still
 * readable to anything holding s3:GetObjectVersion — while this script prints
 * "14.3 GB freed". That is concealment reported as erasure, which is the exact
 * failure this whole line of work exists to remove. Refuse rather than lie.
 */
async function assertNotVersioned(s3, bucket) {
  const res = await s3.getBucketVersioning({ Bucket: bucket }).promise();
  const status = res && res.Status;
  if (status === 'Enabled' || status === 'Suspended') {
    throw new Error(
      `Bucket ${bucket} has versioning ${status}. A delete here only writes delete markers — ` +
        'the objects remain and stay retrievable by version, so nothing would actually be erased. ' +
        'Refusing. Purge versions deliberately, or re-run with --allow-versioned once you know that is what you want.'
    );
  }
}

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

/** Objects directly under a prefix, excluding anything inside a subdirectory. */
async function listObjectsShallow(s3, bucket, root) {
  const found = [];
  let token;
  do {
    const page = await s3
      .listObjectsV2({ Bucket: bucket, Prefix: root, Delimiter: '/', ContinuationToken: token })
      .promise();
    for (const obj of page.Contents || []) {
      if (obj.Key && obj.Key !== root) found.push(obj);
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

  const loose = [];
  for (const root of MEDIA_ROOTS) {
    for (const prefix of await listChildPrefixes(s3, bucket, root)) {
      const code = prefix.slice(root.length).replace(/\/+$/, '');
      if (code) remember(code, prefix);
    }
    // A delimiter listing returns directories and nothing else, so a file
    // sitting loose at events/stray.jpg belongs to no code, is invisible to
    // every count this script prints, and would be reported as swept. Surface
    // it; never delete it, since it belongs to nothing we can reason about.
    for (const obj of await listObjectsShallow(s3, bucket, root)) {
      loose.push(obj.Key);
    }
  }

  for (const obj of await listObjects(s3, bucket, QR_ROOT)) {
    const name = obj.Key.slice(QR_ROOT.length);
    if (!name || name.includes('/') || !/\.png$/i.test(name)) continue;
    remember(name.replace(/\.png$/i, ''), obj.Key);
  }

  return { byCode, loose };
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
    // Does any live Photo row still point INTO this prefix? photos.s3Key is the
    // authoritative record of what belongs to a live event — the code in the
    // path is only a convention. This catches what the name never can: photos
    // written under a code the directory spells differently, and anything that
    // landed in events/undefined/ because eventCode was undefined at write time.
    stillReferenced = async () => false,
    // Called with the full key list before a single delete, so there is a
    // record of what was removed. An irreversible deletion with no manifest
    // cannot answer "did you erase X" for a couple or a regulator.
    writeManifest = async () => {},
    now = () => Date.now(),
    log = console.log,
  } = deps;
  const {
    apply = false,
    minAgeHours = 24,
    onlyCode = null,
    maxOrphanRatio = DEFAULT_MAX_ORPHAN_RATIO,
    allowVersioned = false,
  } = options || {};

  // A database that answers "no events at all" is far more likely to be the
  // wrong MONGO_URI, an unreadable collection or a half-open connection than a
  // business with no customers — and under this script's rule, "no events"
  // means every photograph in the bucket is an orphan.
  if (!liveCodes.length) {
    throw new Error('The database reports zero events. Refusing to treat the whole bucket as orphaned.');
  }

  if (apply && !allowVersioned) await assertNotVersioned(s3, bucket);

  const { byCode, loose } = await collectS3Codes(s3, bucket);
  const { orphans, inUse, unrecognized } = classifyCodes(
    [...byCode.values()].map((entry) => entry.code),
    liveCodes
  );

  log(`${liveCodes.length} event(s) in the database; ${byCode.size} code(s) with media in ${bucket}`);
  log(`  ${inUse.length} in use, ${orphans.length} orphaned, ${unrecognized.length} unrecognized`);

  // The zero-events rail above catches an EMPTY database. This one catches a
  // WRONG one — a staging MONGO_URI beside the production S3_BUCKET_NAME, both
  // read from whatever .env the operator happens to be standing in. There
  // liveCodes is not empty, every real code classifies as an orphan, and the
  // per-code re-read queries that same wrong database and agrees. Nothing
  // downstream can catch it; the shape of the answer is the only tell.
  if (apply && inUse.length === 0 && orphans.length > 0) {
    throw new Error(
      `Not one of the ${byCode.size} code(s) in ${bucket} is in this database. ` +
        'That is a bucket and a database from different environments, not a backlog. Refusing.'
    );
  }
  const orphanRatio = byCode.size ? orphans.length / byCode.size : 0;
  if (apply && orphanRatio > maxOrphanRatio) {
    throw new Error(
      `${orphans.length} of ${byCode.size} code(s) (${Math.round(orphanRatio * 100)}%) are unknown to this database, ` +
        `above the ${Math.round(maxOrphanRatio * 100)}% limit. Refusing — check MONGO_URI and S3_BUCKET_NAME agree. ` +
        'Raise deliberately with --max-orphan-ratio= if this really is the backlog.'
    );
  }
  for (const name of unrecognized) {
    log(`  ? "${name}" is not an event code — left alone, look at it by hand`);
  }
  for (const key of loose) {
    log(`  ? ${key} sits loose under a media root, belonging to no code — left alone`);
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
    skippedReferenced: 0,
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

    // And ask the photos themselves, not just the event name.
    if (await stillReferenced(targets)) {
      summary.skippedReferenced++;
      log(`    ! ${code} still has photo rows pointing at it. Left untouched.`);
      continue;
    }

    await writeManifest(code, objects);

    const { deleted, failures } = await deleteObjects(s3, bucket, objects.map((o) => o.Key));
    summary.objectsDeleted += deleted;
    if (failures.length) {
      summary.failures.push(...failures);
      log(`    FAILED to delete ${failures.length} object(s): ${failures[0]}`);
    } else {
      // Counted here, not before the check: a code whose delete was partly
      // refused used to report its whole measured size as freed, and that
      // number is the one a compliance answer would quote.
      summary.bytesFreed += bytes;
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

      // The S3 side has --min-age-hours for the create-during-run race. The
      // collection side had nothing — and it is the WORSE race: every creation
      // path calls createCollection BEFORE Event.create, so the window where a
      // live event has a collection and no row is real. Losing it is silent,
      // because indexEventPhoto swallows the missing-collection error, and
      // face search is then dead for that wedding forever.
      const createdMs = await collectionCreatedAt(rekognition, id);
      if (!isOldEnough(createdMs, now(), minAgeHours)) {
        summary.skippedTooNew++;
        log(`    ~ created ${((now() - createdMs) / 3600000).toFixed(1)}h ago — younger than ${minAgeHours}h, skipped`);
        continue;
      }
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

/** When a collection was created, or null if that cannot be established. */
async function collectionCreatedAt(rekognition, collectionId) {
  try {
    const res = await rekognition.describeCollection({ CollectionId: collectionId }).promise();
    return res && res.CreationTimestamp ? new Date(res.CreationTimestamp).getTime() : null;
  } catch {
    // Unknown age is not a reason to delete. Treated as "too new" by the caller
    // only if we return something recent; null means isOldEnough passes, so be
    // explicit and report now() to hold it back instead.
    return Date.now();
  }
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

  // `--code ABC` rather than `--code=ABC` would be read as no --code at all,
  // and no --code means EVERY orphan. Refuse the spelling instead of quietly
  // widening the run.
  const VALUED = ['code', 'min-age-hours', 'max-orphan-ratio', 'manifest'];
  for (const name of VALUED) {
    const bare = args.indexOf(`--${name}`);
    if (bare !== -1) {
      throw new Error(`--${name} takes its value with an equals sign: --${name}=<value>`);
    }
  }

  const rawAge = value('min-age-hours');
  // Number('') is 0, so an empty value would read as "sweep everything however
  // fresh" — the age guard switched off by a typo, silently.
  const minAgeHours = rawAge === undefined ? 24 : rawAge.trim() === '' ? NaN : Number(rawAge);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    throw new Error(`--min-age-hours must be a non-negative number, got "${rawAge}"`);
  }

  // An empty --code= is the dangerous one: `--code=$CODE` with an unset shell
  // variable produced onlyCode=null, which is not "that one code" but "every
  // orphan in the bucket". Same class as `rm -rf $VAR/`.
  const rawCode = value('code');
  if (rawCode !== undefined && rawCode.trim() === '') {
    throw new Error('--code= was given with no value. Refusing: an empty --code would sweep every orphan, not one.');
  }
  const onlyCode = rawCode === undefined ? null : rawCode.trim();
  if (onlyCode !== null && !isEventCodeShape(onlyCode)) {
    throw new Error(`--code="${onlyCode}" is not an event code`);
  }

  const rawRatio = value('max-orphan-ratio');
  const maxOrphanRatio =
    rawRatio === undefined ? DEFAULT_MAX_ORPHAN_RATIO : rawRatio.trim() === '' ? NaN : Number(rawRatio);
  if (!Number.isFinite(maxOrphanRatio) || maxOrphanRatio <= 0 || maxOrphanRatio > 1) {
    throw new Error(`--max-orphan-ratio must be a number above 0 and at most 1, got "${rawRatio}"`);
  }

  return {
    apply: flag('delete'),
    skipRekognition: flag('skip-rekognition'),
    allowVersioned: flag('allow-versioned'),
    minAgeHours,
    onlyCode,
    maxOrphanRatio,
    manifestPath: value('manifest') || null,
  };
}

async function main() {
  const {
    apply, skipRekognition, allowVersioned, minAgeHours, onlyCode, maxOrphanRatio,
    manifestPath: manifestArg,
  } = parseArgs(process.argv.slice(2));
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
  const photos = mongoose.connection.collection('photos');
  const liveCodes = await events.distinct('eventCode');
  const liveCollectionIds = await events.distinct('collectionId');

  const manifestPath = path.resolve(
    manifestArg || `orphan-purge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  if (apply) console.log(`Manifest: ${manifestPath}`);

  console.log(apply ? 'DELETING orphaned event media.' : 'Report only — pass --delete to remove anything.');

  const summary = await sweep(
    {
      s3,
      rekognition,
      bucket,
      liveCodes: liveCodes.filter(Boolean),
      liveCollectionIds: liveCollectionIds.filter(Boolean),
      stillLive: async (code) => !!(await events.findOne({ eventCode: codeKey(code) }, { projection: { _id: 1 } })),
      // photos.s3Key is indexed, and an anchored prefix regex can use that
      // index. This is the authoritative question — the code in a path is only
      // a naming convention, and a photo row pointing into a prefix means a
      // live event owns those bytes whatever the directory is called.
      stillReferenced: async (targets) => {
        for (const target of targets) {
          const found = await photos.findOne(
            { s3Key: { $regex: `^${escapeRegex(target)}` } },
            { projection: { _id: 1 } }
          );
          if (found) return true;
        }
        return false;
      },
      writeManifest: async (code, objects) => {
        const line =
          JSON.stringify({
            at: new Date().toISOString(),
            bucket,
            code,
            objects: objects.map((o) => ({ key: o.Key, size: o.Size })),
          }) + '\n';
        // Appended and flushed before the delete, so an interrupted run still
        // leaves a record of everything it had already removed.
        await fs.promises.appendFile(manifestPath, line, 'utf8');
      },
      now: () => Date.now(),
    },
    { apply, minAgeHours, onlyCode, maxOrphanRatio, allowVersioned }
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
  RESERVED_NAMES,
  classifyCodes,
  isOldEnough,
  classifyCollections,
  chunk,
  parseArgs,
  escapeRegex,
  humanBytes,
  collectS3Codes,
  listObjectsShallow,
  assertNotVersioned,
  collectionCreatedAt,
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
