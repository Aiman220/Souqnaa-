import { Router } from 'express';
import { CustomerActionCenterController } from './customer-action-center.controller';
import { AdminActionCenterController } from './admin-action-center.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';

const customerRouter = Router();
customerRouter.use(authenticate);

customerRouter.get('/', CustomerActionCenterController.getActionCenter);
customerRouter.post('/:id/dismiss', CustomerActionCenterController.dismissAction);
customerRouter.post('/:id/snooze', CustomerActionCenterController.snoozeAction);
customerRouter.post('/:id/claim', CustomerActionCenterController.claimAction);

const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/announcements', AdminActionCenterController.getAnnouncements);
adminRouter.post('/announcements', AdminActionCenterController.createAnnouncement);
adminRouter.put('/announcements/:id', AdminActionCenterController.updateAnnouncement);
adminRouter.delete('/announcements/:id', AdminActionCenterController.deleteAnnouncement);
adminRouter.get('/analytics', AdminActionCenterController.getAnalytics);

export const customerActionCenterRoutes = customerRouter;
export const adminActionCenterRoutes = adminRouter;
