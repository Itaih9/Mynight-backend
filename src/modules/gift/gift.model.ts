import mongoose, { Document, Schema } from 'mongoose';

export interface IGift extends Document {
  /** The gift's value — what the couple receives as a coupon. */
  amount: number;
  /** What the gifter actually pays (amount minus any promo coupon they applied). */
  chargeAmount: number;
  /** A promo coupon the gifter applied to their own purchase (e.g. SUMMER40). */
  appliedCoupon?: string;
  /** Set for a full-package gift; the coupon is restricted to this package. */
  packageName?: string;
  coupleName?: string;
  gifterEmail?: string;
  message?: string;
  /** The coupon the couple redeems — generated on successful payment. */
  couponCode?: string;
  status: 'pending' | 'paid' | 'failed';
  paymentIntentId?: string;
  /** Sumit redirect-flow transaction identifier. */
  sumitIdentifier?: string;
  createdAt: Date;
  updatedAt: Date;
}

const giftSchema = new Schema<IGift>(
  {
    amount: { type: Number, required: true, min: 1 },
    chargeAmount: { type: Number, required: true, min: 0 },
    appliedCoupon: { type: String, uppercase: true, trim: true },
    packageName: { type: String, trim: true },
    coupleName: { type: String, trim: true },
    gifterEmail: { type: String, trim: true, lowercase: true },
    message: { type: String, trim: true, maxlength: 500 },
    couponCode: { type: String, uppercase: true, trim: true },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    paymentIntentId: { type: String },
    sumitIdentifier: { type: String },
  },
  { timestamps: true }
);

giftSchema.index({ couponCode: 1 });

export const Gift = mongoose.model<IGift>('Gift', giftSchema);
