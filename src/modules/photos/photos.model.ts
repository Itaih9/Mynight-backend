import mongoose, { Document, Schema } from 'mongoose';

export interface IPhoto extends Document {
  eventId: mongoose.Types.ObjectId;
  s3Key: string;
  url: string;
  thumbnailUrl: string;
  posterUrl?: string;
  faceId?: string;
  indexedFaces?: Array<{
    faceId: string;
    confidence: number;
    boundingBox: {
      Width: number;
      Height: number;
      Left: number;
      Top: number;
    };
    externalImageId?: string;
    imageId?: string;
  }>;
  uploadedBy?: 'owner' | 'guest';
  uploaderName?: string;
  metadata: {
    size: number;
    mimeType: string;
    width?: number;
    height?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const photoSchema = new Schema<IPhoto>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    s3Key: {
      type: String,
      required: true,
      unique: true,
    },
    url: {
      type: String,
      required: true,
    },
    thumbnailUrl: {
      type: String,
      required: true,
    },
    posterUrl: {
      type: String,
    },
    faceId: {
      type: String,
    },
    indexedFaces: [{
      faceId: String,
      confidence: Number,
      boundingBox: {
        Width: Number,
        Height: Number,
        Left: Number,
        Top: Number,
      },
      externalImageId: String,
      imageId: String,
    }],
    uploadedBy: {
      type: String,
      enum: ['owner', 'guest'],
      default: 'owner',
    },
    uploaderName: {
      type: String,
    },
    metadata: {
      size: {
        type: Number,
        required: true,
      },
      mimeType: {
        type: String,
        required: true,
      },
      width: Number,
      height: Number,
    },
  },
  {
    timestamps: true,
  }
);

photoSchema.index({ eventId: 1 });
photoSchema.index({ eventId: 1, createdAt: -1 });
photoSchema.index({ faceId: 1 });
photoSchema.index({ 'indexedFaces.faceId': 1 });

export const Photo = mongoose.model<IPhoto>('Photo', photoSchema);
