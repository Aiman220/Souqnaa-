import { Request, Response } from 'express';
import { recommendationService } from '../services/recommendation.service';
import { eventCollectorService } from '../services/event-collector.service';
import { RecommendationContext, EventIngestionDto } from '../types/recommendation.types';

export class RecommendationController {
  /**
   * GET /recommendations/home
   */
  async getHomeRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id || (req.query.userId as string);
      const sessionId =
        (req.headers['x-session-id'] as string) ||
        (req.query.sessionId as string) ||
        'anonymous_session';

      const limit = parseInt((req.query.limit as string) || '10', 10);
      const cursor = (req.query.cursor as string) || undefined;

      let recentViewedIds: string[] = [];
      if (req.query.recentViewedIds) {
        try {
          recentViewedIds = JSON.parse(req.query.recentViewedIds as string);
        } catch (_) {
          recentViewedIds = (req.query.recentViewedIds as string).split(',');
        }
      }

      const context: RecommendationContext = {
        userId,
        sessionId,
        recentViewedIds,
        limit,
        cursor,
        platform: (req.headers['x-platform'] as string) || 'flutter_customer',
        appVersion: (req.headers['x-app-version'] as string) || '1.0.0',
      };

      const sections = await recommendationService.getHomeSections(context);

      res.json({
        success: true,
        data: {
          sections,
          cursor: null,
        },
      });
    } catch (err: any) {
      console.error('[RecommendationController] getHomeRecommendations error:', err);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve recommendations',
        error: err.message,
      });
    }
  }

  /**
   * GET /products/:id/recommendations
   */
  async getProductRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
      if (!id || id === 'undefined') {
        res.status(400).json({ success: false, message: 'Product ID required' });
        return;
      }

      const recommendations = await recommendationService.getProductRecommendations(id);
      res.json({
        success: true,
        data: recommendations,
      });
    } catch (err: any) {
      console.error('[RecommendationController] getProductRecommendations error:', err);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve product recommendations',
        error: err.message,
      });
    }
  }

  /**
   * GET /users/me/recommendations
   */
  async getUserRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const sessionId = (req.headers['x-session-id'] as string) || 'authenticated_session';
      const context: RecommendationContext = {
        userId,
        sessionId,
      };

      const recommendations = await recommendationService.getUserRecommendations(userId, context);
      res.json({
        success: true,
        data: recommendations,
      });
    } catch (err: any) {
      console.error('[RecommendationController] getUserRecommendations error:', err);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve personalized recommendations',
        error: err.message,
      });
    }
  }

  /**
   * POST /recommendations/events
   * Accepts batched events from Flutter or web.
   */
  async trackEvents(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body;
      const clientIp = req.ip || req.socket.remoteAddress;

      let events: EventIngestionDto[] = [];
      if (Array.isArray(body)) {
        events = body;
      } else if (body && Array.isArray(body.events)) {
        events = body.events;
      } else if (body && body.eventType) {
        events = [body];
      }

      const userId = (req as any).user?.id;
      if (userId) {
        events.forEach((e) => {
          if (!e.userId) e.userId = userId;
        });
      }

      const result = await eventCollectorService.ingestBatch(events, clientIp);
      res.status(202).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error('[RecommendationController] trackEvents error:', err);
      res.status(500).json({
        success: false,
        message: 'Failed to ingest recommendation events',
        error: err.message,
      });
    }
  }
}

export const recommendationController = new RecommendationController();
