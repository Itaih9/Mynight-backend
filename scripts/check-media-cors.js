/**
 * Can the website's pages READ photo files from the S3 bucket?
 *
 * The frontend saves several photos to a phone as separate files (iPhone share
 * sheet, Android downloads) instead of one zip. To do that the page fetch()es
 * each file through its signed download URL — and a fetch() from the site to
 * the bucket is cross-origin, so S3 answers it only if the bucket's CORS rules
 * allow GET from the site. If they do not, every phone silently falls back to
 * the zip. Nothing breaks, but the feature never happens.
 *
 * Guests already upload straight to the bucket, so CORS rules for the site
 * exist; whether they include GET is what this checks.
 *
 * Usage:
 *   node scripts/check-media-cors.js              # report + live probe (read-only)
 *   node scripts/check-media-cors.js --apply      # add the missing GET rule
 *   node scripts/check-media-cors.js --origin=https://mynight.co.il --origin=https://www.mynight.co.il
 *   node scripts/check-media-cors.js --key=events/ABC123/photo.jpg   # probe this object
 *   node scripts/check-media-cors.js --no-probe
 *
 * Origins default to FRONTEND_URL plus its www/apex twin: S3 matches origins
 * exactly, and a site reachable at both would need both.
 *
 * The probe is the real answer, not this script's reading of the rules: it
 * signs a GET for one real photo exactly as the app does, sends it with the
 * site's Origin header, asks for one byte, and reports whether S3 replied with
 * Access-Control-Allow-Origin.
 *
 * --apply never edits or removes an existing rule. It saves the current rules
 * to cors-backup-<bucket>-<time>.json first, then adds one rule (ID
 * "mynight-media-read": GET and HEAD from the missing origins), then re-reads
 * and re-probes. Running it again changes nothing. To undo, put the backup
 * back with `aws s3api put-bucket-cors`.
 *
 * Exit code 0 when every origin can read, 1 when any cannot.
 */
require('dotenv').config();
const fs = require('fs');
const https = require('https');

const RULE_ID = 'mynight-media-read';
/** S3 refuses a CORS configuration with more rules than this. */
const MAX_RULES = 100;

const parseArgs = (argv) => {
  const values = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3)).filter(Boolean);
  return {
    apply: argv.includes('--apply'),
    probe: !argv.includes('--no-probe'),
    origins: values('origin'),
    key: values('key')[0],
  };
};

/**
 * FRONTEND_URL's origin, plus its www/apex twin. Only the origin counts —
 * a path or trailing slash in FRONTEND_URL must not end up in a CORS rule,
 * where it would never match.
 */
const originVariants = (frontendUrl) => {
  let url;
  try {
    url = new URL(frontendUrl);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
  const origins = [url.origin];
  const host = url.hostname;
  // A dotted name (not localhost, not an IP) can have a www twin.
  const isName = /[a-z]/i.test(host) && host.includes('.');
  if (isName) {
    const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
    origins.push(`${url.protocol}//${twin}${url.port ? `:${url.port}` : ''}`);
  }
  return origins;
};

/** S3 AllowedOrigin: an exact origin, or one containing a single "*" wildcard ("*" alone matches all). */
const originMatches = (pattern, origin) => {
  if (!pattern.includes('*')) return pattern === origin;
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(origin);
};

const ruleAllows = (rule, origin, method = 'GET') =>
  (rule.AllowedMethods || []).map((m) => String(m).toUpperCase()).includes(method) &&
  (rule.AllowedOrigins || []).some((pattern) => originMatches(pattern, origin));

/** For each origin: can it GET, and which rule (by index) says so. */
const analyze = (rules, origins) =>
  origins.map((origin) => {
    const index = rules.findIndex((rule) => ruleAllows(rule, origin));
    return { origin, allowed: index !== -1, ruleIndex: index };
  });

/**
 * The rules after adding read access for `missing`. Existing rules are
 * returned untouched, in order; the only change is our own rule — created,
 * or extended if an earlier run made it.
 */
const planApply = (rules, missing) => {
  if (missing.length === 0) return rules;
  const index = rules.findIndex((rule) => rule.ID === RULE_ID);
  if (index === -1) {
    if (rules.length + 1 > MAX_RULES) throw new Error(`the bucket already has ${rules.length} CORS rules; S3 allows ${MAX_RULES}`);
    return [
      ...rules,
      { ID: RULE_ID, AllowedOrigins: [...missing], AllowedMethods: ['GET', 'HEAD'], MaxAgeSeconds: 3000 },
    ];
  }
  const ours = rules[index];
  const methods = new Set([...(ours.AllowedMethods || []), 'GET', 'HEAD']);
  const origins = [...(ours.AllowedOrigins || [])];
  for (const origin of missing) if (!origins.includes(origin)) origins.push(origin);
  const next = [...rules];
  next[index] = { ...ours, AllowedOrigins: origins, AllowedMethods: [...methods] };
  return next;
};

/** What a browser would conclude from S3's response headers. */
const probeVerdict = (headers, origin) => {
  const allow = headers['access-control-allow-origin'];
  return allow === '*' || allow === origin;
};

const getRules = async (s3, bucket) => {
  try {
    const result = await s3.getBucketCors({ Bucket: bucket }).promise();
    return result.CORSRules || [];
  } catch (err) {
    if (err && err.code === 'NoSuchCORSConfiguration') return [];
    throw err;
  }
};

/** A real photo to probe with: the first non-empty object under events/. */
const pickProbeKey = async (s3, bucket) => {
  const result = await s3.listObjectsV2({ Bucket: bucket, Prefix: 'events/', MaxKeys: 20 }).promise();
  const object = (result.Contents || []).find((o) => o.Size > 0 && !o.Key.endsWith('/'));
  return object ? object.Key : null;
};

const httpGet = (url, headers) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      response.resume(); // one byte was asked for; discard it
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.setTimeout(15000, () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });

