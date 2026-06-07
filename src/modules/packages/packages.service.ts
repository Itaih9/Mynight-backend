import { Package, IPackage } from './packages.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import logger from '@/shared/utils/logger';

const DEFAULT_PACKAGES = [
  { key: 'morning_after', title: 'האוספת', englishTitle: 'The Morning After', price: 350, order: 0 },
  { key: 'unlimited', title: 'המושלמת', englishTitle: 'UNLIMITED', price: 590, order: 1 },
  { key: 'here_i_am', title: 'החכמה', englishTitle: 'Here I Am', price: 450, order: 2 },
];

class PackagesService {
  async seedDefaults(): Promise<void> {
    for (const pkg of DEFAULT_PACKAGES) {
      const exists = await Package.findOne({ key: pkg.key });
      if (!exists) {
        await Package.create(pkg);
        logger.info(`Seeded default package: ${pkg.key}`);
      }
    }
  }

  async getAll(): Promise<any[]> {
    return Package.find({ isActive: true }).sort({ order: 1 }).lean();
  }

  async getAllForAdmin(): Promise<any[]> {
    return Package.find().sort({ order: 1 }).lean();
  }

  async update(key: string, data: Partial<Pick<IPackage, 'title' | 'englishTitle' | 'price' | 'order' | 'isActive'>>): Promise<IPackage> {
    if (data.price !== undefined && (typeof data.price !== 'number' || data.price < 0)) {
      throw new ValidationError('Price must be a positive number');
    }
    if (data.title !== undefined && !data.title.trim()) {
      throw new ValidationError('Title is required');
    }
    if (data.englishTitle !== undefined && !data.englishTitle.trim()) {
      throw new ValidationError('English title is required');
    }

    const pkg = await Package.findOneAndUpdate({ key }, data, { new: true });
    if (!pkg) throw new NotFoundError('Package');

    logger.info(`Package updated: ${key}`);
    return pkg;
  }
}

export const packagesService = new PackagesService();
