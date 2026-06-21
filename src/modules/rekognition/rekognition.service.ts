import { rekognition } from '@/shared/config/aws';
import { env } from '@/shared/config/env';
import logger from '@/shared/utils/logger';
import { AppError } from '@/shared/utils/errors';

const DEFAULT_MATCH_THRESHOLD = 80;
const DELETE_BATCH_SIZE = 100;

export interface BoundingBox {
  Width: number;
  Height: number;
  Left: number;
  Top: number;
}

export interface IndexedFace {
  faceId: string;
  imageId?: string;
  externalImageId?: string;
  confidence: number;
  boundingBox: BoundingBox;
}

export interface FaceMatchResult {
  faceId: string;
  similarity: number;
  confidence: number;
  externalImageId?: string;
  boundingBox?: Partial<BoundingBox>;
}

interface FaceMatch {
  faceId: string;
  similarity: number;
}

export interface FaceRecord {
  faceId: string;
  confidence: number;
  boundingBox: BoundingBox;
}

class RekognitionService {
  async createCollection(collectionId: string): Promise<void> {
    try {
      await rekognition.createCollection({ CollectionId: collectionId }).promise();
      logger.debug(`Rekognition collection created: ${collectionId}`);
    } catch (error: any) {
      if (error.code === 'ResourceAlreadyExistsException') {
        logger.warn(`Collection already exists: ${collectionId}`);
        return;
      }
      throw new AppError(`Failed to create Rekognition collection: ${error.message}`, 500);
    }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await rekognition.deleteCollection({ CollectionId: collectionId }).promise();
      logger.debug(`Rekognition collection deleted: ${collectionId}`);
    } catch (error: any) {
      if (error.code === 'ResourceNotFoundException') {
        logger.warn(`Collection not found: ${collectionId}`);
        return;
      }
      logger.error(`Failed to delete Rekognition collection: ${error.message}`);
    }
  }

  sanitizeExternalImageId(raw: string): string {
    return raw
      .replace(/\//g, '_')
      .replace(/\s/g, '_')
      .replace(/[()]/g, '')
      .replace(/[^a-zA-Z0-9_.\-:]/g, '_')
      .slice(0, 255);
  }

  async indexEventPhoto(params: {
    collectionId: string;
    s3Key: string;
    eventId?: string;
    photoId?: string;
  }): Promise<IndexedFace[]> {
    const { collectionId, s3Key, eventId, photoId } = params;
    try {
      const externalSource = [eventId, photoId].filter(Boolean).join(':') || s3Key;
      const externalImageId = this.sanitizeExternalImageId(externalSource);

      const result = await rekognition
        .indexFaces({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: env.S3_BUCKET_NAME, Name: s3Key } },
          ExternalImageId: externalImageId,
          MaxFaces: 100,
          QualityFilter: 'AUTO',
          DetectionAttributes: ['DEFAULT'],
        })
        .promise();

      const faces: IndexedFace[] = (result.FaceRecords || [])
        .map((record) => ({
          faceId: record.Face?.FaceId || '',
          imageId: record.Face?.ImageId,
          externalImageId: record.Face?.ExternalImageId,
          confidence: record.Face?.Confidence || 0,
          boundingBox: {
            Width: record.Face?.BoundingBox?.Width || 0,
            Height: record.Face?.BoundingBox?.Height || 0,
            Left: record.Face?.BoundingBox?.Left || 0,
            Top: record.Face?.BoundingBox?.Top || 0,
          },
        }))
        .filter((face) => face.faceId);

      const unindexed = (result.UnindexedFaces || []).length;
      logger.debug(
        `Indexed ${faces.length} face(s) from ${s3Key.split('/').pop()}${unindexed ? `, skipped ${unindexed} low-quality` : ''}`
      );

      return faces;
    } catch (error: any) {
      logger.error(`Failed to index faces for ${s3Key}: ${error.message}`);
      return [];
    }
  }

  async searchBySingleSelfie(params: {
    collectionId: string;
    s3Key: string;
    threshold?: number;
    maxFaces?: number;
  }): Promise<FaceMatchResult[]> {
    const { collectionId, s3Key, threshold = DEFAULT_MATCH_THRESHOLD, maxFaces = 4096 } = params;

    try {
      const result = await rekognition
        .searchFacesByImage({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: env.S3_BUCKET_NAME, Name: s3Key } },
          FaceMatchThreshold: threshold,
          MaxFaces: maxFaces,
          QualityFilter: 'AUTO',
        })
        .promise();

      const matches: FaceMatchResult[] = (result.FaceMatches || [])
        .map((m) => ({
          faceId: m.Face?.FaceId || '',
          similarity: m.Similarity || 0,
          confidence: m.Face?.Confidence || 0,
          externalImageId: m.Face?.ExternalImageId,
          boundingBox: m.Face?.BoundingBox,
        }))
        .filter((m) => m.faceId)
        .sort((a, b) => b.similarity - a.similarity);

      logger.debug(`Selfie search matched ${matches.length} face(s) (threshold ${threshold})`);
      return matches;
    } catch (error: any) {
      if (error.code === 'InvalidParameterException') {
        logger.warn(`No usable face found in selfie ${s3Key}`);
        return [];
      }
      logger.error(`Selfie search failed: ${error.message}`);
      throw new AppError(`Face search failed: ${error.message}`, 500);
    }
  }

  async searchByUploadedPhotoAllFaces(params: {
    collectionId: string;
    s3Key: string;
    threshold?: number;
    maxFaces?: number;
  }): Promise<FaceMatchResult[]> {
    const { collectionId, s3Key, threshold = DEFAULT_MATCH_THRESHOLD, maxFaces = 4096 } = params;
    let tempFaceIds: string[] = [];

    try {
      const indexResult = await rekognition
        .indexFaces({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: env.S3_BUCKET_NAME, Name: s3Key } },
          ExternalImageId: this.sanitizeExternalImageId(`search_${Date.now()}`),
          MaxFaces: 10,
          QualityFilter: 'AUTO',
          DetectionAttributes: ['DEFAULT'],
        })
        .promise()
        .catch((err: any) => {
          logger.error(`Failed to index uploaded search image: ${err.message}`);
          return null;
        });

      tempFaceIds = (indexResult?.FaceRecords || [])
        .map((r) => r.Face?.FaceId)
        .filter((id): id is string => !!id);

      if (tempFaceIds.length === 0) {
        logger.warn(`No faces detected in uploaded search image ${s3Key}`);
        return [];
      }

      const tempIdSet = new Set(tempFaceIds);
      const best = new Map<string, FaceMatchResult>();

      for (const tempId of tempFaceIds) {
        try {
          const result = await rekognition
            .searchFaces({
              CollectionId: collectionId,
              FaceId: tempId,
              FaceMatchThreshold: threshold,
              MaxFaces: maxFaces,
            })
            .promise();

          for (const m of result.FaceMatches || []) {
            const fid = m.Face?.FaceId;
            if (!fid || tempIdSet.has(fid)) continue;
            const similarity = m.Similarity || 0;
            const existing = best.get(fid);
            if (!existing || similarity > existing.similarity) {
              best.set(fid, {
                faceId: fid,
                similarity,
                confidence: m.Face?.Confidence || 0,
                externalImageId: m.Face?.ExternalImageId,
                boundingBox: m.Face?.BoundingBox,
              });
            }
          }
        } catch (err: any) {
          logger.error(`searchFaces failed for temp face ${tempId}: ${err.message}`);
        }
      }

      const matches = Array.from(best.values()).sort((a, b) => b.similarity - a.similarity);
      logger.debug(
        `Group search: ${tempFaceIds.length} uploaded face(s) → ${matches.length} unique match(es) (threshold ${threshold})`
      );
      return matches;
    } catch (error: any) {
      logger.error(`Group photo search failed: ${error.message}`);
      throw new AppError(`Face search failed: ${error.message}`, 500);
    } finally {
      if (tempFaceIds.length > 0) {
        await this.deleteFaces(collectionId, tempFaceIds).catch((err: any) =>
          logger.error(`Failed to clean up ${tempFaceIds.length} temporary search face(s): ${err.message}`)
        );
      }
    }
  }

  async listCollectionFaces(collectionId: string): Promise<string[]> {
    const faceIds: string[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const result = await rekognition
          .listFaces({
            CollectionId: collectionId,
            MaxResults: 4096,
            NextToken: nextToken,
          })
          .promise();

        for (const face of result.Faces || []) {
          if (face.FaceId) faceIds.push(face.FaceId);
        }

        nextToken = result.NextToken;
      } while (nextToken);

      return faceIds;
    } catch (error: any) {
      logger.error(`Failed to list faces: ${error.message}`);
      return faceIds;
    }
  }

  async deleteFaces(collectionId: string, faceIds: string[]): Promise<void> {
    if (!faceIds || faceIds.length === 0) return;

    for (let i = 0; i < faceIds.length; i += DELETE_BATCH_SIZE) {
      const batch = faceIds.slice(i, i + DELETE_BATCH_SIZE);
      try {
        await rekognition.deleteFaces({ CollectionId: collectionId, FaceIds: batch }).promise();
      } catch (error: any) {
        logger.error(`Failed to delete faces batch: ${error.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Backward-compatible wrappers (existing callers).
  // ---------------------------------------------------------------------------

  async indexFace(s3Key: string, collectionId: string): Promise<FaceRecord[]> {
    const faces = await this.indexEventPhoto({ collectionId, s3Key });
    return faces.map((f) => ({
      faceId: f.faceId,
      confidence: f.confidence,
      boundingBox: f.boundingBox,
    }));
  }

  async searchFaces(s3Key: string, collectionId: string): Promise<FaceMatch[]> {
    const matches = await this.searchByUploadedPhotoAllFaces({ collectionId, s3Key });
    return matches.map((m) => ({ faceId: m.faceId, similarity: m.similarity }));
  }
}

export const rekognitionService = new RekognitionService();
