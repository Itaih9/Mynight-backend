/**
 * What each package includes — the single place that knows it.
 *
 * These rules used to live inline in photos.service as string comparisons
 * against the Hebrew title (`event.packageName === 'האוספת'`). Titles are
 * editable from the Packages screen, so renaming a package there silently
 * switched its restriction off: rename האוספת and its buyers would quietly gain
 * the guest face albums they did not pay for, with nothing in the code or the
 * admin UI to suggest a gate had just stopped firing.
 *
 * Keys never change, so events now carry `packageKey` and the gates read that.
 */

export interface PackageFeatures {
  /** Guest face albums — selfie matching and the per-guest album. */
  faceAlbums: boolean;
  /** Guests uploading their own photos into the shared gallery. */
  guestUpload: boolean;
}

/** Keyed on Package.key, which is fixed at seed time and never edited. */
const BY_KEY: Record<string, PackageFeatures> = {
  // האוספת — collects everything from the guests, no guest sorting.
  morning_after: { faceAlbums: false, guestUpload: true },
  // המושלמת — everything.
  unlimited: { faceAlbums: true, guestUpload: true },
  // החכמה — guest sorting and the WhatsApp album, but guests do not upload.
  here_i_am: { faceAlbums: true, guestUpload: false },
};

/**
 * An event with no package at all — a free פלאש signup, an admin event created
 * without one — is not restricted by package. Tier and payment still gate it.
 */
const UNRESTRICTED: PackageFeatures = { faceAlbums: true, guestUpload: true };

/**
 * Titles as they stood when events were stamped with a name and no key. Used
 * only to interpret events that pre-date `packageKey`; new events never rely
 * on it. If a title is renamed, old events keep matching through this map
 * because it records the historical name, not the current one.
 */
const LEGACY_TITLE_TO_KEY: Record<string, string> = {
  האוספת: 'morning_after',
  המושלמת: 'unlimited',
  החכמה: 'here_i_am',
};

/** Resolve a stored title to its key, for backfill and for legacy events. */
export const packageKeyForTitle = (title?: string | null): string | undefined => {
  const t = typeof title === 'string' ? title.trim() : '';
  return t ? LEGACY_TITLE_TO_KEY[t] : undefined;
};

/**
 * What this event's package allows. Prefers the stored key; falls back to the
 * historical title map so an event written before the key existed still gates
 * correctly, and defaults to unrestricted when there is no package.
 */
export const featuresFor = (event: {
  packageKey?: string | null;
  packageName?: string | null;
}): PackageFeatures => {
  const key = event.packageKey || packageKeyForTitle(event.packageName);
  return (key && BY_KEY[key]) || UNRESTRICTED;
};
