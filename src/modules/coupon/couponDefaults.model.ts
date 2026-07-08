import mongoose, { Document, Schema } from 'mongoose';

// Singleton settings document holding the defaults used when auto-creating the
// per-event gift coupon. Editable from the admin coupon dashboard.
export interface ICouponDefaults extends Document {
  key: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxUses: number;
  createdAt: Date;
  updatedAt: Date;
}

const couponDefaultsSchema = new Schema<ICouponDefaults>(
  {
    key: { type: String, required: true, unique: true, default: 'event-coupon' },
    discountType: { type: String, enum: ['percent', 'fixed'], default: 'fixed' },
    discountValue: { type: Number, default: 150, min: 0 },
    maxUses: { type: Number, default: 3, min: 0 },
  },
  { timestamps: true }
);

export const CouponDefaults = mongoose.model<ICouponDefaults>('CouponDefaults', couponDefaultsSchema);
