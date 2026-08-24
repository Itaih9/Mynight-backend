import { Package, IPackage } from './packages.model';
import { NotFoundError, ValidationError } from '@/shared/utils/errors';
import { packageKeyForTitle } from '@/shared/config/packageFeatures';
import logger from '@/shared/utils/logger';

const DEFAULT_PACKAGES = [
  { key: 'morning_after', title: 'האוספת', englishTitle: 'The Morning After', price: 350, order: 0 },
  { key: 'unlimited', title: 'המושלמת', englishTitle: 'UNLIMITED', price: 590, order: 1 },
  { key: 'here_i_am', title: 'החכמה', englishTitle: 'Here I Am', price: 450, order: 2 },
];

class PackagesService {
  /**
   * Any way of naming a package — its key, its Hebrew title, its English title —
   * reduced to the stable key.
   *
   * Everything that used to compare titles goes through here, because a title is
   * editable from the Packages screen and a key is not. The historical-title map
   * is the last resort, so a reference written down before a rename still
   * resolves to the package it meant.
   */
  async resolveKey(input?: string | null): Promise<string | undefined> {
    return (await this.resolveRef(input)).key;
  }

  /**
   * As resolveKey, but also returns the package's CURRENT display title — for
   * anything that stores a name to show back to a human, so what is displayed
   * stays in step with the Packages screen instead of freezing at whatever the
   * caller happened to type.
   */
  async resolveRef(input?: string | null): Promise<{ key?: string; title?: string }> {
    const value = typeof input === 'string' ? input.trim() : '';
    if (!value) return {};

    const pkg = await Package.findOne({
      $or: [{ key: value }, { title: value }, { englishTitle: value }],
    })
      .select('key title')
      .lean();

    if (pkg?.key) return { key: pkg.key, title: pkg.title };

    // Renamed away, or a package that no longer exists: keep the historical key
    // so restrictions still resolve, and leave the title as the caller gave it.
    const legacyKey = packageKeyForTitle(value);
    return legacyKey ? { key: legacyKey, title: value } : {};
  }

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

  async update(key: string, data: Partial<Pick<IPackage, 'title' | 'englishTitle' | 'price' | 'order' | 'isActive' | 'compareAtPrice'>>): Promise<IPackage> {
    if (data.price !== undefined && (typeof data.price !== 'number' || data.price < 0)) {
      throw new ValidationError('Price must be a positive number');
    }
    if (data.compareAtPrice !== undefined && (typeof data.compareAtPrice !== 'number' || data.compareAtPrice < 0)) {
      throw new ValidationError('Compare-at price must be a positive number');
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
