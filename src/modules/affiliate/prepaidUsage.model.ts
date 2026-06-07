import mongoose, { Document, Schema } from 'mongoose';

export interface IPrepaidUsage extends Document {
  affiliateId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  couponCode: string;
  eventName: string;
  coupleName?: string;
  usedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const prepaidUsageSchema = new Schema<IPrepaidUsage>(
  {
    affiliateId: {
      type: Schema.Types.ObjectId,
      ref: 'Affiliate',
      required: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    couponCode: {
      type: String,
      required: true,
      uppercase: true,
    },
    eventName: {
      type: String,
      required: true,
    },
    coupleName: {
      type: String,
    },
    usedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

prepaidUsageSchema.index({ affiliateId: 1, createdAt: -1 });
prepaidUsageSchema.index({ eventId: 1 });

export const PrepaidUsage = mongoose.model<IPrepaidUsage>('PrepaidUsage', prepaidUsageSchema);
