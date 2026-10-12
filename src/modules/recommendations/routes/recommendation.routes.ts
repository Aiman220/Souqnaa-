import { Router } from 'express';
import { recommendationController } from '../controllers/recommendation.controller';
import { authenticate, optionalAuth } from '../../../middleware/auth.middleware';
import { requireFeature } from '../../remote-config/remote-config.middleware';

export const recommendationRoutes = Router();
recommendationRoutes.use(requireFeature('recommendations', 'محرك الترشيحات والتوصيات معطل حالياً.'));

// GET /recommendations/home (§28)
recommendationRoutes.get('/home', optionalAuth, (req, res) =>
  recommendationController.getHomeRecommendations(req, res)
);

// GET /recommendations/products/:id (§29)
recommendationRoutes.get('/products/:id', optionalAuth, (req, res) =>
  recommendationController.getProductRecommendations(req, res)
);

// GET /recommendations/users/me (§30)
recommendationRoutes.get('/users/me', authenticate, (req, res) =>
  recommendationController.getUserRecommendations(req, res)
);

// POST /recommendations/events (§31)
recommendationRoutes.post('/events', optionalAuth, (req, res) =>
  recommendationController.trackEvents(req, res)
);
