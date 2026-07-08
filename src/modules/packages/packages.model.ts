import mongoose, { Document, Schema } from 'mongoose';

export interface IPackage extends Document {
  key: string;
  title: string;
  englishTitle: string;
  price: number;
  // Optional "compare at" price shown struck-through above the real price
  // (used for the Perfect Night package). 0 = auto (sum of the other packages).
  compareAtPrice?: number;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const packageSchema = new Schema<IPackage>(
  {
    key: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    englishTitle: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, default: 0, min: 0 },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Package = mongoose.model<IPackage>('Package', packageSchema);
