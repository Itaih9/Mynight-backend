import mongoose, { Document, Schema } from 'mongoose';

export interface ISharingPermissions {
  showProPhotos: boolean;
  showGuestPhotos: boolean;
  showGuestStories: boolean;
}

export interface IGuestListFile {
  s3Key: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: Date;
}

export interface ICoverImage {
  s3Key: string;
  url: string;
  uploadedAt: Date;
}

export interface IEvent extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  eventCode: string;
  customSlug?: string;
  slugChangeCount: number;
  collectionId: string;
  isPaid: boolean;
  packageName?: string;
  paymentId?: mongoose.Types.ObjectId;
  photoCount: number;
  lastPhotoUploadedAt?: Date;
  uploadStartedAt?: Date;
  uploadExpiresAt?: Date;
  expiresAt: Date;
  weddingDate?: Date;
  // Credited photographer for this event's pro photos (set by admin).
  photographerName?: string;
  photographerInstagram?: string;
  // Disposable-camera mode: guests shoot a limited film roll via /camera/:code.
  disposableEnabled?: boolean;
  disposableShotLimit?: number;
  sharingPermissions: ISharingPermissions;
  guestListFile?: IGuestListFile;
  guestListUploadCount: number;
  coverImage?: ICoverImage;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new Schema<IEvent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    eventCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    customSlug: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
    },
    slugChangeCount: {
      type: Number,
      default: 0,
    },
    collectionId: {
      type: String,
      required: true,
      unique: true,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    packageName: {
      type: String,
      trim: true,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment',
    },
    photoCount: {
      type: Number,
      default: 0,
    },
    lastPhotoUploadedAt: {
      type: Date,
    },
    uploadStartedAt: {
      type: Date,
    },
    uploadExpiresAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    weddingDate: {
      type: Date,
    },
    photographerName: {
      type: String,
      trim: true,
    },
    photographerInstagram: {
      type: String,
      trim: true,
    },
    disposableEnabled: {
      type: Boolean,
      default: false,
    },
    disposableShotLimit: {
      type: Number,
      default: 16,
    },
    sharingPermissions: {
      type: {
        showProPhotos: { type: Boolean, default: true },
        showGuestPhotos: { type: Boolean, default: true },
        showGuestStories: { type: Boolean, default: true },
      },
      default: {
        showProPhotos: true,
        showGuestPhotos: true,
        showGuestStories: true,
      },
    },
    guestListFile: {
      type: {
        s3Key: { type: String, required: true },
        originalName: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, required: true },
        uploadedAt: { type: Date, required: true },
      },
      required: false,
    },
    guestListUploadCount: {
      type: Number,
      default: 0,
    },
    coverImage: {
      type: {
        s3Key: { type: String, required: true },
        url: { type: String, required: true },
        uploadedAt: { type: Date, required: true },
      },
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

eventSchema.index({ userId: 1 });
eventSchema.index({ expiresAt: 1 });
eventSchema.index({ customSlug: 1 });

export const Event = mongoose.model<IEvent>('Event', eventSchema);
