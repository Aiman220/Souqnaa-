import { Router } from 'express';
import { CustomerMembershipController } from './customer-membership.controller';
import { authenticate } from '../../middleware/auth.middleware';

export const customerMembershipRoutes = Router();

// Publicly viewable tiers catalogue
customerMembershipRoutes.get('/tiers', CustomerMembershipController.getTiersCatalogue);

// Protected customer endpoints
customerMembershipRoutes.get('/me', authenticate, CustomerMembershipController.getMyMembership);
customerMembershipRoutes.get('/me/progress', authenticate, CustomerMembershipController.getMyProgress);
customerMembershipRoutes.get('/me/benefits', authenticate, CustomerMembershipController.getMyBenefits);
customerMembershipRoutes.get('/', authenticate, CustomerMembershipController.getMyMembership);
