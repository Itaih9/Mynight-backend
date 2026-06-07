import mongoose, { Document, Schema } from 'mongoose';

export interface IGuest extends Document {
  eventId: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  status: 'pending' | 'invited' | 'viewed' | 'uploaded';
  invitedAt?: Date;
  viewedAt?: Date;
  uploadedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const guestSchema = new Schema<IGuest>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'invited', 'viewed', 'uploaded'],
      default: 'pending',
    },
    invitedAt: {
      type: Date,
    },
    viewedAt: {
      type: Date,
    },
    uploadedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

guestSchema.index({ eventId: 1 });
guestSchema.index({ eventId: 1, phone: 1 }, { unique: true });

export const Guest = mongoose.model<IGuest>('Guest', guestSchema);
