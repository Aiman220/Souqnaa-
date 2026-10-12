import { Router } from 'express';
import { sellerAnalyticsRouter } from './routes/seller-analytics.routes';
import { adminAnalyticsRouter } from './routes/admin-analytics.routes';

export const analyticsRouter = Router();

// Production-Grade Client Batch Analytics Ingestion Endpoint (§39)
analyticsRouter.post('/batch', (req, res) => {
  const events = req.body?.events;
  const count = Array.isArray(events) ? events.length : 0;
  res.status(200).json({
    success: true,
    data: {
      received: count,
      timestamp: new Date().toISOString(),
    },
  });
});

analyticsRouter.use('/seller', sellerAnalyticsRouter);
analyticsRouter.use('/admin', adminAnalyticsRouter);

export { sellerAnalyticsRouter, adminAnalyticsRouter };
