import { Router } from 'express';
import { adminRecommendationController } from '../controllers/admin-recommendation.controller';
import { authenticate, authorize } from '../../../middleware/auth.middleware';

export const adminRecommendationRoutes = Router();

// Protect admin recommendation endpoints
adminRecommendationRoutes.use(authenticate, authorize('ADMIN'));

// GET /admin/recommendations/analytics (§71)
adminRecommendationRoutes.get('/analytics', (req, res) =>
  adminRecommendationController.getAnalytics(req, res)
);

// GET /admin/recommendations/config (§72)
adminRecommendationRoutes.get('/config', (req, res) =>
  adminRecommendationController.getConfig(req, res)
);

// PUT /admin/recommendations/config (§72)
adminRecommendationRoutes.put('/config', (req, res) =>
  adminRecommendationController.updateConfig(req, res)
);

// POST /admin/recommendations/train (§20)
adminRecommendationRoutes.post('/train', (req, res) =>
  adminRecommendationController.triggerTraining(req, res)
);

// POST /admin/recommendations/rollback (§21)
adminRecommendationRoutes.post('/rollback', (req, res) =>
  adminRecommendationController.rollbackModel(req, res)
);
