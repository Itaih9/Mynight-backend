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
 * ⚠️ PLACEHOLDER — set this to the real price before charging anyone.
 */
export const FLASH_PLUS_PRICE_ILS = 149;

export const FLASH_PLUS_PACKAGE_NAME = 'פלאש+';

/** Resolve a tier string (possibly undefined/legacy) to its plan. */
export const planFor = (tier?: string | null): FlashPlan =>
  FLASH_PLANS[tier === 'plus' ? 'plus' : 'basic'];

export const isPlus = (tier?: string | null): boolean => tier === 'plus';
