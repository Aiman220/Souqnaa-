import { Router } from 'express';
import { AdminMembershipController } from './admin-membership.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';

export const adminMembershipRoutes = Router();

// Apply auth and requireAdmin to all admin membership routes
adminMembershipRoutes.use(authenticate, requireAdmin);

// Tiers CRUD
adminMembershipRoutes.get('/tiers', AdminMembershipController.listTiers);
adminMembershipRoutes.post('/tiers', AdminMembershipController.createTier);
adminMembershipRoutes.put('/tiers/:id', AdminMembershipController.updateTier);
adminMembershipRoutes.delete('/tiers/:id', AdminMembershipController.deleteTier);

// Customer Membership Management & Search
adminMembershipRoutes.get('/customers', AdminMembershipController.listCustomers);
adminMembershipRoutes.post('/customers/:userId/override', AdminMembershipController.applyOverride);
adminMembershipRoutes.delete('/customers/:userId/override', AdminMembershipController.removeOverride);
adminMembershipRoutes.post('/customers/:userId/evaluate', AdminMembershipController.evaluateCustomer);
adminMembershipRoutes.post('/customers/:userId/suspend', AdminMembershipController.suspendCustomer);
adminMembershipRoutes.post('/customers/:userId/restore', AdminMembershipController.restoreCustomer);

// Analytics & Audit Logs
adminMembershipRoutes.get('/analytics', AdminMembershipController.getAnalytics);
adminMembershipRoutes.get('/audit-logs', AdminMembershipController.listAuditLogs);
