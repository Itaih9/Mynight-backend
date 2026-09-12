import crypto from 'crypto';

/**
 * Constant-time comparison of a caller-supplied secret against the configured
 * one.
 *
 * Returns false when nothing is configured, so a mechanism guarded by this is
 * OFF until an operator sets its variable — never open with a default everyone
 * can read in the repository.
 *
 * Constant-time because `!==` returns as soon as two bytes differ, which leaks
 * the length of the matching prefix to anyone able to time the response. That
 * is a slow attack over a network and a fast one from inside the same region.
 */
export const secretMatches = (candidate: unknown, expected?: string): boolean => {
  if (!expected || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the lengths themselves are
  // not the secret, so compare them first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};
