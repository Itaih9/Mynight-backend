import { Router } from 'express';
import { packagesController } from './packages.controller';
import { adminProtect } from '../admin/admin.middleware';

const router = Router();

router.get('/', packagesController.getPublic);

router.get('/admin', adminProtect, packagesController.getAllAdmin);
router.patch('/admin/:key', adminProtect, packagesController.update);

export default router;
