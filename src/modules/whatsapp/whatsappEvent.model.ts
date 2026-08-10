import mongoose, { Document, Schema } from 'mongoose';
import { WhatsAppDeliveryStatus } from '../emailCampaign/emailCampaign.model';

/**
 * Everything Wati tells us about a message, campaign-related or not.
 *
 * The campaign send log answers "did this couple get the upsell"; this answers
 * "is WhatsApp working at all" — OTP codes, replies from numbers we never
 * messaged, failures on templates Meta has since disabled. That traffic has
 * nowhere else to land, and without it a silent Wati outage looks exactly like
 * a quiet week.
 *
 * Rows expire after 90 days: it's a diagnostic feed, not an archive, and the
 * numbers that matter are already counted on the send log.
 */
export interface IWhatsAppEvent extends Document {
  phone: string;
  /** Wati's own label, kept verbatim — their vocabulary changes without notice. */
  eventType: string;
  status?: WhatsAppDeliveryStatus;
  messageId?: string;
  /** Reply text, clipped. Inbound only. */
  text?: string;
  campaignId?: mongoose.Types.ObjectId;
  eventId?: mongoose.Types.ObjectId;
  matched: boolean;
  occurredAt: Date;
  receivedAt: Date;
}

const whatsAppEventSchema = new Schema<IWhatsAppEvent>({
  phone: { type: String, index: true },
  eventType: { type: String, default: '' },
  status: { type: String, enum: ['sent', 'delivered', 'read', 'replied', 'failed'] },
  messageId: { type: String },
  text: { type: String },
  campaignId: { type: Schema.Types.ObjectId, ref: 'EmailCampaign' },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
  matched: { type: Boolean, default: false },
  occurredAt: { type: Date, default: Date.now },
  receivedAt: { type: Date, default: Date.now },
});

whatsAppEventSchema.index({ receivedAt: -1 });
whatsAppEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const WhatsAppEvent = mongoose.model<IWhatsAppEvent>('WhatsAppEvent', whatsAppEventSchema);
