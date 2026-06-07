import { Contact, IContact, ContactStatus } from './contact.model';
import { NotFoundError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

class ContactService {
  async create(data: {
    name: string;
    email: string;
    phone?: string;
    subject: string;
    message: string;
  }): Promise<IContact> {
    const contact = await Contact.create({
      name: data.name,
      email: data.email,
      phone: data.phone,
      subject: data.subject,
      message: data.message,
      status: 'new',
    });

    logger.info(`New contact submission from ${data.email}: ${data.subject}`);

    return contact;
  }

  async getAll(page: number = 1, limit: number = 20, status?: ContactStatus) {
    const skip = (page - 1) * limit;
    const query = status ? { status } : {};

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Contact.countDocuments(query),
    ]);

    return {
      contacts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getById(contactId: string): Promise<IContact> {
    const contact = await Contact.findById(contactId);
    if (!contact) {
      throw new NotFoundError('Contact');
    }
    return contact;
  }

  async updateStatus(contactId: string, status: ContactStatus): Promise<IContact> {
    const contact = await Contact.findByIdAndUpdate(
      contactId,
      { status },
      { new: true }
    );

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    logger.info(`Contact ${contactId} status updated to ${status}`);

    return contact;
  }

  async delete(contactId: string): Promise<void> {
    const contact = await Contact.findByIdAndDelete(contactId);
    if (!contact) {
      throw new NotFoundError('Contact');
    }

    logger.info(`Contact ${contactId} deleted`);
  }

  async getStats() {
    const [total, newCount, readCount, repliedCount] = await Promise.all([
      Contact.countDocuments(),
      Contact.countDocuments({ status: 'new' }),
      Contact.countDocuments({ status: 'read' }),
      Contact.countDocuments({ status: 'replied' }),
    ]);

    return {
      total,
      new: newCount,
      read: readCount,
      replied: repliedCount,
    };
  }
}

export const contactService = new ContactService();
