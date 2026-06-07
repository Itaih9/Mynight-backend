import mongoose, { Document, Schema } from 'mongoose';

export interface IReferral extends Document {
  affiliateId: mongoose.Types.ObjectId;
  referredUserId: mongoose.Types.ObjectId;
  referralCode: string;
  status: 'pending' | 'converted' | 'paid';
  commissionAmount: number;
  commissionRate: number;
  paymentId?: mongoose.Types.ObjectId;
  paymentAmount?: number;
  convertedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const COMMISSION_RATE = 0.02; // 2% commission

const referralSchema = new Schema<IReferral>(
  {
    affiliateId: {
      type: Schema.Types.ObjectId,
      ref: 'Affiliate',
      required: true,
    },
    referredUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    referralCode: {
      type: String,
      required: true,
      uppercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'converted', 'paid'],
      default: 'pending',
    },
    commissionAmount: {
      type: Number,
      default: 0,
    },
    commissionRate: {
      type: Number,
      default: COMMISSION_RATE,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment',
    },
    paymentAmount: {
      type: Number,
    },
    convertedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

referralSchema.index({ affiliateId: 1 });
referralSchema.index({ referredUserId: 1 });
referralSchema.index({ referralCode: 1 });
referralSchema.index({ status: 1 });

export const Referral = mongoose.model<IReferral>('Referral', referralSchema);
