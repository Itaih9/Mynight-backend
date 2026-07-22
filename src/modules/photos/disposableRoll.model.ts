import mongoose, { Document, Schema } from 'mongoose';

/**
 * Per-guest disposable-camera roll. `fired` counts every shutter press and only
 * ever increases — so deleting a shot removes the photo but never gives the
 * shot back. Remaining = event.disposableShotLimit - fired.
 */
export interface IDisposableRoll extends Document {
  eventId: mongoose.Types.ObjectId;
  deviceId: string;
  fired: number;
  createdAt: Date;
  updatedAt: Date;
}

const disposableRollSchema = new Schema<IDisposableRoll>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    deviceId: { type: String, required: true },
    fired: { type: Number, default: 0 },
  },
  { timestamps: true }
);

disposableRollSchema.index({ eventId: 1, deviceId: 1 }, { unique: true });

export const DisposableRoll = mongoose.model<IDisposableRoll>('DisposableRoll', disposableRollSchema);
