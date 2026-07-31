import mongoose, { Document, Schema } from 'mongoose';

/**
 * An admin-editable promotional email.
 *
 * Replaces the hardcoded upsell stages: audience, timing and copy all live here
 * so marketing can be changed without a deploy. Copy is authored as structured
 * blocks rather than raw HTML, so every send inherits the branded RTL layout and
 * a bad tag can't break rendering in Outlook.
 */
export type CampaignAudience = 'flash_free_unpaid' | 'paid' | 'all_couples' | 'manual';
export type CampaignTriggerType = 'before_wedding' | 'after_signup' | 'fixed_date';

export interface ICampaignBlocks {
  title?: string;
  paragraphs: string[];
  bullets?: string[];
  ctaText?: string;
  ctaUrl?: string;
  footnote?: string;
}

export interface IEmailCampaign extends Document {
  name: string;
  audience: CampaignAudience;
  /** Hand-picked events. The whole audience when `audience` is 'manual'. */
  recipientEventIds: mongoose.Types.ObjectId[];
  /** Always removed from the audience, whichever preset is in use. */
  excludeEventIds: mongoose.Types.ObjectId[];
  filters: {
    minDaysToWedding?: number;
    maxDaysToWedding?: number;
    requireEmail: boolean;
  };
  trigger: {
    type: CampaignTriggerType;
    /** days before the wedding, or days after signup */
    days?: number;
    /** absolute send date, for type 'fixed_date' */
    date?: Date;
  };
  subject: string;
  blocks: ICampaignBlocks;
  isActive: boolean;
  sentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const emailCampaignSchema = new Schema<IEmailCampaign>(
  {
    name: { type: String, required: true, trim: true },
    audience: {
      type: String,
      enum: ['flash_free_unpaid', 'paid', 'all_couples', 'manual'],
      default: 'flash_free_unpaid',
    },
    recipientEventIds: [{ type: Schema.Types.ObjectId, ref: 'Event' }],
    excludeEventIds: [{ type: Schema.Types.ObjectId, ref: 'Event' }],
    filters: {
      minDaysToWedding: { type: Number },
      maxDaysToWedding: { type: Number },
      requireEmail: { type: Boolean, default: true },
    },
    trigger: {
      type: {
        type: String,
        enum: ['before_wedding', 'after_signup', 'fixed_date'],
        default: 'before_wedding',
      },
      days: { type: Number },
      date: { type: Date },
    },
    subject: { type: String, required: true, trim: true },
    blocks: {
      title: { type: String },
      paragraphs: { type: [String], default: [] },
      bullets: { type: [String], default: [] },
      ctaText: { type: String },
      ctaUrl: { type: String },
      footnote: { type: String },
    },
    isActive: { type: Boolean, default: true },
    sentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const EmailCampaign = mongoose.model<IEmailCampaign>('EmailCampaign', emailCampaignSchema);

/**
 * One row per (campaign, event) actually sent. This is what makes the engine
 * idempotent — a restart, an overlapping run or a re-run can never mail the same
 * couple twice for the same campaign — and it doubles as the audit trail of who
 * received what.
 */
export interface IEmailSendLog extends Document {
  campaignId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  email: string;
  sentAt: Date;
}

const emailSendLogSchema = new Schema<IEmailSendLog>({
  campaignId: { type: Schema.Types.ObjectId, ref: 'EmailCampaign', required: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  email: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

emailSendLogSchema.index({ campaignId: 1, eventId: 1 }, { unique: true });
emailSendLogSchema.index({ sentAt: -1 });

export const EmailSendLog = mongoose.model<IEmailSendLog>('EmailSendLog', emailSendLogSchema);
