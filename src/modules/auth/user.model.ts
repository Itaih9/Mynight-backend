import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  phoneNumber: string;
  password?: string;
  name?: string;
  email?: string;
  partnerName1?: string;
  partnerName2?: string;
  weddingDate?: Date;
  referredBy?: string;
  referralCode: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    phoneNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    partnerName1: {
      type: String,
      trim: true,
    },
    partnerName2: {
      type: String,
      trim: true,
    },
    weddingDate: {
      type: Date,
    },
    referredBy: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      select: false,
    },
    referralCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

export const User = mongoose.model<IUser>('User', userSchema);
