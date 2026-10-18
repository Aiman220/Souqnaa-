import { config } from './config';
import http from 'http';
import { createApp } from './app';
import { SocketService } from './services/websocket/socket.service';
import { WishlistAlertsJob } from './services/jobs/wishlist-alerts.job';
import { FlashSaleScheduler } from './services/jobs/flash-sale.job';
import { FollowScheduler } from './services/jobs/follow-counter.job';
import { CampaignBannerScheduler } from './services/jobs/campaign-banner.job';
import { RecommendationJobs } from './modules/recommendations/jobs/recommendation.jobs';
import { RewardsScheduler } from './services/jobs/rewards.job';
import { NotificationScheduler } from './modules/notifications/services/notification-scheduler';
import { CartAbandonmentJob } from './services/jobs/cart-abandonment.job';
import { prisma } from './database/prisma';
import { redis } from './database/redis';

const startServer = async () => {
  try {
    const app = createApp();
    const server = http.createServer(app);

    // Initialize Realtime WebSocket (Socket.io)
    SocketService.init(server);

    // Initialize Centralized SOUQNAA Notification Platform Scheduler (§53, §65)
    NotificationScheduler.get().start(30 * 1000);

    // Initialize Wishlist Background Alert Monitor
    WishlistAlertsJob.start(15);

    // Initialize Flash Sale Lifecycle & Reservation Monitor (Phase 40)
    FlashSaleScheduler.start(30 * 1000);

    // Initialize Two-Way Follow Notification & Counter Drift Scheduler
    FollowScheduler.start();

    // Initialize Promotional Campaign & Banner Engine (placements seeding & sync)
    await CampaignBannerScheduler.init();
    CampaignBannerScheduler.start(60 * 1000);

    // Initialize Recommendation Engine Scheduler & Workers (§20, §96)
    RecommendationJobs.initJobs();

    // Initialize SOUQNAA Coins & Rewards Expiration & Reconciliation Scheduler (§84, §85)
    RewardsScheduler.start(60 * 60 * 1000); // Hourly expiration & daily warning cycle

    // Initialize SOUQNA Cart Abandonment Reminder Engine
    CartAbandonmentJob.start(5);

    server.listen(config.port, () => {
      console.log(`
🚀 سوقناا Backend API is running!
---------------------------------------------
🌍 Environment : ${config.env}
🔌 Port        : ${config.port}
🔗 API Base    : http://localhost:${config.port}${config.apiPrefix}
📡 WebSocket   : ws://localhost:${config.port}
🩺 Health Check: http://localhost:${config.port}/health
🚦 Readiness   : http://localhost:${config.port}/ready
🌐 Cloudflare  : ${config.cloudflare.enabled ? 'Active/Proxied' : 'Direct'}
---------------------------------------------
      `);
    });

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      NotificationScheduler.get().stop();
      WishlistAlertsJob.stop();
      FlashSaleScheduler.stop();
      FollowScheduler.stop();
      CampaignBannerScheduler.stop();
      RewardsScheduler.stop();
      CartAbandonmentJob.stop();
      server.close(async () => {
        await redis.disconnect();
        await prisma.$disconnect();
        console.log('Database and Redis disconnected. Process terminated.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// سوقناا — Promotional Engine & Mega Campaigns active
startServer();