/** Sign the GET exactly as photos.service getDownloadUrl does, and send it as the site would. */
const probe = async ({ s3, bucket, key, origins, get }) => {
  const fileName = key.split('/').pop();
  const url = s3.getSignedUrl('getObject', {
    Bucket: bucket,
    Key: key,
    Expires: 300,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
  });
  const verdicts = [];
  for (const origin of origins) {
    try {
      const response = await get(url, { Origin: origin, Range: 'bytes=0-0' });
      const readable = response.status < 400 && probeVerdict(response.headers, origin);
      verdicts.push({ origin, readable, status: response.status });
    } catch (err) {
      verdicts.push({ origin, readable: false, status: null, error: err.message });
    }
  }
  return verdicts;
};

const printRules = (log, rules, analysis) => {
  log(`   ${rules.length} rule(s) on the bucket.`);
  for (const { origin, allowed, ruleIndex } of analysis) {
    log(`   ${allowed ? 'GET allowed' : 'GET NOT allowed'}  ${origin}${allowed ? `  (rule #${ruleIndex + 1}${rules[ruleIndex].ID ? ` "${rules[ruleIndex].ID}"` : ''})` : ''}`);
  }
};

const printProbe = (log, verdicts) => {
  for (const v of verdicts) {
    const detail = v.error ? `error: ${v.error}` : `HTTP ${v.status}`;
    log(`   ${v.readable ? 'readable ' : 'REFUSED  '}  ${v.origin}  (${detail})`);
  }
};

/**
 * Everything I/O comes in through `deps`, so the whole flow — including
 * --apply — can be exercised without AWS.
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || console.log;
  const env = deps.env || process.env;
  const options = parseArgs(argv);
  const bucket = env.S3_BUCKET_NAME;
  if (!bucket) throw new Error('S3_BUCKET_NAME is not set');

  const origins = options.origins.length ? options.origins : originVariants(env.FRONTEND_URL || '');
  if (origins.length === 0) throw new Error('No site origin: set FRONTEND_URL, or pass --origin=https://your.site');

  let s3 = deps.s3;
  if (!s3) {
    const AWS = require('aws-sdk');
    AWS.config.update({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
    });
    s3 = new AWS.S3();
  }
  const get = deps.httpGet || httpGet;
  const writeFile = deps.writeFile || fs.writeFileSync;
  const now = deps.now || (() => new Date());

  log(`Bucket ${bucket}; checking ${origins.join(', ')}`);
  log('');
  log('1. CORS rules');
  let rules = await getRules(s3, bucket);
  let analysis = analyze(rules, origins);
  printRules(log, rules, analysis);

  let key = null;
  let verdicts = null;
  if (options.probe) {
    log('');
    log('2. Live probe (a signed GET of one byte, sent with the site\'s Origin)');
    key = options.key || (await pickProbeKey(s3, bucket));
    if (!key) {
      log('   No object under events/ to probe with; pass --key=<an S3 key>.');
    } else {
      log(`   object: ${key}`);
      verdicts = await probe({ s3, bucket, key, origins, get });
      printProbe(log, verdicts);
    }
  }

  const missing = analysis.filter((a) => !a.allowed).map((a) => a.origin);
  if (options.apply && missing.length > 0) {
    log('');
    log('3. Applying');
    const next = planApply(rules, missing);
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const backup = `cors-backup-${bucket}-${stamp}.json`;
    writeFile(backup, `${JSON.stringify({ CORSRules: rules }, null, 2)}\n`);
    log(`   saved the current rules to ${backup}`);
    await s3.putBucketCors({ Bucket: bucket, CORSConfiguration: { CORSRules: next } }).promise();
    log(`   added GET/HEAD for ${missing.join(', ')} (rule "${RULE_ID}"); other rules untouched`);
    rules = await getRules(s3, bucket);
    analysis = analyze(rules, origins);
    printRules(log, rules, analysis);
    if (options.probe && key) {
      verdicts = await probe({ s3, bucket, key, origins, get });
      printProbe(log, verdicts);
    }
  } else if (options.apply) {
    log('');
    log('3. Nothing to apply: every origin already has GET.');
  }

  // The probe is the authority when it ran; the rules otherwise.
  const readable = verdicts ? verdicts.every((v) => v.readable) : analysis.every((a) => a.allowed);
  log('');
  if (readable) {
    log('=> Phones can read the photos: saving several photos as separate files will work.');
  } else if (!analysis.every((a) => a.allowed)) {
    log('=> Phones CANNOT read the photos, so they fall back to the zip.');
    log('   Fix: node scripts/check-media-cors.js --apply');
  } else {
    log('=> The rules allow GET but S3 did not answer with CORS headers.');
    log('   A rule change takes a few seconds to take effect; run this again. If it');
    log('   persists, check that the probe object exists and the credentials can read it.');
  }
  return readable ? 0 : 1;
}

module.exports = {
  RULE_ID,
  MAX_RULES,
  parseArgs,
  originVariants,
  originMatches,
  ruleAllows,
  analyze,
  planApply,
  probeVerdict,
  main,
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(2);
    });
}
