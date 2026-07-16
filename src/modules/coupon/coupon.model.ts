import mongoose, { Document, Schema } from 'mongoose';

export interface ICoupon extends Document {
  code: string;
  discountPercent: number;
  discountAmount?: number;
  maxUses: number;
  usedCount: number;
  expiresAt?: Date;
  isActive: boolean;
  createdBy?: mongoose.Types.ObjectId;
  affiliateId?: mongoose.Types.ObjectId;
  ownerUserId?: mongoose.Types.ObjectId;
  ownerEventId?: mongoose.Types.ObjectId;
  // When set, the coupon only applies to this package (by packageName). Empty =
  // valid for every package.
  packageName?: string;
  // True once an event coupon has been individually edited, so bulk
  // "apply defaults to existing" leaves it alone.
  customized?: boolean;
  type: 'standard' | 'affiliate' | 'prepaid' | 'personal' | 'event';
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    discountPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    discountAmount: {
      type: Number,
      min: 0,
    },
    maxUses: {
      type: Number,
      default: 0, // 0 = unlimited
    },
    usedCount: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    affiliateId: {
      type: Schema.Types.ObjectId,
      ref: 'Affiliate',
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    ownerEventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
    },
    packageName: {
      type: String,
      trim: true,
    },
    customized: {
      type: Boolean,
      default: false,
    },
    type: {
      type: String,
      enum: ['standard', 'affiliate', 'prepaid', 'personal', 'event'],
      default: 'standard',
    },
  },
  {
    timestamps: true,
  }
);

couponSchema.index({ code: 1 });
couponSchema.index({ isActive: 1 });
couponSchema.index({ affiliateId: 1 });
couponSchema.index({ ownerUserId: 1 });
couponSchema.index({ ownerEventId: 1 });
couponSchema.index({ type: 1 });

export const Coupon = mongoose.model<ICoupon>('Coupon', couponSchema);
