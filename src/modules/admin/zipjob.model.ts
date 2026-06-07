import mongoose, { Schema, Document } from 'mongoose';

export interface IZipJob extends Document {
  eventId: mongoose.Types.ObjectId;
  s3Key: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  failedEntries: string[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const zipJobSchema = new Schema<IZipJob>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    s3Key: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    totalFiles: { type: Number, default: 0 },
    completedFiles: { type: Number, default: 0 },
    failedFiles: { type: Number, default: 0 },
    failedEntries: [{ type: String }],
    error: { type: String },
  },
  { timestamps: true }
);

export const ZipJob = mongoose.model<IZipJob>('ZipJob', zipJobSchema);
