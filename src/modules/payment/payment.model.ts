import mongoose, { Document, Schema } from 'mongoose';

export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
export type PaymentProvider = 'sumit' | 'coupon' | 'stripe';

export interface IPayment extends Document {
  userId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  amount: number;
  originalAmount?: number;
  discountAmount?: number;
  currency: string;
  status: PaymentStatus;
  paymentIntentId: string;
  provider: PaymentProvider;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    originalAmount: {
      type: Number,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: 'ILS',
      uppercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentIntentId: {
      type: String,
      required: true,
      unique: true,
    },
    provider: {
      type: String,
      enum: ['sumit', 'coupon', 'stripe'],
      default: 'sumit',
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

paymentSchema.index({ userId: 1 });
paymentSchema.index({ eventId: 1 });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
