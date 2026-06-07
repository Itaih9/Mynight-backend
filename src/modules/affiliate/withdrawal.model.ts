import mongoose, { Document, Schema } from 'mongoose';

export interface IWithdrawal extends Document {
  affiliateId: mongoose.Types.ObjectId;
  amount: number;
  status: 'pending' | 'paid' | 'rejected';
  note?: string;
  adminNote?: string;
  bankDetailsSnapshot?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const withdrawalSchema = new Schema<IWithdrawal>(
  {
    affiliateId: {
      type: Schema.Types.ObjectId,
      ref: 'Affiliate',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'rejected'],
      default: 'pending',
      index: true,
    },
    note: { type: String, trim: true },
    adminNote: { type: String, trim: true },
    bankDetailsSnapshot: { type: String },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export const Withdrawal = mongoose.model<IWithdrawal>('Withdrawal', withdrawalSchema);
