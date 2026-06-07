import { Review, IReview, ReviewStatus } from './review.model';
import { User } from '../auth/user.model';
import { Event } from '../events/events.model';
import { NotFoundError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

class ReviewService {
  async create(data: {
    rating: number;
    text: string;
    userId?: string;
    name?: string;
  }): Promise<IReview> {
    const review = await Review.create({
      rating: data.rating,
      text: data.text,
      userId: data.userId,
      name: data.name,
      status: 'pending',
    });

    logger.info(`New review submitted (rating: ${data.rating})`);

    return review;
  }

  async getApproved() {
    return Review.find({ status: 'approved' })
      .sort({ createdAt: -1 })
      .lean();
  }

  async getAll(page: number = 1, limit: number = 20, status?: ReviewStatus) {
    const skip = (page - 1) * limit;
    const query = status ? { status } : {};

    const [reviews, total] = await Promise.all([
      Review.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Review.countDocuments(query),
    ]);

    const userIds = Array.from(new Set(reviews.map((r) => r.userId).filter(Boolean) as any[]));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id partnerName1 partnerName2').lean()
      : [];
    const userMap = new Map(users.map((u: any) => [String(u._id), u]));

    const events = userIds.length
      ? await Event.find({ userId: { $in: userIds } }).select('userId name eventCode customSlug').lean()
      : [];
    const eventMap = new Map(events.map((e: any) => [String(e.userId), e]));

    const enriched = reviews.map((r) => {
      const uid = r.userId ? String(r.userId) : '';
      const u = uid ? userMap.get(uid) : null;
      const e = uid ? eventMap.get(uid) : null;
      const coupleName = u
        ? [(u as any).partnerName1, (u as any).partnerName2].filter(Boolean).join(' & ')
        : '';
      return {
        ...r,
        coupleName: coupleName || undefined,
        eventName: (e as any)?.name || undefined,
        eventCode: (e as any)?.eventCode || undefined,
        eventSlug: (e as any)?.customSlug || undefined,
      };
    });

    return {
      reviews: enriched,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async updateStatus(reviewId: string, status: ReviewStatus): Promise<IReview> {
    const review = await Review.findByIdAndUpdate(
      reviewId,
      { status },
      { new: true }
    );

    if (!review) {
      throw new NotFoundError('Review');
    }

    logger.info(`Review ${reviewId} status updated to ${status}`);

    return review;
  }
}

export const reviewService = new ReviewService();
