/**
 * Flash plan tiers — the single source of truth for what each tier unlocks.
 *
 * - basic (free): a short film roll, photos only.
 * - plus  (paid): more shots per guest, video, and the face-recognition album.
 *
 * Everything that gates a feature by tier (shot limit, video, face match) reads
 * from here, and the pricing/payment surfaces read FLASH_PLUS_PRICE_ILS.
 */
export type FlashTier = 'basic' | 'plus';

export interface FlashPlan {
  shotLimit: number;
  video: boolean;
  faceRecognition: boolean;
}

export const FLASH_PLANS: Record<FlashTier, FlashPlan> = {
  basic: { shotLimit: 8, video: false, faceRecognition: false },
  plus: { shotLimit: 24, video: true, faceRecognition: true },
};

/**
 * One-time price (in ILS / ₪) to upgrade an event to Flash Plus.
 */
export const FLASH_PLUS_PRICE_ILS = 50;

export const FLASH_PLUS_PACKAGE_NAME = 'פלאש+';

/** Resolve a tier string (possibly undefined/legacy) to its plan. */
export const planFor = (tier?: string | null): FlashPlan =>
  FLASH_PLANS[tier === 'plus' ? 'plus' : 'basic'];

/** Ceiling on a per-event roll, so a typo cannot hand out an unlimited camera. */
export const MAX_ROLL_LENGTH = 200;

/**
 * How many shots one guest gets at this event.
 *
 * The tier sets the default (8 free, 24 Plus). `disposableShotLimit` overrides
 * it per event, for the deals the tiers do not describe — a venue package, a
 * promo, a couple who asked for a shorter roll.
 *
 * Absent means "no override", which is why the schema no longer defaults it:
 * a stored default is indistinguishable from a deliberate choice, and every
 * event carrying one would silently pin itself to that number forever.
 */
export const rollLengthFor = (event: {
  flashTier?: string | null;
  disposableShotLimit?: number | null;
}): number => {
  const override = event.disposableShotLimit;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.min(MAX_ROLL_LENGTH, Math.round(override));
  }
  return planFor(event.flashTier).shotLimit;
};

export const isPlus = (tier?: string | null): boolean => tier === 'plus';
