import mongoose, { Document, Schema } from 'mongoose';

/**
 * A short link behind a printed QR, so a scan can be counted.
 *
 * The campaign tracker cannot do this job: its token encodes a campaign id AND
 * an event id and resolves the destination from that campaign, so it only ever
 * works for a link sent to one couple about one campaign. A QR on a flyer, a
 * business card or an expo stand belongs to nobody in particular and needs a
 * row of its own.
 *
 * Counts are kept as a running total plus a per-day bucket. Per-scan rows would
 * give a finer timeline and grow without limit for something that may sit on a
 * poster for a year; a day is the smallest unit anyone actually asks about
 * ("how many scans on the day of the fair").
 */
export interface ITrackedLink extends Document {
  code: string;
  targetUrl: string;
  label: string;
  scans: number;
  daily: { day: string; count: number }[];
  lastScanAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const trackedLinkSchema = new Schema<ITrackedLink>(
  {
    code: { type: String, required: true, unique: true, trim: true },
    targetUrl: { type: String, required: true, trim: true },
    // What this QR is, in words, so a list of them is readable a year later:
    // "expo stand banner", "business card back".
    label: { type: String, required: true, trim: true },
    scans: { type: Number, default: 0 },
    daily: {
      type: [{ day: String, count: Number }],
      default: [],
    },
    lastScanAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const TrackedLink = mongoose.model<ITrackedLink>('TrackedLink', trackedLinkSchema);
