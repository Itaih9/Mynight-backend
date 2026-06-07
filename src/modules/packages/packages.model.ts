import mongoose, { Document, Schema } from 'mongoose';

export interface IPackage extends Document {
  key: string;
  title: string;
  englishTitle: string;
  price: number;
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
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Package = mongoose.model<IPackage>('Package', packageSchema);
