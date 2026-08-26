import { Request, Response, NextFunction } from 'express';
import { adminService } from './admin.service';
import { AdminRequest } from './admin.middleware';
import { eventsService } from '../events/events.service';
import { affiliateService } from '../affiliate/affiliate.service';

export class AdminController {
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, deviceToken } = req.body;
      // req.ip is the real client address: Express sits behind exactly one
      // proxy (`trust proxy: 1`) and nginx appends the peer to X-Forwarded-For,
      // so a client-supplied header cannot become req.ip.
      const result = await adminService.login(email, password, {
        deviceToken,
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
      });

      if (!result.requiresOtp) {
        res.json({
          success: true,
          data: { requiresOtp: false, token: result.token, admin: result.admin },
          message: 'Signed in from a trusted device',
        });
        return;
      }

      res.json({
        success: true,
        data: { email: result.email, requiresOtp: true, emailDelivered: result.emailDelivered },
        message: result.emailDelivered
          ? 'OTP sent to your email'
          : 'Code generated, but it could not be emailed — check the mail provider',
      });
    } catch (error) {
      next(error);
    }
  }

  async verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, otp } = req.body;
      const result = await adminService.verifyOtp(email, otp, {
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
      });
      res.json({
        success: true,
        data: {
          admin: {
            id: result.admin._id,
            email: result.admin.email,
            name: result.admin.name,
          },
          token: result.token,
          // Kept by the browser and sent on the next sign-in: with the same IP
          // and inside the window, the password alone gets in.
          deviceToken: result.deviceToken,
          trustedUntil: result.trustedUntil,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { currentPassword, newPassword } = req.body;
      const adminId = (req as any).adminId as string;
      await adminService.changePassword(adminId, currentPassword, newPassword);
      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }

  async listAdmins(_req: Request, res: Response, next: NextFunction) {
    try {
      const admins = await adminService.listAdmins();
      res.json({ success: true, data: admins });
    } catch (error) {
      next(error);
    }
  }

  async createAdmin(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, name } = req.body;
      const admin = await adminService.createAdmin({ email, password, name });
      res.status(201).json({ success: true, data: admin });
    } catch (error) {
      next(error);
    }
  }

  async setAdminActive(req: Request, res: Response, next: NextFunction) {
    try {
      const { adminId } = req.params;
      const { isActive } = req.body;
      const actingAdminId = (req as any).adminId as string;
      const admin = await adminService.setAdminActive(adminId, !!isActive, actingAdminId);
      res.json({ success: true, data: admin });
    } catch (error) {
      next(error);
    }
  }

  async deleteAdmin(req: Request, res: Response, next: NextFunction) {
    try {
      const { adminId } = req.params;
      const actingAdminId = (req as any).adminId as string;
      const result = await adminService.deleteAdmin(adminId, actingAdminId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async resetUserPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;
      await adminService.resetUserPassword(userId, newPassword);
      res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }

  async getDashboard(_req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await adminService.getDashboardStats();
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await adminService.getUsers(page, limit);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await adminService.getEvents(page, limit);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getCoupons(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const filterParam = req.query.filter as string;
      const filter = (['mine', 'auto', 'all'].includes(filterParam) ? filterParam : 'mine') as 'mine' | 'auto' | 'all';
      const result = await adminService.getCoupons(page, limit, filter);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async createCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, discountPercent, discountAmount, maxUses, expiresAt, affiliateId, ownerEventId, packageName } = req.body;
      const coupon = await adminService.createCoupon({
        code,
        discountPercent,
        discountAmount,
        maxUses,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        affiliateId,
        ownerEventId,
        packageName,
      });
      res.status(201).json({
        success: true,
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const { couponId } = req.params;
      const result = await adminService.deleteCoupon(couponId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const { couponId } = req.params;
      const { discountType, discountValue, maxUses, isActive } = req.body;
      const coupon = await adminService.updateCoupon(couponId, { discountType, discountValue, maxUses, isActive });
      res.json({ success: true, data: coupon });
    } catch (error) {
      next(error);
    }
  }

  async getCouponDefaults(_req: Request, res: Response, next: NextFunction) {
    try {
      const defaults = await adminService.getCouponDefaults();
      res.json({ success: true, data: defaults });
    } catch (error) {
      next(error);
    }
  }

  async updateCouponDefaults(req: Request, res: Response, next: NextFunction) {
    try {
      const { discountType, discountValue, maxUses } = req.body;
      const defaults = await adminService.updateCouponDefaults({ discountType, discountValue, maxUses });
      res.json({ success: true, data: defaults });
    } catch (error) {
      next(error);
    }
  }

  async applyCouponDefaults(_req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.applyCouponDefaultsToExisting();
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getReferrals(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await adminService.getReferrals(page, limit);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getAffiliates(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await adminService.getAffiliates(page, limit);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateAffiliateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const { status } = req.body;
      const affiliate = await adminService.updateAffiliateStatus(affiliateId, status);
      res.json({
        success: true,
        data: affiliate,
      });
    } catch (error) {
      next(error);
    }
  }

  async extendEventUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { days } = req.body;
      const result = await adminService.extendEventUpload(eventId, days || 30);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateEventSlug(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { customSlug, resetCount } = req.body;
      const result = await adminService.updateEventSlug(eventId, customSlug, !!resetCount);
      res.json({
        success: true,
        data: result,
        message: 'Slug updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async updateEventDisposable(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { enabled, shotLimit } = req.body;
      const result = await adminService.updateEventDisposable(eventId, { enabled, shotLimit });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async updateEventPhotographer(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { photographerName, photographerInstagram } = req.body;
      const result = await adminService.updateEventPhotographer(eventId, {
        photographerName,
        photographerInstagram,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async downloadGuestList(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const result = await adminService.getGuestListDownloadUrl(eventId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getGuestListData(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const result = await adminService.getGuestListData(eventId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      await eventsService.adminDeleteEvent(eventId);
      res.json({
        success: true,
        message: 'Event deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a free פלאש event from the admin API. When the caller is the service
   * token, the event is stamped createdByService so the token can later delete
   * it — the only events the token is ever allowed to delete.
   */
  async createFlashEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const { coupleName, phoneNumber, email, weddingDate } = req.body;
      if (!coupleName || !phoneNumber || !weddingDate) {
        res.status(400).json({
          success: false,
          message: 'coupleName, phoneNumber and weddingDate are required',
        });
        return;
      }
      const result = await eventsService.registerFreeFlash(
        { coupleName, phoneNumber, email, weddingDate: new Date(weddingDate) },
        { createdByService: !!(req as AdminRequest).isServiceToken }
      );
      res.status(result.isNew ? 201 : 200).json({
        success: true,
        data: {
          eventCode: result.event.eventCode,
          isNew: result.isNew,
          createdByService: result.event.createdByService,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manual event creation from the admin dashboard — for a couple who booked off
   * the platform and never registered. Mirrors the self-serve flow (account,
   * face collection, coupons) so the gallery works the moment it exists.
   */
  async createEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        partnerName1,
        partnerName2,
        partnerName1En,
        partnerName2En,
        phoneNumber,
        email,
        weddingDate,
        packageName,
        isPaid,
        flashTier,
        customSlug,
        photographerName,
        photographerInstagram,
        disposableEnabled,
        sendWelcomeEmail,
      } = req.body || {};

      const { event, userCreated, phoneNumber: storedPhone, emailSent } = await eventsService.adminCreateEvent(
        {
          partnerName1,
          partnerName2,
          partnerName1En,
          partnerName2En,
          phoneNumber,
          email,
          weddingDate,
          packageName,
          isPaid,
          flashTier,
          customSlug,
          photographerName,
          photographerInstagram,
          disposableEnabled,
          sendWelcomeEmail,
        },
        { createdByService: !!(req as AdminRequest).isServiceToken }
      );

      res.status(201).json({
        success: true,
        data: {
          _id: event._id,
          name: event.name,
          eventCode: event.eventCode,
          customSlug: event.customSlug,
          weddingDate: event.weddingDate,
          isPaid: event.isPaid,
          flashTier: event.flashTier,
          packageName: event.packageName,
          photographerName: event.photographerName,
          photographerInstagram: event.photographerInstagram,
          disposableEnabled: event.disposableEnabled,
          expiresAt: event.expiresAt,
          userCreated,
          // The number the couple actually logs in with, normalised — not the
          // shape the admin typed — and whether mail really went out.
          phoneNumber: storedPhone,
          emailSent,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async updateEventStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { isPaid, flashTier } = req.body || {};
      const result = await adminService.updateEventStatus(req.params.eventId, { isPaid, flashTier });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getPendingCounts(_req: Request, res: Response, next: NextFunction) {
    try {
      const counts = await adminService.getPendingCounts();
      res.json({ success: true, data: counts });
    } catch (error) {
      next(error);
    }
  }

  async listWithdrawals(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as 'pending' | 'paid' | 'rejected' | undefined;
      const withdrawals = await affiliateService.listAllWithdrawals(status ? { status } : undefined);
      res.json({ success: true, data: withdrawals });
    } catch (error) {
      next(error);
    }
  }

  async markWithdrawalPaid(req: Request, res: Response, next: NextFunction) {
    try {
      const { withdrawalId } = req.params;
      const { adminNote } = req.body || {};
      const withdrawal = await affiliateService.markWithdrawalPaid(withdrawalId, adminNote);
      res.json({ success: true, data: withdrawal, message: 'Withdrawal marked paid' });
    } catch (error) {
      next(error);
    }
  }

  async payoutAffiliate(req: Request, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const { amount, adminNote } = req.body || {};
      const withdrawal = await affiliateService.adminPayoutAffiliate(affiliateId, Number(amount), adminNote);
      res.json({ success: true, data: withdrawal, message: 'Payout recorded' });
    } catch (error) {
      next(error);
    }
  }

  async topUpPrepaid(req: Request, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const { events, adminNote } = req.body || {};
      const affiliate = await affiliateService.topUpPrepaid(affiliateId, Number(events), adminNote);
      res.json({
        success: true,
        data: {
          prepaidBalance: affiliate.prepaidBalance,
          prepaidUsed: affiliate.prepaidUsed,
          prepaidCouponCode: affiliate.prepaidCouponCode,
        },
        message: 'Prepaid balance topped up',
      });
    } catch (error) {
      next(error);
    }
  }

  async getPrepaidSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const { affiliateId } = req.params;
      const summary = await affiliateService.getPrepaidSummary(affiliateId);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  async rejectWithdrawal(req: Request, res: Response, next: NextFunction) {
    try {
      const { withdrawalId } = req.params;
      const { adminNote } = req.body || {};
      const withdrawal = await affiliateService.rejectWithdrawal(withdrawalId, adminNote);
      res.json({ success: true, data: withdrawal, message: 'Withdrawal rejected' });
    } catch (error) {
      next(error);
    }
  }

  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      await adminService.deleteUser(userId);
      res.json({
        success: true,
        message: 'User deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async uploadCoverImage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { eventId } = req.params;
      const file = req.file;

      if (!file) {
        res.status(400).json({ success: false, error: 'No file uploaded' });
        return;
      }

      const coverImage = await adminService.uploadCoverImage(eventId, file);
      res.status(201).json({ success: true, data: coverImage });
    } catch (error) {
      next(error);
    }
  }

  async deleteCoverImage(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const result = await adminService.deleteCoverImage(eventId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async uploadPhotosToEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { eventId } = req.params;
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No files uploaded',
        });
        return;
      }

      const photos = await adminService.uploadPhotosToEvent(eventId, files);
      res.status(201).json({
        success: true,
        data: {
          uploaded: photos.length,
          photos,
        },
        message: `${photos.length} photos uploaded successfully`,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEventPhotos(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const result = await adminService.getEventPhotos(eventId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteEventPhoto(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId, photoId } = req.params;
      const result = await adminService.deleteEventPhoto(eventId, photoId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteEventPhotosBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { photoIds } = req.body;
      const result = await adminService.deleteEventPhotosBulk(eventId, photoIds);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getBatchPresignedUrls(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { files } = req.body;
      const result = await adminService.getBatchPresignedUrls(eventId, files);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async batchCompleteUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { uploads } = req.body;
      const result = await adminService.batchCompleteUpload(eventId, uploads);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async initiateZipMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { fileName, fileSize } = req.body;
      const result = await adminService.initiateZipMultipart(eventId, fileName, fileSize);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getZipPartPresignedUrls(req: Request, res: Response, next: NextFunction) {
    try {
      const { s3Key, uploadId, partNumbers } = req.body;
      const result = await adminService.getZipPartPresignedUrls(s3Key, uploadId, partNumbers);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async completeZipMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { s3Key, uploadId, parts } = req.body;
      const result = await adminService.completeZipMultipart(s3Key, uploadId, parts);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async abortZipMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { s3Key, uploadId } = req.body;
      const result = await adminService.abortZipMultipart(s3Key, uploadId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getZipPresignedUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { fileName, fileSize } = req.body;
      const result = await adminService.getZipPresignedUrl(eventId, fileName, fileSize);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async processZip(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId } = req.params;
      const { s3Key } = req.body;
      const result = await adminService.startZipProcessing(eventId, s3Key);
      res.status(202).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getZipJobStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { eventId, jobId } = req.params;
      const result = await adminService.getZipJobStatus(eventId, jobId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

}

export const adminController = new AdminController();
