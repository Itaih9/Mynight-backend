import mongoose, { Document, Schema } from 'mongoose';

export type ReviewStatus = 'pending' | 'approved' | 'hidden';

export interface IReview extends Document {
  rating: number;
  text: string;
  userId?: mongoose.Types.ObjectId;
  name?: string;
  status: ReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'hidden'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  }
);

reviewSchema.index({ status: 1 });
reviewSchema.index({ createdAt: -1 });

export const Review = mongoose.model<IReview>('Review', reviewSchema);
