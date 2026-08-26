import mongoose, { Document, Schema } from 'mongoose';

/**
 * A browser an admin has already proved themselves on, so the emailed code can
 * be skipped for a while.
 *
 * Trust is (device token AND ip), never IP alone. An office, a hotel or a
 * carrier NAT puts strangers on the same address, and an admin password is the
 * only thing standing between them and every couple's photos — the code exists
 * precisely so a leaked password is not enough. Requiring the token as well
 * means an attacker who knows the password AND shares the network still gets
 * the code prompt.
 *
 * The password is still required every time. This removes the second factor for
 * a known browser on a known network, not the first.
 *
 * `token` itself is never stored: only its SHA-256, for the same reason a
 * password is not stored. A dump of this collection grants nothing.
 */
export interface IAdminTrustedDevice extends Document {
  adminId: mongoose.Types.ObjectId;
  tokenHash: string;
  ip: string;
  userAgent?: string;
  lastUsedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const adminTrustedDeviceSchema = new Schema<IAdminTrustedDevice>(
  {
    adminId: { type: Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    ip: { type: String, required: true },
    userAgent: { type: String },
    lastUsedAt: { type: Date, default: Date.now },
    // Absolute, not sliding: the window is 48 hours from the code being
    // entered, so a stolen token cannot be renewed indefinitely by using it.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Mongo removes the record itself the moment it expires, so an expired trust
// cannot linger and be honoured by a bug in the read path.
adminTrustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminTrustedDevice = mongoose.model<IAdminTrustedDevice>(
  'AdminTrustedDevice',
  adminTrustedDeviceSchema
);
