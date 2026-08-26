/**
 * The handful of messages the guest camera can put in front of a guest.
 *
 * These come back as API errors, so they cannot live in the frontend's
 * dictionary — the server decides them. Keyed by the event's cameraLanguage so
 * a guest at an English event never gets a Hebrew sentence they cannot read.
 *
 * Every message also carries a stable `code`, because the camera page has to
 * branch on "out of film" to end the roll, and branching on the text of a
 * message that now exists in two languages is how that quietly stops working.
 */
export type CameraLanguage = 'he' | 'en';

export const CAMERA_ERROR_CODES = {
  OUT_OF_FILM: 'OUT_OF_FILM',
  VIDEO_REQUIRES_PLUS: 'VIDEO_REQUIRES_PLUS',
  FACES_REQUIRE_PLUS: 'FACES_REQUIRE_PLUS',
} as const;

const MESSAGES: Record<CameraLanguage, Record<keyof typeof CAMERA_ERROR_CODES, string>> = {
  he: {
    OUT_OF_FILM: 'אזל הפילם 🎞️',
    VIDEO_REQUIRES_PLUS: 'וידאו זמין רק ב-Flash Plus',
    FACES_REQUIRE_PLUS: 'זיהוי הפנים זמין רק ב-Flash Plus',
  },
  en: {
    OUT_OF_FILM: 'Out of film 🎞️',
    VIDEO_REQUIRES_PLUS: 'Video is a Flash Plus feature',
    FACES_REQUIRE_PLUS: 'Face albums are a Flash Plus feature',
  },
};

/** Normalise whatever is stored on the event; Hebrew is the default. */
export const cameraLanguageOf = (event: { cameraLanguage?: string | null }): CameraLanguage =>
  event.cameraLanguage === 'en' ? 'en' : 'he';

export const cameraMessage = (
  event: { cameraLanguage?: string | null },
  key: keyof typeof CAMERA_ERROR_CODES
): string => MESSAGES[cameraLanguageOf(event)][key];
