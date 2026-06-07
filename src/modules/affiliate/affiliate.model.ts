import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IAffiliate extends Document {
  name?: string;
  email: string;
  password: string;
  paypalEmail?: string;
  phone: string;
  category: 'photographer' | 'makeup' | 'costume' | 'manager' | 'venue' | 'other';
  intent: 'resell' | 'affiliate';
  status: 'pending' | 'approved' | 'rejected';
  referralCode: string;
  totalEarnings: number;
  pendingEarnings: number;
  paidEarnings: number;
  totalReferrals: number;
  bankDetails?: string;
  bankName?: string;
  bankBranch?: string;
  bankAccountNumber?: string;
  bankAccountHolder?: string;
  prepaidBalance: number;
  prepaidUsed: number;
  prepaidCouponCode?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const affiliateSchema = new Schema<IAffiliate>(
  {
    name: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    paypalEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      enum: ['photographer', 'makeup', 'costume', 'manager', 'venue', 'other'],
    },
    intent: {
      type: String,
      required: true,
      enum: ['resell', 'affiliate'],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    referralCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    totalEarnings: {
      type: Number,
      default: 0,
    },
    pendingEarnings: {
      type: Number,
      default: 0,
    },
    paidEarnings: {
      type: Number,
      default: 0,
    },
    totalReferrals: {
      type: Number,
      default: 0,
    },
    bankDetails: {
      type: String,
      trim: true,
    },
    bankName: { type: String, trim: true },
    bankBranch: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    bankAccountHolder: { type: String, trim: true },
    prepaidBalance: { type: Number, default: 0 },
    prepaidUsed: { type: Number, default: 0 },
    prepaidCouponCode: { type: String, uppercase: true, trim: true },
  },
  {
    timestamps: true,
  }
);

affiliateSchema.index({ email: 1 });
affiliateSchema.index({ status: 1 });
affiliateSchema.index({ referralCode: 1 });

// Hash password before saving
affiliateSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
affiliateSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

export const Affiliate = mongoose.model<IAffiliate>('Affiliate', affiliateSchema);
